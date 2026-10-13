// The end-to-end guard — the things the unit suites cannot prove: that the REAL
// MV3 extension, loaded into a REAL Chromium with its REAL manifest, injects all
// five provider surfaces, opens the loopback WebSocket to the desktop, and
// carries every ecosystem's connect / sign / broadcast round-trip over the
// versioned wire.
//
//   real dist-chrome extension  ──ws──▶  desktop_stub (v2 protocol, port 8114)
//        (content + SW + inpage)          ▲
//   mock dApp page (http) ── window.ethereum / wallet-standard / tonconnect / tronWeb
//
// Eleven scenarios, each a fresh extension against a stub configured for it.
// Every socket must authenticate (protocol major 3), so each scenario but the
// incompatible ones and PAIRED first pairs the browser by code on the pairing
// page, as a person does on a first run.
//   1. COMPATIBLE      (desktop 2.3.1, the current wire) → the dApp connects and
//      gets the account. Exercises the full AUTO-discovery probe
//      (placeholder-iid sys_ping → version-object verify → real-iid connect).
//   2. INCOMPATIBLE    (desktop 2.99.0) → the request is refused end-to-end with
//      VersionIncompatible (1103). Two layers can refuse — the extension-local
//      fail-fast (once the heartbeat verdict lands) and the stub's
//      dispatcher-mirror gate on the wire; which fires first is heartbeat
//      timing, and the assertion accepts either (the gate is proven closed,
//      not which layer closed it).
//  2b. INCOMPATIBLE-OLDER-DESKTOP (desktop 2.2.1, before mandatory
//      authentication) → 1103, and no pairing page opens for a pairing that
//      desktop would refuse.
//   3. APPROVED        → EVM, Solana, Sui, TON Connect and TRON each complete
//      connect + sign + broadcast, every reply is compared against the stub's
//      fixture, and the frames the stub received are asserted: the content
//      script's unforgeable `origin`, the canonical mhda chain key per
//      ecosystem, Solana vs Sui told apart by `chain` alone on the shared `wstd`
//      namespace, and a forged `sys` frame refused before it can reach the wire.
//   4. CONNECT-REJECTED → the wallet refuses every connect (4001); each surface
//      reports it in ITS OWN dialect (an EIP-1193 rejection, a Wallet-Standard
//      throw, a TON Connect connect_error with the mapped code 300).
//   5. TX-REJECTED     → connect is approved but every confirmation is refused;
//      the same per-surface dialects, on the signing and broadcast paths.
//   6. BADGE           → the toolbar indicator is PER TAB and tells the truth:
//      the dApp tab wears the connected dot, a page served from the same origin
//      that never touches a provider stays blank, and navigating the dApp tab
//      away clears it. Only a real browser has per-tab action state, so this is
//      exactly the kind of thing the unit suites cannot prove.
//   7. RESTART         → a connected dApp is told it has no accounts when the
//      desktop restarts: a heartbeat that
//      reaches the SAME desktop session forgets nothing, and one that reaches a
//      NEW session (a second stub on the port) delivers accountsChanged([]) to
//      the idle page, whose eth_accounts then answers []. Only a real browser can
//      prove the worker reaches the tab without its port.
//   8. PUSH-CHAIN      → a desktop accountsChanged push reaches the page with its
//      `chain`, and EVM (on mainnet, then after a switch to 0x89) and TRON
//      (mainnet) hear only the pushes about the chain they are on: one about
//      Sepolia, the chain left behind or Shasta leaves the accounts alone.
//   9. HELD            → the desktop holds an instance's sessions across a socket
//      close: every socket's FIRST frame is
//      sys_resume, a socket after a close presents the secret the last one was
//      handed and the page keeps its accounts, and a resume the desktop does not
//      restore (it forgot the binding: a lock) makes the page forget them.
//  10. PAIRED          → pairing by code and the socket handshake: a browser
//      with no pairing key is refused (1002); a sign or a polled read opens
//      nothing, the dApp's connect opens one pairing page naming the dApp, and
//      the page asks the desktop for nothing until the person presses Pair;
//      the page pairs it on the socket the worker holds, with the code the
//      desktop shows, and that socket authenticates; every socket
//      authenticates (begin, finish) before its sys_resume and any dApp frame;
//      a desktop that reset the pairing makes the dApp's next connect open the
//      pairing page naming it, and its requests are refused until the person
//      pairs again; a page the person closed unpaired holds back the dApp's
//      next connects; a program that answers the handshake without the secret
//      never receives the extension's proof, nothing binds, and the key is not
//      offered again until the person resets it in the desktop's Settings and
//      pairs again; a locked wallet (a lock closes every socket) refuses the
//      socket's own handshake and lets the dApp's through once unlocked, also
//      when a heartbeat sys_ping went out on the socket in between (a ping
//      binds nothing).
//
// Empirically the `ws://127.0.0.1/*` host_permission IS required — Chrome gates
// the SW WebSocket on it; removing it fails scenario 1 with a 4900
// transport-disconnect (proven, not assumed). The stub mirrors the desktop's
// current protocol and its per-ns result shapes; see its header for what it does
// NOT model.
//
// Exit 0 = every scenario behaved as expected. Exit 1 = a regression.
// Exit 2 = the harness itself failed (a browser that never started, a port it
// could not bind, a flow that never settled).
//
// Run: npm run e2e   (builds dist-chrome, then runs this against the stub)

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startDesktopStub } from './desktop_stub.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = join(here, '..', 'dist', 'dist-chrome');
// The extension's WsClient hardcodes DEFAULT_WS_PORT = 8114, so the stub MUST
// bind that exact port for the SW to reach it.
const DESKTOP_PORT = 8114;
// No page flow should take anywhere near this; it exists so a provider promise
// that never settles fails the run instead of hanging CI forever.
const FLOW_TIMEOUT_MS = 30_000;

// The canonical mhda 1.1 chain keys each provider must stamp — mirrored from
// src/protocol/chains.ts. Asserting them here is what proves the key the dApp's
// request rides on is the desktop's own grammar, end to end.
const CHAIN = {
  evm: 'nt:evm:ci:1',
  // What the EIP-3326 switch in __evmFlow moves to (chainId 0x89).
  evmSwitched: 'nt:evm:ci:137',
  solana: 'nt:solana:ci:mainnet',
  sui: 'nt:sui:ci:mainnet',
  ton: 'nt:ton:ci:mainnet',
  tron: 'nt:tron:ci:mainnet',
};

// The push-chain scenario's other chains and accounts: chains the providers are
// NOT on, and accounts distinct from the stub's grants so a push that applied is
// visible in the dApp's record.
const PUSH = {
  evmOther: 'nt:evm:ci:11155111',
  tronOther: 'nt:tron:ci:shasta',
  evmAccount: '0x000000000000000000000000000000000000bEEF',
  // The base58check form of TRON's zero address (41 + twenty zero bytes).
  tronAccount: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
};

// The four EVM reads the provider answers from cache. They must never appear on
// the wire: eth_accounts in particular would raise a desktop prompt on what is
// only permission state.
const CACHED_EVM_READS = [
  'eth_chainId',
  'net_version',
  'eth_accounts',
  'eth_coinbase',
];

// The methods that raise a desktop confirmation, split by what the user is being
// asked to approve. The rejection scenarios refuse one group each.
const CONNECT_METHODS = [
  'eth_requestAccounts',
  'standard:connect',
  'tonConnect_connect',
  'tron_requestAccounts',
];
// tron_sendRawTransaction is deliberately ABSENT: the desktop's TRON broadcast
// has no confirmation sink at all (the signature it submits was confirmed by the prior
// tron_signTransaction), so a 4001 there is a reply the real desktop cannot
// produce. Refusing it would test the stub, not the extension.
const CONFIRM_METHODS = [
  'personal_sign',
  'eth_sendTransaction',
  'solana:signMessage',
  'solana:signTransaction',
  'solana:signAndSendTransaction',
  'sui:signPersonalMessage',
  'sui:signTransaction',
  'sui:signAndExecuteTransaction',
  'tonConnect_sendTransaction',
  'tonConnect_signData',
  'tron_signMessageV2',
  'tron_signTransaction',
];

