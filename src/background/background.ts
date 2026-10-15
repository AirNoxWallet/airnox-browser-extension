// The MV3 service worker — the sole owner of the desktop WebSocket transport.
// This module is the BROWSER GLUE: it owns the WsClient singleton, the iid cache,
// the badge heartbeat, the per-tab web3 indicator and the popup status reply, and
// wires the runtime listeners onto a BackgroundRouter, which holds the pure
// routing/decision core (the per-origin port registry, the version fail-fast
// gate, and the RPC round-trip) — see background_router.ts, which is unit-tested.
//
// The SW may be evicted between requests (the WsClient reconnects lazily on the
// next send); the singletons below are re-created on a fresh SW start.

import browser, { type Runtime } from 'webextension-polyfill';
import { v4 as uuidv4 } from 'uuid';
import {
  ProtocolVersion,
  VersionVerdict,
  WalletStatus,
  checkVersion,
} from '../protocol/envelope';
import {
  FORGET_ACCOUNTS_MESSAGE,
  PAIRED_MESSAGE,
  PAIRING_WINDOW,
  PAIR_RELAY_MESSAGE,
  PortFrame,
  SETTINGS_CHANGED_MESSAGE,
  StatusReply,
  STATUS_MESSAGE,
  pairingPagePath,
} from '../protocol/bridge';
import { BackgroundRouter } from './background_router';
import { relayPairFrame } from './pair_relay';
import { isExtensionPageSender } from './sender_policy';
import { DesktopSessionWatch } from './desktop_session';
import { BadgeFace, badgeFace, sameFace } from './badge_state';
import { Web3Tabs } from './web3_tabs';
import { PairingPromptGate, readPromptRecord } from './pairing_prompt';
import {
  PING_PERIOD_MIN_MINUTES,
  nextPingPeriodMinutes,
} from '../transport/heartbeat_schedule';
import { loadAuthKey } from '../transport/auth_key_store';
import { getInstanceId } from '../transport/iid';
import { candidatePorts, getTransportSettings } from '../transport/settings';
import { singleFlight } from '../transport/single_flight';
import { ResumeStore, SocketAuth, WsClient } from '../transport/ws_client';
import { clearDefault, clearTab, markedTabs, paintTab } from './badge';

const PING_ALARM = 'airnox-ping';

let client: WsClient | null = null;

// The latest heartbeat connection state, so the popup can read it without driving
// its own transport. The compatibility verdict lives in the router (its version
// fail-fast gate reads it) and reaches the popup via router.compatibilityVerdict;
// `incompatible` is kept here too because the badge is painted from this state.
let lastStatus: {
  connected: boolean;
  status?: WalletStatus;
  incompatible: boolean;
} = { connected: false, incompatible: false };

// Has a heartbeat run since this worker started? The struct above reads
// "offline" before the first one, which is indistinguishable from a genuinely
// absent desktop — so a tab must not be painted from it until a ping has spoken.
let statusKnown = false;

// The tabs whose page reached for web3, and the face last painted on them in
// THIS worker's life. `paintedFace` is null on a fresh start, which forces one
// repaint: the desktop may have come or gone while the worker was evicted.
const web3Tabs = new Web3Tabs();
let paintedFace: BadgeFace | null = null;

// getInstanceId is already single-flight and caches its resolved value, so this
// is a direct alias rather than a second cache. It must NOT be re-wrapped in a
// check-then-await cache: that is exactly the race that let the socket and the
// frames carry different ids (see single_flight.ts).
const getIid = getInstanceId;

async function createClient(): Promise<WsClient> {
  const settings = await getTransportSettings();
  const created = new WsClient(
    await getIid(),
    candidatePorts(settings),
    recordStatus,
    (ev) => router.routeEvent(ev),
    resumeStore,
    socketAuth
  );
  // Kept for the popup's synchronous currentPort read; creation goes through
  // the single-flight below, never through this variable.
  client = created;
  return created;
}

// Single-flight, for the same reason as the iid: the previous check-then-await
// cache let two concurrent callers (the cold-start heartbeat, the popup's status
// read and the first dApp request all land together) each build a WsClient, so
// the extension opened TWO sockets to the desktop and orphaned one of them.
const clientFlight = singleFlight(createClient);
const getClient = clientFlight.get;

// The routing/decision core: it owns the port registry + the version verdict and
// answers page RPCs; the listeners below are thin wiring onto it. The transport
// send, the iid accessor and the rid factory are injected so the router stays
// free of browser.* and is unit-tested.
const router = new BackgroundRouter({
  send: async (wire) => (await getClient()).send(wire),
  iid: getIid,
  newRid: uuidv4,
});

