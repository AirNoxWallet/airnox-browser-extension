// The isolated-world content script. Two jobs:
//   1. be the ORIGIN ORACLE — stamp window.location.origin (which the page
//      cannot forge) onto every request before it reaches the SW;
//   2. relay page <-> background SW over a RECONNECTABLE runtime port (the page
//      speaks window.postMessage; the SW speaks the port). The port is opened
//      only when the page first reaches for a provider, and rebuilt after an MV3
//      service-worker eviction so an already-loaded page keeps working (see
//      PortRelay).
//
// The main-world providers (EIP-1193, Wallet Standard for Solana + Sui, TON
// Connect, TRON) are not injected from here: the manifest runs the inpage entry
// as its own content script in the page's MAIN world at document_start, so they
// exist before any page script runs, and no extension URL is ever exposed to the
// page.

import browser from 'webextension-polyfill';
import {
  CONTENT_TO_PAGE,
  ContentToPage,
  FORGET_ACCOUNTS_MESSAGE,
  HolderProbe,
  NO_ACCOUNTS_EVENTS,
  PAGE_HOLDERS_MESSAGE,
  PageHoldersReply,
  PortFrame,
} from '../protocol/bridge';
import { ErrorCode } from '../protocol/envelope';
import { HoldersProbe } from './holders_probe';
import { parsePageRequest } from './page_request';
import { PortLike, PortRelay } from './port_relay';

const origin = window.location.origin;

function postToPage(msg: ContentToPage | HolderProbe): void {
  window.postMessage(msg, window.location.origin);
}

// SW → page: a port result / pushed event becomes a CONTENT_TO_PAGE postMessage.
function handleFrame(frame: PortFrame): void {
  if (frame.kind === 'rpc-result') {
    postToPage({
      channel: CONTENT_TO_PAGE,
      id: frame.id,
      ok: frame.ok,
      result: frame.result,
      error: frame.error,
    });
  } else if (frame.kind === 'event') {
    postToPage({
      channel: CONTENT_TO_PAGE,
      ns: frame.ns,
      chain: frame.chain,
      event: frame.event,
      data: frame.data,
    });
  }
}

const relay = new PortRelay(
  // `chrome.runtime.Port` is a structural superset of PortLike (its onMessage
  // callback also gets a `port` arg, which handleFrame ignores).
  () => browser.runtime.connect({ name: 'airnox' }) as unknown as PortLike,
  handleFrame,
  // On disconnect (SW evicted / desktop transport gone), tell the page so the
  // provider rejects every in-flight request instead of leaving them pending.
  () => postToPage({ channel: CONTENT_TO_PAGE, disconnect: true }),
  () => ({ kind: 'hello', origin })
);

// SW → page, NOT over the port: the desktop restarted, so every account this page
// cached is forgotten. It comes as a runtime message to the tab
// because this page's port may have died with an evicted worker. Each event is the
// push its provider already handles as "the desktop holds no accounts for you".
//
// Popup -> this tab: who holds the page's provider globals (see HolderReport in
// the bridge)? Only the main world can see that, so the page is probed and its
// answer, or nothing after a short wait, goes back to the popup. No port is
// opened for it: the popup asks the tab, not the worker.
const holdersProbe = new HoldersProbe(
  () => postToPage({ channel: CONTENT_TO_PAGE, probe: 'holders' }),
  {
    set: (cb, ms) => window.setTimeout(cb, ms),
    clear: (handle) => window.clearTimeout(handle as number),
  }
);

browser.runtime.onMessage.addListener((msg: unknown) => {
  const type = (msg as { type?: unknown } | undefined)?.type;
  if (type === PAGE_HOLDERS_MESSAGE) {
    return holdersProbe
      .ask()
      .then((holders): PageHoldersReply => (holders ? { holders } : {}));
  }
  if (type !== FORGET_ACCOUNTS_MESSAGE) {
    return undefined;
  }
  for (const frame of NO_ACCOUNTS_EVENTS) {
    handleFrame(frame);
  }
  return undefined;
});

// No port at load: a page that never reaches for a provider never wakes the
// worker. The first touch or request connects (the hello rides first on the new
// port), and desktop pushes only ever concern a page that has done one of those.

// page → SW: a PAGE_TO_CONTENT postMessage, origin-stamped, becomes a port frame.
window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) {
    return;
  }
  const parsed = parsePageRequest(event.data);
  if (parsed.kind === 'ignore') {
    return;
  }
  // The page reached for a provider: tell the SW so it can light THIS tab's
  // toolbar badge. Fire-and-forget — there is no id to answer and nothing to
  // fail; a dead port simply means the badge waits for the next frame.
  if (parsed.kind === 'touch') {
    relay.send({ kind: 'touch', origin });
    return;
  }
  if (parsed.kind === 'holders') {
    holdersProbe.deliver(parsed.report);
    return;
  }
  // A page frame in a namespace it may not address (`sys` or unknown) is refused
  // here, before the SW — so a page cannot use the wallet as a status oracle.
  if (parsed.kind === 'reject') {
    postToPage({
      channel: CONTENT_TO_PAGE,
      id: parsed.id,
      ok: false,
      error: { code: parsed.code, message: parsed.message },
    });
    return;
  }
  const req = parsed.req;
  const sent = relay.send({
    kind: 'rpc',
    id: req.id,
    ns: req.ns,
    origin, // stamped here — never trusted from the page
    method: req.method,
    params: req.params,
    chain: req.chain,
  });
  if (!sent) {
    // Extension context invalidated (extension reloaded / updated) — fail the
    // request fast so the dApp's promise settles instead of hanging in a dead
    // port. A fresh page load re-injects a live content script.
    postToPage({
      channel: CONTENT_TO_PAGE,
      id: req.id,
      ok: false,
      error: {
        code: ErrorCode.Disconnected,
        message: 'wallet extension disconnected',
      },
    });
  }
});