// Resolve the FULL chromium build Playwright downloaded (chrome-linux64/chrome),
// NOT the headless-shell — only the full build loads MV3 extensions (with the
// new headless mode). Pick the highest chromium-<rev> NUMERICALLY: a lexical
// sort puts chromium-987 after chromium-1148 and would silently run an older
// browser, which is the same stale-build class of bug the fresh profile below
// exists to prevent.
function fullChromiumPath() {
  const cache = join(process.env.HOME ?? '', '.cache', 'ms-playwright');
  if (!process.env.HOME || !existsSync(cache)) {
    throw new Error(`no playwright browser cache at ${cache}`);
  }
  const revisions = readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .map((d) => ({ dir: d, rev: Number(d.slice('chromium-'.length)) }))
    .sort((a, b) => a.rev - b.rev);
  if (revisions.length === 0) {
    throw new Error('no full chromium build found under ms-playwright cache');
  }
  const binary = join(
    cache,
    revisions[revisions.length - 1].dir,
    'chrome-linux64',
    'chrome'
  );
  if (!existsSync(binary)) {
    throw new Error(
      `chromium revision found but its binary is missing: ${binary}`
    );
  }
  return binary;
}

// `/plain` is a page with NO wallet code at all — same origin, same content
// script, same injected providers, and it touches none of them. It is the
// control case for the per-tab badge: everything the extension does on its own
// (inject, connect its port, say hello) must leave the toolbar blank.
const PLAIN_PAGE =
  '<!doctype html><meta charset="utf-8"><title>plain</title>' +
  '<p>An ordinary page. It never asks for a wallet.';

function startDappServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        if (req.url.startsWith('/plain')) {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end(PLAIN_PAGE);
          return;
        }
        const html = await readFile(join(here, 'dapp.html'));
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(html);
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((d) => server.close(() => d())),
      });
    });
  });
}

// Drive one page hook under a deadline. Playwright puts no default timeout on
// evaluate(), so a provider promise that never settles would hang the run with
// no output at all — the one failure mode a regression guard must not have.
async function drivePage(page, hook) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${hook} did not settle in ${FLOW_TIMEOUT_MS}ms`)),
      FLOW_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([
      page.evaluate((name) => window[name](), hook),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Bring up stub + dApp server + a fresh extension in a real Chromium, hand the
// page (and the browser context, for a scenario that needs a second tab or the
// service worker) to `drive`, and tear everything down. `readyHook` is the page predicate
// that must go true before driving — the EVM-only probe for the connection
// scenarios, all five surfaces for the flow scenarios.
async function withExtension(
  {
    label,
    stubVersion,
    rejectMethods = [],
    profileDir,
    readyHook,
    log,
    pair = true,
  },
  drive
) {
  // Start from a FRESH profile every run: Chromium caches the loaded
  // extension (service worker included) inside a persistent profile, so a
  // leftover profile from a previous run would exercise a STALE build against
  // the current stub — exactly the skew this harness exists to catch. (The
  // per-SCENARIO isolation of the separate dirs is kept.)
  rmSync(join(here, profileDir), { recursive: true, force: true });
  const desktop = await startDesktopStub({
    port: DESKTOP_PORT,
    version: stubVersion,
    rejectMethods,
    onLog: (m) => log(`[${label}] stub: ${m}`),
  });
  const dapp = await startDappServer();
  const origin = `http://127.0.0.1:${dapp.port}`;
  log(`[${label}] dApp page on ${origin}`);

  const context = await chromium.launchPersistentContext(
    join(here, profileDir),
    {
      executablePath: fullChromiumPath(),
      args: [
        '--headless=new',
        '--no-sandbox',
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    }
  );

  try {
    // The service worker may already have registered by the time the context
    // resolves, in which case waiting for the EVENT would burn its full timeout
    // and then be swallowed. Check first, and let a genuine failure throw with
    // its own message rather than surfacing later as an opaque readiness
    // timeout.
    if (context.serviceWorkers().length === 0) {
      await context.waitForEvent('serviceworker', { timeout: 10_000 });
    }
    // Every socket must authenticate: the person pairs this browser by code
    // first, as on a first run. The worker then authenticates its socket.
    if (pair) {
      await pairBrowser(context, desktop);
      log(`[${label}] paired`);
    }

    const page = await context.newPage();
    page.on('console', (msg) => log(`[${label}] page: ${msg.text()}`));
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((hook) => window[hook]?.() === true, readyHook, {
      timeout: 8000,
    });
    log(`[${label}] ${readyHook} satisfied`);
    return await drive(page, desktop, origin, context);
  } finally {
    await context.close();
    await dapp.close();
    await desktop.close();
  }
}

// Run one connection scenario against a stub reporting `stubVersion`. Returns the
// dApp's __connect() result.
async function connectScenario({
  label,
  stubVersion,
  profileDir,
  log,
  pair = true,
}) {
  return withExtension(
    { label, stubVersion, profileDir, readyHook: '__providerReady', log, pair },
    async (page, desktop, origin, context) => ({
      result: await drivePage(page, '__connect'),
      grantedAccount: desktop.grantedAccount,
      pairBegins: desktop.pairBegins.length,
      pairingPages: context
        .pages()
        .filter((p) => p.url().includes('/src/popup/pairing.html')).length,
    })
  );
}

// Run every ecosystem's flow in ONE browser session against one stub — five
// launches would only re-prove the extension loads. Returns the per-ecosystem
// results plus the frames the stub actually received.
async function flowScenario({
  label,
  stubVersion,
  rejectMethods,
  profileDir,
  log,
}) {
  return withExtension(
    {
      label,
      stubVersion,
      rejectMethods,
      profileDir,
      readyHook: '__walletsReady',
      log,
    },
    async (page, desktop, origin) => ({
      evm: await drivePage(page, '__evmFlow'),
      solana: await drivePage(page, '__solanaFlow'),
      sui: await drivePage(page, '__suiFlow'),
      ton: await drivePage(page, '__tonFlow'),
      tron: await drivePage(page, '__tronFlow'),
      forgedSys: await drivePage(page, '__forgeSysFrame'),
      frames: desktop.frames,
      fixtures: desktop.fixtures,
      origin,
    })
  );
}