function recordStatus(
  connected: boolean,
  status?: WalletStatus,
  desktopVersion?: ProtocolVersion,
  desktopSession?: string
): void {
  const verdict: VersionVerdict | undefined =
    connected && desktopVersion ? checkVersion(desktopVersion) : undefined;
  lastStatus = {
    connected,
    status,
    incompatible: verdict ? !verdict.compatible : false,
  };
  statusKnown = true;
  router.setVerdict(verdict);
  void repaintWeb3Tabs();
  if (connected) {
    void observeDesktopSession(desktopSession);
  }
}

// ── a desktop that restarted ─────────────────────────────────────────────────
// Every sys_ping — the heartbeat, and the handshake each new socket sends — names
// the desktop session. A new one means the desktop restarted, and a restarted
// desktop holds no grant for a device wallet's account a page cached, so every
// web3 tab is told to forget its accounts. The last session is kept in
// storage.session: it must outlive a worker eviction (or a restarted worker would
// take the same desktop for a new one) but not the browser.
const DESKTOP_SESSION_KEY = 'airnox.desktopSession';

const desktopSessionWatch = new DesktopSessionWatch(
  async () => {
    const got = await browser.storage.session.get(DESKTOP_SESSION_KEY);
    const value: unknown = got[DESKTOP_SESSION_KEY];
    return typeof value === 'string' ? value : undefined;
  },
  async (session) => {
    await browser.storage.session.set({ [DESKTOP_SESSION_KEY]: session });
  }
);

async function observeDesktopSession(
  session: string | undefined
): Promise<void> {
  if (!(await desktopSessionWatch.observe(session))) {
    return;
  }
  await forgetAccountsInEveryTab();
}

// ── the desktop's held sessions ──────────────────────────────────────────────
// The resume secret each new socket presents (see ResumeStore in ws_client.ts).
// storage.session, like the desktop session: it must outlive a worker eviction,
// which is exactly when the desktop holds the sessions for it.
const RESUME_KEY = 'airnox.resume';

const resumeStore: ResumeStore = {
  load: async () => {
    const got = await browser.storage.session.get(RESUME_KEY);
    const value: unknown = got[RESUME_KEY];
    return typeof value === 'string' ? value : undefined;
  },
  save: async (secret) => {
    await browser.storage.session.set({ [RESUME_KEY]: secret });
  },
  lost: () => void forgetAccountsInEveryTab(),
};

// ── the socket handshake ─────────────────────────────────────────────────────
// The pairing key lives in IndexedDB as a non-extractable CryptoKey
// (auth_key_store.ts); the worker only reads it, to authenticate each socket.
// When a dApp's connect finds no pairing the desktop accepts, the pairing page
// may open in its own small window, naming the dApp: at most once per origin
// per cooldown (pairing_prompt.ts), and one window at a time: a connect from
// another origin focuses the open one instead of stacking another. The page
// asks the desktop for a code only when the person presses Pair in it.
let pairingWindowId: number | undefined;
// A pairing completed since the window opened: its close is not a decline.
let pairingWindowPaired = false;

const PAIRING_PROMPTS_KEY = 'airnox.pairingPrompts';

const promptGate = new PairingPromptGate({
  load: async () =>
    readPromptRecord(
      (await browser.storage.session.get(PAIRING_PROMPTS_KEY))[
        PAIRING_PROMPTS_KEY
      ]
    ),
  save: async (record) => {
    await browser.storage.session.set({ [PAIRING_PROMPTS_KEY]: record });
  },
});

const pairingWindowFlight = singleFlight(async (): Promise<void> => {
  if (pairingWindowId !== undefined) {
    const open = await browser.windows
      .update(pairingWindowId, { focused: true })
      .then(() => true)
      .catch(() => false);
    if (open) {
      return;
    }
    pairingWindowId = undefined;
  }
  const created = await browser.windows.create({
    url: browser.runtime.getURL(pairingPagePath(pairingOrigin)),
    ...PAIRING_WINDOW,
  });
  pairingWindowId = created.id;
  pairingWindowOrigin = pairingOrigin;
  pairingWindowPaired = false;
});
let pairingOrigin: string | undefined;
// The dApp the open window names.
let pairingWindowOrigin: string | undefined;

const socketAuth: SocketAuth = {
  loadKey: loadAuthKey,
  pairingNeeded: (origin) => {
    void promptGate.admit(origin).then((admitted) => {
      if (!admitted) {
        return;
      }
      pairingOrigin = origin;
      return pairingWindowFlight
        .get()
        .catch(() => undefined)
        .finally(() => pairingWindowFlight.reset());
    });
  },
};