// ── Pairing by code and the socket handshake ─────────────────────────────────
// A node-side wait: the stub's records fill from the browser's frames.
async function waitFor(cond, what, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// The person presses Pair on the pairing page, reads the code off the
// desktop's dialog and types it in. The page asks the desktop for nothing
// before that press; the stub records the code it would show.
async function pairOnPage(pairing, desktop, codesBefore) {
  await pairing.waitForSelector('#pairStart:not([hidden])', { timeout: 8000 });
  await pairing.click('#pairStart');
  await waitFor(() => desktop.shownCodes.length > codesBefore, 'a code');
  await pairing.waitForSelector('#pairForm:not([hidden])', { timeout: 8000 });
  await pairing.fill('#pairCode', desktop.shownCodes.at(-1));
  await pairing.click('#pairSubmit');
  await pairing.waitForFunction(
    () => document.getElementById('pairTitle')?.textContent?.includes('Paired'),
    null,
    { timeout: 8000 }
  );
}

// Pair a fresh browser on the extension's pairing page (the popup's Pairing row
// opens it), and wait for the socket the pairing ran on to authenticate.
async function pairBrowser(context, desktop) {
  const extensionId = new URL(context.serviceWorkers()[0].url()).host;
  const pairing = await context.newPage();
  const codesBefore = desktop.shownCodes.length;
  const handshakesBefore = desktop.authenticatedCount();
  await pairing.goto(
    `chrome-extension://${extensionId}/src/popup/pairing.html`
  );
  await pairOnPage(pairing, desktop, codesBefore);
  await pairing.close();
  await waitFor(
    () => desktop.authenticatedCount() > handshakesBefore,
    'the handshake after the pairing'
  );
}

// The instance's own sockets (the AUTO probe's placeholder iid excluded), from
// index `from` of the stub's log, each as its frame methods without the pings
// (`all`: with them).
const ownSockets = (desktop, from = 0) =>
  desktop.socketLogs
    .slice(from)
    .filter((l) => !/^0{8}-/.test(l.iid))
    .map((l) => ({
      methods: l.methods.filter((m) => m !== 'sys_ping'),
      all: [...l.methods],
      auth: l.auth,
    }));

async function pairedScenario({ label, stubVersion, profileDir, log }) {
  return withExtension(
    {
      label,
      stubVersion,
      profileDir,
      readyHook: '__providerReady',
      log,
      pair: false,
    },
    async (page, desktop, origin, context) => {
      const extensionId = new URL(context.serviceWorkers()[0].url()).host;
      const sign = () =>
        page.evaluate(async (account) => {
          try {
            return await window.ethereum.request({
              method: 'personal_sign',
              params: ['0x68656c6c6f', account],
            });
          } catch (e) {
            return { error: e.code, message: e.message };
          }
        }, desktop.grantedAccount);
      const ask = (method) =>
        page.evaluate(async (m) => {
          try {
            return await window.ethereum.request({ method: m });
          } catch (e) {
            return { error: e.code, message: e.message };
          }
        }, method);
      const connect = () => ask('eth_requestAccounts');
      const pairingPage = () =>
        context.waitForEvent('page', {
          predicate: (p) => p.url().includes('/src/popup/pairing.html'),
          timeout: 15_000,
        });
      const pairingPages = () =>
        context
          .pages()
          .filter((p) => p.url().includes('/src/popup/pairing.html')).length;

      // 1. No pairing key: a sign and a page polling a read are refused and
      // open nothing; the dApp's connect opens the pairing page naming it, a
      // second connect opens no second one, and the page asks the desktop for
      // nothing until the person presses Pair.
      const signKeyless = await sign();
      const pollKeyless = [];
      for (let i = 0; i < 4; i++) {
        pollKeyless.push(await ask('eth_blockNumber'));
      }
      await sleep(800);
      const pagesAfterPolls = pairingPages();
      const firstOpened = pairingPage();
      const connectKeyless = await connect();
      const firstPairing = await firstOpened;
      const keylessOrigin = new URL(firstPairing.url()).searchParams.get(
        'origin'
      );
      const connectAgain = await connect();
      await firstPairing.waitForSelector('#pairStart:not([hidden])', {
        timeout: 8000,
      });
      await sleep(800);
      const pagesAfterConnects = pairingPages();
      const beginsBeforePress = desktop.pairBegins.length;
      // 2. The page pairs by code on the socket the worker holds, which then
      // authenticates with the key.
      await pairOnPage(firstPairing, desktop, 0);
      const firstBegin = desktop.pairBegins[0];
      await firstPairing.close();
      await waitFor(() => desktop.authenticatedCount() >= 1, 'a handshake');
      const keylessSockets = ownSockets(desktop);
      const pairedFrom = desktop.socketLogs.length;
      const signPaired = await sign();
      const iid = desktop.socketLogs.find((l) => !/^0{8}-/.test(l.iid))?.iid;
      const pairedSockets = ownSockets(desktop);

      // 3. The desktop resets the pairing (Settings): the next socket's own
      // handshake hears 1002, the dApp's sign is refused and opens nothing,
      // and its connect opens the pairing page naming it; paired again, the
      // sign is served.
      desktop.resetPairing();
      desktop.dropSockets();
      await sleep(300);
      const resetFrom = desktop.socketLogs.length;
      const signUnpaired = await sign();
      await sleep(800);
      const pagesAfterUnpairedSign = pairingPages();
      const opened = pairingPage();
      const connectUnpaired = await connect();
      const repair = await opened;
      const repairOrigin = new URL(repair.url()).searchParams.get('origin');
      await pairOnPage(repair, desktop, 1);
      const repairBegin = desktop.pairBegins.at(-1);
      await repair.close();
      await waitFor(() => desktop.authenticatedCount() >= 2, 'a handshake');
      const signRepaired = await sign();
      const resetSockets = ownSockets(desktop, resetFrom);

      // 3b. Reset again: the connect opens the page, the person closes it
      // without pairing, and the dApp's next connects open nothing (the
      // cooldown); the person pairs from the popup's Pairing row instead.
      desktop.resetPairing();
      desktop.dropSockets();
      await sleep(300);
      const declineOpened = pairingPage();
      await connect();
      const declined = await declineOpened;
      await declined.close();
      await sleep(300);
      const connectsAfterDecline = [await connect(), await connect()];
      await sleep(800);
      const pagesAfterDecline = pairingPages();
      const codesBeforeDecline = desktop.shownCodes.length;
      const fromPopup = await context.newPage();
      await fromPopup.goto(
        `chrome-extension://${extensionId}/src/popup/pairing.html`
      );
      await pairOnPage(fromPopup, desktop, codesBeforeDecline);
      await fromPopup.close();
      const signAfterDecline = await sign();

      // 4. Something that answers the handshake without the secret: the key
      // is not offered again, even to the real desktop, until the person
      // resets the pairing in the desktop's Settings and pairs again.
      desktop.setImposter(true);
      desktop.dropSockets();
      await sleep(300);
      const imposterFrom = desktop.socketLogs.length;
      const signImposter = await sign();
      const imposterSockets = ownSockets(desktop, imposterFrom);
      desktop.setImposter(false);
      const afterImposterFrom = desktop.socketLogs.length;
      const signDistrusted = await sign();
      const distrustedSockets = ownSockets(desktop, afterImposterFrom);
      desktop.resetPairing();
      const codesBeforeReset = desktop.shownCodes.length;
      const resetPage = await context.newPage();
      await resetPage.goto(
        `chrome-extension://${extensionId}/src/popup/pairing.html`
      );
      await pairOnPage(resetPage, desktop, codesBeforeReset);
      await resetPage.close();
      const signAfterImposter = await sign();

      // 5. Locked: the socket's own handshake is refused; the dApp's names it,
      // the person unlocks, and the request goes through.
      desktop.setLocked(true);
      desktop.dropSockets();
      await sleep(300);
      const lockedFrom = desktop.socketLogs.length;
      const signLocked = await sign();
      const lockedSockets = ownSockets(desktop, lockedFrom);

      // 6. Locked, and a heartbeat (the popup's status read) pings the socket
      // its own begin left unbound before any dApp asks: the ping binds
      // nothing, so the dApp's begin, naming it, still runs on that socket.
      desktop.setLocked(true);
      desktop.dropSockets();
      await sleep(300);
      const pingedFrom = desktop.socketLogs.length;
      const popup = await context.newPage();
      await popup.goto(
        `chrome-extension://${extensionId}/src/popup/popup.html`
      );
      await waitFor(
        () =>
          ownSockets(desktop, pingedFrom).some(
            (s) =>
              s.auth[0]?.answer === 1001 &&
              s.all.indexOf('sys_ping', s.all.indexOf('sys_auth_begin')) > 0
          ),
        'a heartbeat ping after a refused begin'
      );
      await popup.close();
      const signPinged = await sign();
      const pingedSockets = ownSockets(desktop, pingedFrom);

      return {
        origin,
        iid,
        signature: desktop.fixtures.evm.signature,
        signKeyless,
        pollKeyless,
        pagesAfterPolls,
        connectKeyless,
        connectAgain,
        pagesAfterConnects,
        beginsBeforePress,
        pagesAfterUnpairedSign,
        connectUnpaired,
        connectsAfterDecline,
        pagesAfterDecline,
        signAfterDecline,
        keylessOrigin,
        firstBegin,
        keylessSockets,
        pairedFrom,
        signPaired,
        pairedSockets,
        signUnpaired,
        repairOrigin,
        repairBegin,
        signRepaired,
        resetSockets,
        signImposter,
        imposterSockets,
        signDistrusted,
        distrustedSockets,
        signAfterImposter,
        signLocked,
        lockedSockets,
        signPinged,
        pingedSockets,
        pairedNow: iid !== undefined && desktop.isPaired(iid),
      };
    }
  );
}

function assertPaired(r, failures) {
  const json = JSON.stringify;
  const startsWith = (methods, prefix) =>
    json(methods.slice(0, prefix.length)) === json(prefix);
  const HANDSHAKE = ['sys_auth_begin', 'sys_auth_finish', 'sys_resume'];
  check(
    failures,
    'without a pairing key a sign and a polled read are refused with 1002 and open nothing',
    r.signKeyless?.error === 1002 &&
      r.pollKeyless.length === 4 &&
      r.pollKeyless.every((p) => p?.error === 1002) &&
      r.pagesAfterPolls === 0,
    json({
      sign: r.signKeyless,
      polls: r.pollKeyless,
      pages: r.pagesAfterPolls,
    })
  );
  check(
    failures,
    'without a pairing key the connect is refused with 1002 and opens one pairing page naming it, which asks the desktop for nothing until Pair is pressed',
    r.connectKeyless?.error === 1002 &&
      r.connectAgain?.error === 1002 &&
      r.pagesAfterConnects === 1 &&
      r.beginsBeforePress === 0 &&
      r.keylessOrigin === r.origin &&
      r.firstBegin?.origin === r.origin,
    json({
      connect: r.connectKeyless,
      again: r.connectAgain,
      pages: r.pagesAfterConnects,
      beginsBeforePress: r.beginsBeforePress,
      opened: r.keylessOrigin,
      begin: r.firstBegin,
    })
  );
  check(
    failures,
    'the pairing runs on the socket the worker held; that socket then authenticates, and nothing else came before',
    r.keylessSockets.some((s) => s.methods.length > 0) &&
      r.keylessSockets.every(
        (s) =>
          s.methods.length === 0 ||
          json(s.methods.slice(0, 5)) ===
            json(['sys_pair_begin', 'sys_pair_finish', ...HANDSHAKE])
      ),
    json(r.keylessSockets)
  );
  const signer = (sockets) =>
    sockets.filter((s) => s.methods.includes('personal_sign'));
  const signedOn = signer(r.pairedSockets);
  check(
    failures,
    'after pairing, the socket a sign goes out on authenticated before its resume',
    r.signPaired === r.signature &&
      signedOn.length >= 1 &&
      signedOn.every((s) =>
        startsWith(
          s.methods.filter((m) => !m.startsWith('sys_pair_')),
          HANDSHAKE
        )
      ),
    json({ sign: r.signPaired, sockets: r.pairedSockets })
  );
  check(
    failures,
    'every authenticated socket proved itself with no dApp named',
    r.pairedSockets
      .filter((s) => s.methods.includes('sys_auth_begin'))
      .every((s) => s.auth[0]?.origin === null),
    json(r.pairedSockets)
  );
  check(
    failures,
    'a reset pairing refuses the sign with 1002, opening nothing, and the connect opens the pairing page naming it',
    r.signUnpaired?.error === 1002 &&
      r.pagesAfterUnpairedSign === 0 &&
      r.connectUnpaired?.error === 1002 &&
      r.repairOrigin === r.origin,
    json({
      sign: r.signUnpaired,
      pages: r.pagesAfterUnpairedSign,
      connect: r.connectUnpaired,
      opened: r.repairOrigin,
      origin: r.origin,
    })
  );
  check(
    failures,
    'a pairing page closed unpaired holds back the dApp’s next connects; paired from the popup, the sign is served',
    r.connectsAfterDecline.every((c) => c?.error === 1002) &&
      r.pagesAfterDecline === 0 &&
      r.signAfterDecline === r.signature,
    json({
      connects: r.connectsAfterDecline,
      pages: r.pagesAfterDecline,
      sign: r.signAfterDecline,
    })
  );
  check(
    failures,
    'the pairing page passes the dApp on to the desktop',
    r.repairBegin?.origin === r.origin,
    json(r.repairBegin)
  );
  const refusedSocket = r.resetSockets[0];
  check(
    failures,
    'after the reset: the socket’s own begin and the dApp’s both hear 1002, nothing binds before the pairing',
    refusedSocket !== undefined &&
      json(refusedSocket.auth.slice(0, 2).map((a) => [a.origin, a.answer])) ===
        json([
          [null, 1002],
          [r.origin, 1002],
        ]) &&
      refusedSocket.methods.indexOf('sys_pair_begin') <
        refusedSocket.methods.indexOf('sys_resume'),
    json(r.resetSockets)
  );
  check(
    failures,
    'paired again: the sign is served on an authenticated socket',
    r.signRepaired === r.signature &&
      signer(r.resetSockets).every(
        (s) =>
          s.methods
            .slice(s.methods.indexOf('sys_resume') - 2)
            .slice(0, 3)
            .join() === HANDSHAKE.join()
      ) &&
      r.pairedNow,
    json({ sign: r.signRepaired, sockets: r.resetSockets })
  );
  check(
    failures,
    'an impostor never gets our proof, nothing binds, and the dApp hears a disconnect',
    r.signImposter?.error === 4900 &&
      /could not prove/.test(r.signImposter?.message ?? '') &&
      /Settings/.test(r.signImposter?.message ?? '') &&
      r.imposterSockets.length >= 1 &&
      r.imposterSockets.every(
        (s) => json(s.methods) === json(['sys_auth_begin'])
      ),
    json({ sign: r.signImposter, sockets: r.imposterSockets })
  );
  check(
    failures,
    'the distrusted key is not offered again: no handshake begins, the dApp is sent to Settings',
    r.signDistrusted?.error === 4900 &&
      /Settings/.test(r.signDistrusted?.message ?? '') &&
      r.distrustedSockets.every((s) => !s.methods.includes('sys_auth_begin')),
    json({ sign: r.signDistrusted, sockets: r.distrustedSockets })
  );
  check(
    failures,
    'reset in Settings and paired again, the sign is served',
    r.signAfterImposter === r.signature,
    json(r.signAfterImposter)
  );
  const lockedSocket = signer(r.lockedSockets)[0];
  check(
    failures,
    'locked: the socket’s own begin hears 1001, the dApp’s names it and goes through',
    r.signLocked === r.signature &&
      lockedSocket !== undefined &&
      json(lockedSocket.auth.map((a) => [a.origin, a.answer])) ===
        json([
          [null, 1001],
          [r.origin, 'ok'],
        ]) &&
      json(lockedSocket.methods) ===
        json(['sys_auth_begin', ...HANDSHAKE, 'personal_sign']),
    json({ sign: r.signLocked, sockets: r.lockedSockets })
  );
  const pinged = r.pingedSockets[0];
  const pingBetween = (all) => {
    const first = all.indexOf('sys_auth_begin');
    const ping = all.indexOf('sys_ping', first);
    const second = all.indexOf('sys_auth_begin', first + 1);
    return (
      first >= 0 &&
      ping > first &&
      second > ping &&
      json(all.slice(second).filter((m) => m !== 'sys_ping')) ===
        json([...HANDSHAKE, 'personal_sign'])
    );
  };
  check(
    failures,
    'locked, then pinged: the ping binds nothing, and the dApp’s begin on the same socket goes through',
    r.signPinged === r.signature &&
      r.pingedSockets.length === 1 &&
      json(pinged.auth.map((a) => [a.origin, a.answer])) ===
        json([
          [null, 1001],
          [r.origin, 'ok'],
        ]) &&
      pingBetween(pinged.all),
    json({ sign: r.signPinged, sockets: r.pingedSockets })
  );
}

// ── The per-tab toolbar indicator ────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every open tab's action state, read from inside the extension's own service
// worker — the only place the per-tab action API can be observed. Tabs are NOT
// identified by URL: that needs the "tabs" permission, which this extension
// deliberately does not ask for, so the assertions count marked tabs instead.
async function readBadges(context) {
  const [sw] = context.serviceWorkers();
  if (sw === undefined) {
    throw new Error('the extension service worker is gone');
  }
  return sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const out = [];
    for (const tab of tabs) {
      out.push({
        text: await chrome.action.getBadgeText({ tabId: tab.id }),
        color: await chrome.action.getBadgeBackgroundColor({ tabId: tab.id }),
        title: await chrome.action.getTitle({ tabId: tab.id }),
      });
    }
    return out;
  });
}

const markedTabs = (badges) => badges.filter((b) => b.text !== '');

// Poll until the toolbar settles into the expected shape (a touch travels page →
// content → SW → action API, so it is never instant), then return what was read
// — on a timeout the LAST reading is returned so the assertion reports the real
// state rather than a bare "timed out".
async function badgesWhen(context, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const badges = await readBadges(context);
    if (predicate(badges) || Date.now() > deadline) {
      return badges;
    }
    await sleep(150);
  }
}

// Scenario 6 — the toolbar indicator, per tab.
async function badgeScenario({ label, stubVersion, profileDir, log }) {
  return withExtension(
    { label, stubVersion, profileDir, readyHook: '__providerReady', log },
    async (page, desktop, origin, context) => {
      // The ready hook read window.ethereum, which is a touch: this tab wants
      // web3 and must now carry the wallet's state.
      const onDapp = await badgesWhen(
        context,
        (b) => markedTabs(b).length === 1
      );

      // A second tab on the SAME origin that never reaches for a provider. It
      // gets the content script and all five providers like any other page.
      const plain = await context.newPage();
      await plain.goto(`${origin}/plain`, { waitUntil: 'domcontentloaded' });
      await sleep(1000); // long enough for a touch to have arrived, had there been one
      const withPlain = await readBadges(context);

      // Navigating away from the dApp ends this tab's web3 session: a fresh
      // document has asked for nothing.
      await page.goto(`${origin}/plain`, { waitUntil: 'domcontentloaded' });
      const afterNav = await badgesWhen(
        context,
        (b) => markedTabs(b).length === 0
      );
      return { onDapp, withPlain, afterNav };
    }
  );
}