browser.windows.onRemoved.addListener((windowId) => {
  if (windowId === pairingWindowId) {
    pairingWindowId = undefined;
    if (!pairingWindowPaired && pairingWindowOrigin !== undefined) {
      // Closed without a pairing: the dApp's next connect opens nothing for a
      // cooldown from now.
      void promptGate.declined(pairingWindowOrigin);
    }
    pairingWindowOrigin = undefined;
    // Closed without a pairing (a completed one already told the client).
    client?.pairingEnded();
  }
});

async function forgetAccountsInEveryTab(): Promise<void> {
  // Every web3 tab this worker knows, a previous worker's included (adopted off
  // their badges): an idle page's port died with that worker, so the message goes
  // to the tab. A tab without our content script rejects it — nothing to forget.
  await adoptFlight.get();
  await Promise.all(
    web3Tabs
      .all()
      .map((tabId) =>
        browser.tabs
          .sendMessage(tabId, { type: FORGET_ACCOUNTS_MESSAGE })
          .catch(() => undefined)
      )
  );
}

// ── the per-tab web3 indicator ───────────────────────────────────────────────
// The wallet shows state only where a page asked for it: a tab that never
// touched a provider carries no badge at all, so the toolbar looks inactive
// while the user is just browsing. web3_tabs.ts holds which tabs those are,
// badge_state.ts what they show, badge.ts how it is painted.

const currentFace = (): BadgeFace =>
  badgeFace(lastStatus.connected, lastStatus.status, lastStatus.incompatible);

// Take back the tabs a previous worker marked. Single-flighted and run once per
// worker, for the same reason as the iid: several listeners can want the set in
// the same tick, and this one enumerates every open tab. The default badge is
// blanked FIRST — getBadgeText falls back to it, so a non-empty default would
// read back as "every tab is a web3 tab" (see badge.ts).
const adoptFlight = singleFlight(async () => {
  await clearDefault();
  web3Tabs.adopt(await markedTabs());
});

// Repaint every web3 tab after a status change. A no-op when the face has not
// moved, so the once-a-minute heartbeat does not repaint the toolbar for nothing.
async function repaintWeb3Tabs(): Promise<void> {
  const face = currentFace();
  if (paintedFace && sameFace(paintedFace, face)) {
    return;
  }
  await adoptFlight.get();
  paintedFace = face;
  await Promise.all(web3Tabs.all().map((tabId) => paintTab(tabId, face)));
}

// This tab's page reached for web3 (a provider touch, or a real request).
async function markWeb3Tab(tabId: number | undefined): Promise<void> {
  if (tabId === undefined) {
    return; // not a tab — an extension page or another worker; nothing to paint
  }
  const fresh = web3Tabs.mark(tabId);
  if (!statusKnown) {
    // A worker that has just woken does not know whether the desktop is up, and
    // painting this tab grey before asking would be a lie. The heartbeat's
    // recordStatus repaints every marked tab, this one included.
    await heartbeat(true);
    return;
  }
  if (fresh) {
    await paintTab(tabId, currentFace());
  }
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== 'airnox') {
    return;
  }
  // The port's origin is the one the browser attests for its sender, and only a
  // content script in a tab's top frame gets one (see sender_policy.ts). Any
  // other port is closed: a content script's relay reconnects on its next send,
  // so a document that becomes a tab's top frame later is served then.
  if (!router.openPort(port, port.sender)) {
    port.disconnect();
    return;
  }
  port.onMessage.addListener((message: unknown) => {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const frame = message as PortFrame;
    if (frame.kind === 'rpc') {
      // A request is the loudest possible "this tab wants web3".
      void markWeb3Tab(port.sender?.tab?.id);
      void router.handleRpc(port, frame);
    } else if (frame.kind === 'touch') {
      // The page only reached for a provider — it asked for nothing, so there is
      // nothing to answer; it just makes this tab a web3 tab.
      void markWeb3Tab(port.sender?.tab?.id);
    } else if (frame.kind === 'hello') {
      // The content script names the origin it stamped; the port is bound to
      // it, and receives that origin's pushes, only if it is the origin the
      // browser attested. A renderer that names another is not served at all.
      if (!router.handleHello(port, frame)) {
        router.dropPort(port);
        port.disconnect();
      }
    }
  });
  port.onDisconnect.addListener(() => {
    router.dropPort(port);
  });
});

// A fresh document has asked for nothing yet, so the tab goes back to looking
// inactive until it touches a provider. Unconditional: after an eviction this
// worker's set is empty while the browser still shows the previous document's
// badge, and that badge is exactly what a later worker would read back.
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    web3Tabs.forget(tabId);
    void clearTab(tabId);
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  web3Tabs.forget(tabId);
});