// A connected page, then the desktop restarting under it. The heartbeat is driven
// by opening the popup (its status read pings), which is what a user does and
// spares waiting a minute for the alarm.
async function restartScenario({ label, stubVersion, profileDir, log }) {
  return withExtension(
    { label, stubVersion, profileDir, readyHook: '__providerReady', log },
    async (page, desktop, origin, context) => {
      const connect = await drivePage(page, '__connect');
      await page.evaluate(() => {
        window.__accountChanges = [];
        window.ethereum.on('accountsChanged', (a) =>
          window.__accountChanges.push(a)
        );
      });
      const extensionId = new URL(context.serviceWorkers()[0].url()).host;
      const heartbeat = async () => {
        const popup = await context.newPage();
        await popup.goto(
          `chrome-extension://${extensionId}/src/popup/popup.html`
        );
        await sleep(1500);
        await popup.close();
      };

      // The same desktop answering again is not a restart.
      await heartbeat();
      await sleep(500);
      const sameSession = await page.evaluate(() => [
        ...window.__accountChanges,
      ]);

      // The desktop restarts: the old one goes, a new one on the same port names a
      // new session.
      await desktop.close();
      const restarted = await startDesktopStub({
        port: DESKTOP_PORT,
        version: stubVersion,
        desktopSession: '22'.repeat(16),
        secrets: desktop.secrets,
        onLog: (m) => log(`[${label}] restarted stub: ${m}`),
      });
      try {
        await heartbeat();
        await page
          .waitForFunction(() => window.__accountChanges.length > 0, null, {
            timeout: 8000,
          })
          .catch(() => undefined);
        return {
          connect,
          sameSession,
          newSession: await page.evaluate(() => [...window.__accountChanges]),
          accountsAfter: await page.evaluate(() =>
            window.ethereum.request({ method: 'eth_accounts' })
          ),
        };
      } finally {
        await restarted.close();
      }
    }
  );
}

// A connected page whose socket the desktop closes twice: once holding the
// sessions (the next socket resumes them), once after forgetting them. A sign
// request is what makes the worker open the next socket; the pages hear the
// verdict through accountsChanged.
async function heldScenario({ label, stubVersion, profileDir, log }) {
  return withExtension(
    { label, stubVersion, profileDir, readyHook: '__providerReady', log },
    async (page, desktop) => {
      const connect = await drivePage(page, '__connect');
      await page.evaluate(() => {
        window.__accountChanges = [];
        window.ethereum.on('accountsChanged', (a) =>
          window.__accountChanges.push(a)
        );
      });
      const sign = () =>
        page.evaluate(async (account) => {
          try {
            return await window.ethereum.request({
              method: 'personal_sign',
              params: ['0x68656c6c6f', account],
            });
          } catch (e) {
            return { error: e.code };
          }
        }, desktop.grantedAccount);
      const changes = () => page.evaluate(() => [...window.__accountChanges]);

      desktop.dropSockets();
      await sleep(500);
      const signKept = await sign();
      await sleep(1000);
      const keptChanges = await changes();

      desktop.forgetBindings();
      desktop.dropSockets();
      await sleep(500);
      const signLost = await sign();
      await page
        .waitForFunction(() => window.__accountChanges.length > 0, null, {
          timeout: 8000,
        })
        .catch(() => undefined);
      return {
        connect,
        signKept,
        keptChanges,
        signLost,
        lostChanges: await changes(),
        accountsAfter: await page.evaluate(() =>
          window.ethereum.request({ method: 'eth_accounts' })
        ),
        resumes: [...desktop.resumes],
        firstFrames: [...desktop.firstFrames],
        signature: desktop.fixtures.evm.signature,
      };
    }
  );
}

function assertHeld(r, failures) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check(
    failures,
    'connect',
    r.connect?.ok === true && r.connect.accounts?.length === 1,
    JSON.stringify(r.connect)
  );
  // The AUTO probe's placeholder-iid socket sends sys_ping; every socket of the
  // instance itself must bind with sys_resume, its first frame after the
  // handshake.
  const own = r.firstFrames.filter((f) => !/^0{8}-/.test(f.iid));
  check(
    failures,
    'every socket of the instance binds with sys_resume (three sockets)',
    own.length >= 3 && own.every((f) => f.method === 'sys_resume'),
    JSON.stringify(r.firstFrames)
  );
  const [first, kept, lost] = r.resumes;
  check(
    failures,
    'the first socket presents no secret',
    first !== undefined && first.presented === null && !first.restored,
    JSON.stringify(r.resumes)
  );
  check(
    failures,
    'the socket after a close presents the secret the last one was handed',
    first !== undefined &&
      kept !== undefined &&
      kept.presented === first.minted &&
      kept.restored,
    JSON.stringify(r.resumes)
  );
  check(
    failures,
    'a restored resume: the sign answers and the page forgets nothing',
    r.signKept === r.signature && r.keptChanges.length === 0,
    JSON.stringify({ sign: r.signKept, changes: r.keptChanges })
  );
  check(
    failures,
    'after the desktop forgot the binding the next secret is presented and not restored',
    kept !== undefined &&
      lost !== undefined &&
      lost.presented === kept.minted &&
      !lost.restored,
    JSON.stringify(r.resumes)
  );
  check(
    failures,
    'a resume not restored tells the page it has no accounts',
    r.lostChanges.some((a) => same(a, [])),
    JSON.stringify(r.lostChanges)
  );
  check(
    failures,
    'eth_accounts then answers []',
    Array.isArray(r.accountsAfter) && r.accountsAfter.length === 0,
    JSON.stringify(r.accountsAfter)
  );
}

// A connected page hears only the pushes about the chain each provider is on.
// The desktop tags an accountsChanged push with the chain whose grant changed
// (in its dispatcher). Each step pushes one event about ANOTHER chain and
// then one about the provider's own, with distinct payloads: one FIFO path (WS,
// worker, port, page) carries both, so once the second has arrived the record
// shows whether the first was applied, without a sleep.
async function pushChainScenario({ label, stubVersion, profileDir, log }) {
  return withExtension(
    { label, stubVersion, profileDir, readyHook: '__walletsReady', log },
    async (page, desktop, origin) => {
      const run = (fn, arg) =>
        page.evaluate(fn, arg).catch((e) => ({ error: String(e) }));
      const arrived = (ns, count) =>
        page
          .waitForFunction(
            ([n, c]) => window.__pushed[n].length >= c,
            [ns, count],
            { timeout: 8000 }
          )
          .catch(() => undefined);
      const connect = await run(async () => {
        window.__pushed = { evm: [], tron: [] };
        const evm = await window.ethereum.request({
          method: 'eth_requestAccounts',
        });
        await window.tronLink.request({ method: 'tron_requestAccounts' });
        window.ethereum.on('accountsChanged', (a) =>
          window.__pushed.evm.push(a)
        );
        window.tron.on('accountsChanged', (a) => window.__pushed.tron.push(a));
        return { evm, tron: window.tronWeb.defaultAddress.base58 };
      });
      const push = (ns, chain, data) =>
        desktop.push({ origin, ns, chain, event: 'accountsChanged', data });

      // EVM on mainnet: a push about Sepolia, then one about mainnet.
      push('evm', PUSH.evmOther, []);
      push('evm', CHAIN.evm, [PUSH.evmAccount]);
      await arrived('evm', 1);

      // After a switch the chain left behind is "another chain".
      const switched = await run(() =>
        window.ethereum
          .request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: '0x89' }],
          })
          .then(() => window.ethereum.request({ method: 'eth_chainId' }))
      );
      push('evm', CHAIN.evm, []);
      push('evm', CHAIN.evmSwitched, [desktop.grantedAccount]);
      await arrived('evm', 2);

      // TRON serves mainnet only: a push about Shasta, then one about mainnet.
      push('tron', PUSH.tronOther, []);
      push('tron', CHAIN.tron, [PUSH.tronAccount]);
      await arrived('tron', 1);

      return {
        connect,
        switched,
        grantedAccount: desktop.grantedAccount,
        tronAccount: desktop.fixtures.tron.account,
        pushed: await run(() => window.__pushed),
        after: await run(async () => ({
          evm: await window.ethereum.request({ method: 'eth_accounts' }),
          tron: window.tronWeb.defaultAddress.base58,
        })),
      };
    }
  );
}

// ── Assertion helpers ────────────────────────────────────────────────────────
// Each collects failure strings so one scenario reports everything that broke,
// not just the first thing.

const check = (failures, label, condition, detail) => {
  if (!condition) {
    failures.push(`${label}${detail === undefined ? '' : `: ${detail}`}`);
  }
};

// A step the wallet approved, whose value must equal what the stub sent. `ok`
// alone would pass on a provider that returned the wrong field — the fixtures
// are deliberately distinct from each other so a swap fails here.
const approved = (failures, label, stepResult, expected) => {
  if (stepResult?.ok !== true) {
    check(
      failures,
      label,
      false,
      JSON.stringify(stepResult?.error ?? stepResult)
    );
    return;
  }
  if (expected === undefined) {
    return;
  }
  const actual =
    typeof expected === 'function' ? expected(stepResult.value) : undefined;
  if (typeof expected === 'function') {
    check(failures, label, actual === true, JSON.stringify(stepResult.value));
    return;
  }
  check(
    failures,
    label,
    JSON.stringify(stepResult.value) === JSON.stringify(expected),
    `got ${JSON.stringify(stepResult.value)}, want ${JSON.stringify(expected)}`
  );
};

// A step the wallet refused: rejected with the wire UserRejected code.
const refused = (failures, label, stepResult) =>
  check(
    failures,
    label,
    stepResult?.ok === false && stepResult.error?.code === 4001,
    JSON.stringify(stepResult)
  );

// TON Connect never throws — it answers a WalletResponse carrying its own error
// code, and the wire 4001 maps to TON Connect's 300 (USER_REJECTS_ERROR).
const refusedTon = (failures, label, stepResult) =>
  check(
    failures,
    label,
    stepResult?.ok === true && stepResult.value?.error?.code === 300,
    JSON.stringify(stepResult)
  );

function assertApprovedEvm(flows, failures) {
  const f = flows.fixtures;
  const evm = flows.evm;

  approved(failures, 'evm connect', evm.connect, [f.evm.account]);
  approved(failures, 'evm personal_sign', evm.sign, f.evm.signature);
  approved(
    failures,
    'evm personal_sign plain text',
    evm.signText,
    f.evm.signature
  );
  approved(failures, 'evm eth_sendTransaction', evm.tx, f.evm.txHash);

  // The cached reads: answered locally (asserted here) and absent from the wire
  // (asserted in assertWire). Both halves are needed — either alone passes on a
  // read that started round-tripping but still returned the right value.
  approved(failures, 'evm eth_chainId', evm.chainId, '0x1');
  approved(failures, 'evm net_version', evm.netVersion, '1');
  approved(failures, 'evm eth_accounts', evm.accounts, [f.evm.account]);
  approved(failures, 'evm eth_coinbase', evm.coinbase, f.evm.account);

  // EIP-3326 returns null to the dApp, and the provider adopts the chain the
  // DESKTOP resolved. The cached chainId must move with it.
  approved(failures, 'evm wallet_switchEthereumChain', evm.switchChain, null);
  approved(
    failures,
    'evm chainId after switch',
    evm.chainIdAfterSwitch,
    '0x89'
  );
  approved(failures, 'evm personal_sign after switch', evm.signAfterSwitch);

  // The legacy provider properties a MetaMask-era dApp reads instead of asking
  // (testnet.soniclabs.com reads ethereum.chainId). They must follow the same
  // state as the cached reads: the bootstrap chain and no account before the
  // connect, the granted account (lowercase, as MetaMask's) after it, and the
  // desktop-resolved chain after the switch.
  const account = f.evm.account.toLowerCase();
  approved(failures, 'evm legacy properties before connect', evm.legacyBefore, {
    chainId: '0x1',
    networkVersion: '1',
    selectedAddress: null,
  });
  approved(
    failures,
    'evm legacy properties after connect',
    evm.legacyAfterConnect,
    { chainId: '0x1', networkVersion: '1', selectedAddress: account }
  );
  approved(
    failures,
    'evm legacy properties after switch',
    evm.legacyAfterSwitch,
    { chainId: '0x89', networkVersion: '137', selectedAddress: account }
  );
}

function assertApprovedSolana(flows, failures) {
  const f = flows.fixtures;
  const sol = flows.solana;

  approved(failures, 'solana connect', sol.connect);
  check(
    failures,
    'solana connect account',
    sol.connect?.value?.[0]?.address === f.solana.account,
    JSON.stringify(sol.connect?.value)
  );
  // The address IS the base58 of the ed25519 pubkey, so the adapter decodes it
  // rather than being handed one. This expectation is the base58 decode of the
  // fixture address computed with an INDEPENDENT implementation, not a copy of
  // what the extension produced — otherwise it would only assert that the
  // decoder agrees with itself.
  check(
    failures,
    'solana connect publicKey decoded from the address',
    sol.connect?.value?.[0]?.publicKey ===
      '069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001',
    JSON.stringify(sol.connect?.value?.[0]?.publicKey)
  );
  approved(failures, 'solana signMessage', sol.signMessage, {
    // base64 'BQYHCA==' → 05 06 07 08; signedMessage echoes the input bytes.
    signature: '05060708',
    signedMessage: '01020304',
  });
  approved(failures, 'solana signTransaction', sol.signTransaction, {
    signedTransaction: '01020304',
  });
  approved(failures, 'solana signAndSendTransaction', sol.signAndSend, {
    signature: '00'.repeat(64),
  });
}

function assertApprovedSui(flows, failures) {
  const f = flows.fixtures;
  const sui = flows.sui;

  approved(failures, 'sui connect', sui.connect);
  check(
    failures,
    'sui connect account',
    sui.connect?.value?.[0]?.address === f.sui.account &&
      sui.connect?.value?.[0]?.publicKey === f.sui.publicKey,
    JSON.stringify(sui.connect?.value)
  );
  approved(failures, 'sui signPersonalMessage', sui.signPersonalMessage, {
    // bytes echoes the signed message (base64 of 01 02 03 04).
    bytes: 'AQIDBA==',
    signature: f.sui.signature,
  });
  // bytes and signature are distinct fixtures, so a swapped pair fails here.
  approved(failures, 'sui signTransaction', sui.signTransaction, {
    bytes: f.sui.bytes,
    signature: f.sui.signature,
  });
  approved(failures, 'sui signAndExecuteTransaction', sui.signAndExecute, {
    digest: f.sui.digest,
    bytes: f.sui.bytes,
    signature: f.sui.signature,
    effects: f.sui.effects,
  });
}

function assertApprovedTon(flows, failures) {
  const f = flows.fixtures;
  const ton = flows.ton;
  const host = new URL(flows.origin).host;

  approved(failures, 'ton connect', ton.connect);
  const items = ton.connect?.value?.payload?.items;
  check(
    failures,
    'ton connect items',
    ton.connect?.value?.event === 'connect' &&
      items?.[0]?.name === 'ton_addr' &&
      items[0].address === f.ton.address &&
      items[0].publicKey === f.ton.publicKey &&
      items[0].walletStateInit === f.ton.walletStateInit,
    JSON.stringify(ton.connect?.value)
  );
  // The dApp asked for a ton_proof, so the reply must carry the second item —
  // proof that the bridge forwarded the payload and not just the bare address.
  check(
    failures,
    'ton connect proof',
    items?.[1]?.name === 'ton_proof' &&
      items[1].proof?.payload === 'e2e-proof' &&
      // domain_from_origin keeps the PORT; a proof signed over the wrong domain
      // is a proof for a different site.
      items[1].proof?.domain?.value === host &&
      items[1].proof?.domain?.lengthBytes === host.length,
    JSON.stringify(items?.[1])
  );
  check(
    failures,
    'ton sendTransaction boc',
    ton.tx?.value?.result === f.ton.boc && ton.tx?.value?.id === '1',
    JSON.stringify(ton.tx)
  );
  // The desktop echoes the request params, so this proves the bridge PARSED the
  // dApp's JSON string param and shipped the object — not the raw string.
  check(
    failures,
    'ton signData echoes the parsed payload',
    ton.signData?.value?.result?.address === f.ton.address &&
      ton.signData?.value?.result?.domain === host &&
      ton.signData?.value?.result?.payload?.type === 'text' &&
      ton.signData?.value?.result?.payload?.text === 'e2e',
    JSON.stringify(ton.signData)
  );
  check(
    failures,
    'ton disconnect',
    ton.disconnect?.ok === true && ton.disconnect.value?.id === '3',
    JSON.stringify(ton.disconnect)
  );
}

function assertApprovedTron(flows, failures) {
  const f = flows.fixtures;
  const tron = flows.tron;

  approved(failures, 'tron connect', tron.connect, [f.tron.account]);
  check(
    failures,
    'tron defaultAddress',
    tron.ready === true &&
      tron.defaultAddress?.base58 === f.tron.account &&
      tron.defaultAddress?.hex === f.tron.accountHex,
    JSON.stringify(tron.defaultAddress)
  );
  // The 0x-prefixed form is TronWeb's signMessageV2 contract; the bare form is
  // trx.sign's. The stub returns them differently on purpose.
  approved(
    failures,
    'tron signMessageV2',
    tron.signMessage,
    f.tron.messageSignature
  );
  approved(failures, 'tron trx.sign', tron.sign);
  // trx.sign is TronWeb-faithful: the extension appends the desktop's bare
  // signature to the transaction's signature[].
  check(
    failures,
    'tron signed tx carries the signature',
    tron.sign?.value?.signature?.[0] === f.tron.signature &&
      tron.sign?.value?.txID === 'ab'.repeat(32),
    JSON.stringify(tron.sign?.value?.signature)
  );
  approved(failures, 'tron sendRawTransaction', tron.broadcast, {
    result: true,
    txid: f.tron.txid,
  });
}