// ── badge heartbeat ──────────────────────────────────────────────────────────
// `userInitiated` marks a ping the user asked for (the popup opening, Retry, a
// settings change) rather than the alarm's own tick: it re-arms the fast cadence
// even on a failure, because the person poking at the popup is the one about to
// start the desktop.
async function heartbeat(userInitiated = false): Promise<void> {
  try {
    const c = await getClient();
    await c.ping();
  } catch {
    recordStatus(false);
  }
  await rearmHeartbeat(lastStatus.connected || userInitiated);
}

// Re-arm the ping alarm for the next tick — fast while the desktop answers,
// backing off while it does not (transport/heartbeat_schedule.ts holds the WHY).
// Creating an alarm restarts its clock, so an unchanged period is left alone.
async function rearmHeartbeat(connected: boolean): Promise<void> {
  const alarm = await browser.alarms.get(PING_ALARM);
  const next = nextPingPeriodMinutes(alarm?.periodInMinutes, connected);
  if (alarm?.periodInMinutes === next) {
    return;
  }
  await browser.alarms.create(PING_ALARM, { periodInMinutes: next });
}

// The popup asks for the current connection state (a fresh sys_ping) when it
// opens and on Retry. It receives ONLY {connected, status, iid, port, version} —
// never any wallet/account/asset data, which is desktop-only. The pairing page
// relays its two pairing frames the same way. All three messages are the
// extension pages' alone: the status reply carries the pairing handle, the relay
// reaches the desktop socket, and a content script (whose sender URL is its
// page's) gets no answer to any of them.
browser.runtime.onMessage.addListener(
  (msg: unknown, sender: Runtime.MessageSender) => {
    const type = (msg as { type?: string } | undefined)?.type;
    if (
      type !== SETTINGS_CHANGED_MESSAGE &&
      type !== STATUS_MESSAGE &&
      type !== PAIR_RELAY_MESSAGE &&
      type !== PAIRED_MESSAGE
    ) {
      return undefined; // not ours — let other listeners (if any) handle it
    }
    if (!isExtensionPageSender(sender, browser.runtime.getURL(''))) {
      return undefined;
    }
    if (type === PAIR_RELAY_MESSAGE) {
      // The pairing page's two frames (pair_relay.ts): carried over the socket
      // this worker owns, answered with the iid and the port they went out on.
      return relayPairFrame(
        {
          exchange: async (wire) => (await getClient()).exchange(wire),
          iid: getIid,
          newRid: uuidv4,
        },
        msg
      );
    }
    if (type === PAIRED_MESSAGE) {
      // The pairing page stored a new key: the socket authenticates with it,
      // and every dApp's connect may open the pairing window again should the
      // desktop drop this pairing.
      pairingWindowPaired = true;
      void promptGate.cleared();
      client?.afterPairing();
      return heartbeat(true);
    }
    if (type === SETTINGS_CHANGED_MESSAGE) {
      // The transport mode / port changed in the popup — drop the cached client so
      // the next request rebuilds it from the new settings, then re-ping so the
      // badge + the popup's follow-up status read reflect the new endpoint. BOTH
      // handles must be cleared: the single-flight is what getClient() reads, and
      // `client` is the synchronous handle the status reply reports the port from.
      clientFlight.reset();
      client = null;
      return heartbeat(true);
    }
    return (async (): Promise<StatusReply> => {
      await heartbeat(true);
      return {
        connected: lastStatus.connected,
        status: lastStatus.status,
        iid: await getIid(),
        // The loopback port the client actually resolved / connected on (the Auto
        // discovery result, or the pinned Manual port). Gated on `connected`:
        // currentPort caches the last-resolved port ACROSS reconnects (so Auto need
        // not re-scan on every SW eviction), so it stays non-null after a drop — but
        // the popup must show "—", not a stale port, while offline.
        port: lastStatus.connected && client ? client.currentPort : null,
        // The protocol-compatibility verdict, so the popup can show an update
        // banner on a major mismatch.
        version: router.compatibilityVerdict,
      };
    })();
  }
);

function scheduleHeartbeat(): void {
  void browser.alarms.create(PING_ALARM, {
    periodInMinutes: PING_PERIOD_MIN_MINUTES,
  });
  void heartbeat();
}

browser.runtime.onInstalled.addListener(() => {
  console.info('[airnox] extension installed');
  scheduleHeartbeat();
});
browser.runtime.onStartup.addListener(scheduleHeartbeat);
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PING_ALARM) {
    void heartbeat();
  }
});