// What crossed the wire is as much the contract as what came back: the content
// script's origin stamp (a page cannot forge it), the canonical chain key per
// ecosystem, the two wstd ecosystems separated by `chain` alone, and `sys`
// never reachable from a page.
function assertWire(flows, failures) {
  const seen = flows.frames;
  const pageFrames = seen.filter((r) => r.ns !== 'sys');
  const find = (method, chain) =>
    seen.find(
      (r) => r.method === method && (chain === undefined || r.chain === chain)
    );
  const allOn = (ns, chain) => {
    const subset = seen.filter((r) => r.ns === ns);
    // `.every` over an empty list is vacuously true, so require the frames to
    // exist before believing they rode the right chain.
    return subset.length > 0 && subset.every((r) => r.chain === chain);
  };

  check(
    failures,
    'every page frame carries the real page origin',
    pageFrames.length > 0 && pageFrames.every((r) => r.origin === flows.origin),
    JSON.stringify([...new Set(pageFrames.map((r) => r.origin))])
  );

  // The forged frame: the page synthesized a `sys` request on the public
  // postMessage channel. It must be refused locally AND never appear on the
  // wire. A sys_ping the SERVICE WORKER sends carries no origin, which is what
  // separates it from a page-originated one.
  check(
    failures,
    'a forged sys frame is refused at the content seam',
    flows.forgedSys?.value?.ok === false &&
      flows.forgedSys.value.error?.code === 1100,
    JSON.stringify(flows.forgedSys)
  );
  check(
    failures,
    'no page-originated sys frame reached the wire',
    !seen.some(
      (r) => r.ns === 'sys' && r.origin !== undefined && r.origin !== ''
    ),
    JSON.stringify(seen.filter((r) => r.ns === 'sys').map((r) => r.origin))
  );

  // EVM rides mainnet until the EIP-3326 switch, and the resolved key after it.
  // Pinning both sides is what proves the provider adopted the DESKTOP's key
  // rather than keeping a hardcoded default.
  const evmFrames = seen.filter((r) => r.ns === 'evm');
  const switchAt = evmFrames.findIndex(
    (r) => r.method === 'wallet_switchEthereumChain'
  );
  check(failures, 'the chain switch reached the wire', switchAt >= 0);
  if (switchAt >= 0) {
    check(
      failures,
      'evm frames before the switch ride mainnet',
      evmFrames.slice(0, switchAt + 1).every((r) => r.chain === CHAIN.evm),
      JSON.stringify(evmFrames.slice(0, switchAt + 1).map((r) => r.chain))
    );
    const after = evmFrames.slice(switchAt + 1);
    check(
      failures,
      'evm frames after the switch ride the resolved chain',
      after.length > 0 && after.every((r) => r.chain === CHAIN.evmSwitched),
      JSON.stringify(after.map((r) => r.chain))
    );
  }

  // Solana and Sui share `wstd`; `chain` is the ONLY thing that tells the
  // desktop which ecosystem a standard:connect belongs to.
  check(
    failures,
    'solana standard:connect rides the solana chain key',
    find('standard:connect', CHAIN.solana) !== undefined
  );
  check(
    failures,
    'sui standard:connect rides the sui chain key',
    find('standard:connect', CHAIN.sui) !== undefined
  );
  check(
    failures,
    'tonconnect frames ride the ton chain key',
    allOn('tonconnect', CHAIN.ton),
    JSON.stringify(
      seen.filter((r) => r.ns === 'tonconnect').map((r) => r.chain)
    )
  );
  check(
    failures,
    'tron frames ride the tron chain key',
    allOn('tron', CHAIN.tron),
    JSON.stringify(seen.filter((r) => r.ns === 'tron').map((r) => r.chain))
  );

  // The four cached EVM reads must never appear at all. The dApp calls all four,
  // so this is a real absence, not an untested one.
  check(
    failures,
    'cached EVM reads never reach the wire',
    !seen.some((r) => CACHED_EVM_READS.includes(r.method)),
    JSON.stringify(seen.map((r) => r.method))
  );

  // The Solana send options must arrive whitelisted, not dropped.
  const send = find('solana:signAndSendTransaction');
  check(
    failures,
    'solana send options forwarded',
    send?.params?.options?.skipPreflight === true &&
      send?.params?.options?.preflightCommitment === 'confirmed',
    JSON.stringify(send?.params?.options)
  );
  // The signer address must ride with the request — the desktop authorises per
  // (origin, address), so a dropped address is a refused signature.
  check(
    failures,
    'sign requests carry the signer address',
    find('sui:signTransaction')?.params?.address ===
      flows.fixtures.sui.account &&
      find('tron_signTransaction')?.params?.address ===
        flows.fixtures.tron.account,
    JSON.stringify({
      sui: find('sui:signTransaction')?.params,
      tron: find('tron_signTransaction')?.params?.address,
    })
  );
}

function assertApproved(flows, failures) {
  assertApprovedEvm(flows, failures);
  assertApprovedSolana(flows, failures);
  assertApprovedSui(flows, failures);
  assertApprovedTon(flows, failures);
  assertApprovedTron(flows, failures);
  assertWire(flows, failures);
}

function assertConnectRejected(flows, failures) {
  refused(failures, 'evm connect refused', flows.evm.connect);
  refused(failures, 'solana connect refused', flows.solana.connect);
  refused(failures, 'sui connect refused', flows.sui.connect);
  refused(failures, 'tron connect refused', flows.tron.connect);
  // TON Connect maps the wire 4001 to its own USER_REJECTS_ERROR (300) and
  // answers a connect_error EVENT rather than rejecting.
  check(
    failures,
    'ton connect refused',
    flows.ton.connect?.ok === true &&
      flows.ton.connect.value?.event === 'connect_error' &&
      flows.ton.connect.value.payload?.code === 300,
    JSON.stringify(flows.ton.connect)
  );
}

function assertTxRejected(flows, failures) {
  // Connect was approved in this scenario — if it were not, the refusals below
  // would be proving the wrong thing.
  approved(failures, 'evm connect (precondition)', flows.evm.connect);
  approved(failures, 'solana connect (precondition)', flows.solana.connect);
  approved(failures, 'sui connect (precondition)', flows.sui.connect);
  approved(failures, 'tron connect (precondition)', flows.tron.connect);

  refused(failures, 'evm personal_sign refused', flows.evm.sign);
  refused(failures, 'evm eth_sendTransaction refused', flows.evm.tx);
  refused(failures, 'solana signMessage refused', flows.solana.signMessage);
  refused(
    failures,
    'solana signTransaction refused',
    flows.solana.signTransaction
  );
  refused(failures, 'solana broadcast refused', flows.solana.signAndSend);
  refused(
    failures,
    'sui signPersonalMessage refused',
    flows.sui.signPersonalMessage
  );
  refused(failures, 'sui signTransaction refused', flows.sui.signTransaction);
  refused(failures, 'sui execute refused', flows.sui.signAndExecute);
  refused(failures, 'tron signMessageV2 refused', flows.tron.signMessage);
  refused(failures, 'tron trx.sign refused', flows.tron.sign);
  refusedTon(failures, 'ton sendTransaction refused', flows.ton.tx);
  refusedTon(failures, 'ton signData refused', flows.ton.signData);

  // A refused signature means there is nothing to broadcast — the dApp must not
  // have submitted the unsigned transaction.
  check(
    failures,
    'no broadcast after a refused signature',
    flows.tron.broadcast === undefined,
    JSON.stringify(flows.tron.broadcast)
  );
}

// The badge colour comes back as [r, g, b, a] from the action API.
const isColor = (rgba, hex) => {
  const want = [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  return (
    Array.isArray(rgba) && want.every((component, i) => rgba[i] === component)
  );
};

function assertBadge({ onDapp, withPlain, afterNav }, failures) {
  const marked = markedTabs(onDapp);
  check(
    failures,
    'the dApp tab does not carry exactly one badge',
    marked.length === 1,
    JSON.stringify(onDapp)
  );
  if (marked.length === 1) {
    // The stub reports an unlocked wallet, so the dot must be the green
    // ready-to-sign one — the badge shows wallet STATE, not merely presence.
    check(
      failures,
      'the dApp tab is not showing the unlocked dot',
      marked[0].text === '●' && isColor(marked[0].color, '#16a34a'),
      JSON.stringify(marked[0])
    );
    check(
      failures,
      'the tooltip does not say the wallet is ready',
      /ready to sign/.test(marked[0].title),
      marked[0].title
    );
  }
  // The control case: injecting providers, connecting the content port and
  // saying hello are all things the EXTENSION does. None of them is the page
  // asking for a wallet, so the toolbar must stay blank on that tab.
  check(
    failures,
    'a page that never touched a provider lit the toolbar',
    markedTabs(withPlain).length === 1,
    JSON.stringify(withPlain)
  );
  check(
    failures,
    'the badge outlived the document that earned it',
    markedTabs(afterNav).length === 0,
    JSON.stringify(afterNav)
  );
}

// Scenario 8: only the pushes about each provider's own chain were heard.
function assertPushChain(r, failures) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check(
    failures,
    'connect',
    same(r.connect, { evm: [r.grantedAccount], tron: r.tronAccount }),
    JSON.stringify(r.connect)
  );
  check(
    failures,
    'the switch to 0x89',
    r.switched === '0x89',
    JSON.stringify(r.switched)
  );
  check(
    failures,
    'EVM heard only the pushes about its active chain',
    same(r.pushed?.evm, [[PUSH.evmAccount], [r.grantedAccount]]),
    JSON.stringify(r.pushed?.evm)
  );
  check(
    failures,
    'TRON heard only the push about mainnet',
    same(r.pushed?.tron, [[PUSH.tronAccount]]),
    JSON.stringify(r.pushed?.tron)
  );
  check(
    failures,
    'the accounts each provider then answers',
    same(r.after, { evm: [r.grantedAccount], tron: PUSH.tronAccount }),
    JSON.stringify(r.after)
  );
}

async function main() {
  const log = (m) => console.log(`[e2e] ${m}`);
  const failures = [];
  const record = (label, scenarioFailures) => {
    log(
      `${label} → ${scenarioFailures.length === 0 ? 'PASS' : 'FAIL'}` +
        (scenarioFailures.length === 0
          ? ''
          : ` (${scenarioFailures.length} failure(s))`)
    );
    failures.push(...scenarioFailures.map((f) => `${label}: ${f}`));
  };

  // Scenario 1 — a COMPATIBLE desktop: the dApp connects and gets the account.
  const compat = await connectScenario({
    label: 'compatible',
    stubVersion: { wallet: 2, major: 3, minor: 1 },
    profileDir: '.chromium-profile',
    log,
  });
  const compatFailures = [];
  check(
    compatFailures,
    'did not receive the account',
    compat.result.ok === true &&
      Array.isArray(compat.result.accounts) &&
      compat.result.accounts.includes(compat.grantedAccount),
    JSON.stringify(compat.result)
  );
  record('compatible', compatFailures);

  // Scenario 2 — an INCOMPATIBLE desktop (major 99): the request is refused
  // end-to-end with VersionIncompatible (1103), NOT an account. Covers the version
  // gate (the extension's fail-fast and/or the desktop's 1103) over the wire.
  const incompat = await connectScenario({
    label: 'incompatible',
    stubVersion: { wallet: 2, major: 99, minor: 0 },
    profileDir: '.chromium-profile-incompat',
    log,
    pair: false,
  });
  const incompatFailures = [];
  check(
    incompatFailures,
    'was not refused with 1103',
    incompat.result.ok === false && incompat.result.error?.code === 1103,
    JSON.stringify(incompat.result)
  );
  record('incompatible', incompatFailures);

  // Scenario 2b — a desktop of the previous major (no mandatory
  // authentication): refused with 1103, and no pairing page is opened for a
  // pairing it would refuse. (The provider words every 1103 alike; the side to
  // update is the popup's to name.)
  const older = await connectScenario({
    label: 'incompatible-older-desktop',
    stubVersion: { wallet: 2, major: 2, minor: 1 },
    profileDir: '.chromium-profile-incompat-older',
    log,
    pair: false,
  });
  const olderFailures = [];
  check(
    olderFailures,
    'was not refused with 1103, or a pairing was offered',
    older.result.ok === false &&
      older.result.error?.code === 1103 &&
      older.pairBegins === 0 &&
      older.pairingPages === 0,
    JSON.stringify(older)
  );
  record('incompatible-older-desktop', olderFailures);

  // Scenario 3 — every ecosystem's happy path, plus what crossed the wire.
  const approvedFlows = await flowScenario({
    label: 'approved',
    stubVersion: { wallet: 2, major: 3, minor: 1 },
    rejectMethods: [],
    profileDir: '.chromium-profile-approved',
    log,
  });
  const approvedFailures = [];
  assertApproved(approvedFlows, approvedFailures);
  record('approved', approvedFailures);

  // Scenario 4 — the user declines every connect.
  const connectRejected = await flowScenario({
    label: 'connect-rejected',
    stubVersion: { wallet: 2, major: 3, minor: 1 },
    rejectMethods: CONNECT_METHODS,
    profileDir: '.chromium-profile-connect-rejected',
    log,
  });
  const connectRejectedFailures = [];
  assertConnectRejected(connectRejected, connectRejectedFailures);
  record('connect-rejected', connectRejectedFailures);

  // Scenario 5 — connect approved, every confirmation declined.
  const txRejected = await flowScenario({
    label: 'tx-rejected',
    stubVersion: { wallet: 2, major: 3, minor: 1 },
    rejectMethods: CONFIRM_METHODS,
    profileDir: '.chromium-profile-tx-rejected',
    log,
  });
  const txRejectedFailures = [];
  assertTxRejected(txRejected, txRejectedFailures);
  record('tx-rejected', txRejectedFailures);

  // Scenario 6 — the toolbar indicator is per tab and follows web3 activity.
  const badge = await badgeScenario({
    label: 'badge',
    stubVersion: { wallet: 2, major: 3, minor: 1 },
    profileDir: '.chromium-profile-badge',
    log,
  });
  const badgeFailures = [];
  assertBadge(badge, badgeFailures);
  record('badge', badgeFailures);

  // Scenario 7 — a desktop restart makes every connected dApp forget its accounts.
  const restart = await restartScenario({
    label: 'restart',
    stubVersion: { wallet: 2, major: 3, minor: 1 },
    profileDir: '.chromium-profile-restart',
    log,
  });
  const restartFailures = [];
  check(
    restartFailures,
    'connect',
    restart.connect?.ok === true && restart.connect.accounts?.length === 1,
    JSON.stringify(restart.connect)
  );
  check(
    restartFailures,
    'the same desktop session forgets nothing',
    restart.sameSession.length === 0,
    JSON.stringify(restart.sameSession)
  );
  check(
    restartFailures,
    'a new desktop session tells the idle page it has no accounts',
    JSON.stringify(restart.newSession) === JSON.stringify([[]]),
    JSON.stringify(restart.newSession)
  );
  check(
    restartFailures,
    'eth_accounts then answers []',
    Array.isArray(restart.accountsAfter) && restart.accountsAfter.length === 0,
    JSON.stringify(restart.accountsAfter)
  );
  record('restart', restartFailures);

  // Scenario 8 — a push about another chain leaves a provider's accounts alone.
  const pushChain = await pushChainScenario({
    label: 'push-chain',
    stubVersion: { wallet: 2, major: 3, minor: 1 },
    profileDir: '.chromium-profile-push-chain',
    log,
  });
  const pushChainFailures = [];
  assertPushChain(pushChain, pushChainFailures);
  record('push-chain', pushChainFailures);

  // Scenario 9 — the desktop's held sessions, resumed by the secret.
  const held = await heldScenario({
    label: 'held',
    stubVersion: { wallet: 2, major: 3, minor: 1 },
    profileDir: '.chromium-profile-held',
    log,
  });
  const heldFailures = [];
  assertHeld(held, heldFailures);
  record('held', heldFailures);

  // Scenario 10 — pairing by code and the socket handshake.
  const paired = await pairedScenario({
    label: 'paired',
    stubVersion: { wallet: 2, major: 3, minor: 1 },
    profileDir: '.chromium-profile-paired',
    log,
  });
  const pairedFailures = [];
  assertPaired(paired, pairedFailures);
  record('paired', pairedFailures);

  if (failures.length === 0) {
    log(
      'PASS — version gate, connect + sign + broadcast approved and refused ' +
        'across EVM, Solana, Sui, TON Connect and TRON, the per-tab badge, ' +
        'a desktop restart forgetting every cached account, pushes about ' +
        'another chain left unheard, sessions resumed by the secret, and ' +
        'pairing by code with every socket authenticated'
    );
    process.exit(0);
  } else {
    log(`FAIL — ${failures.length} failure(s)`);
    for (const f of failures) {
      log(`  - ${f}`);
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[e2e] fatal', e);
  process.exit(2);
});
