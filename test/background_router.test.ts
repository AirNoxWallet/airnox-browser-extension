import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BackgroundRouter,
  RouterDeps,
} from '../src/background/background_router';
import { OutboundFrame, PortPoster } from '../src/background/post_to_port';
import { SenderLike } from '../src/background/sender_policy';
import {
  PortEvent,
  PortHello,
  PortRequest,
  PortResult,
} from '../src/protocol/bridge';
import {
  ErrorCode,
  Event,
  Request,
  Response,
  VersionVerdict,
  WEB3_PROTOCOL_VERSION,
} from '../src/protocol/envelope';

// A stub content port: records the frames the router posts to it, and works as a
// Map key (object identity).
class StubPort implements PortPoster {
  readonly sent: OutboundFrame[] = [];
  postMessage(frame: OutboundFrame): void {
    this.sent.push(frame);
  }
}

// What the browser reports for a content script in a tab's top frame (Chrome
// shape: it names the origin itself).
function topFrameSender(origin: string): SenderLike {
  return { tab: { id: 7 }, frameId: 0, url: `${origin}/dapp`, origin };
}

// Open a port as the browser would for a page of `origin`, then say its hello,
// as the content script does first thing on every port.
function bindPort(
  router: BackgroundRouter,
  port: StubPort,
  origin: string
): void {
  assert.equal(router.openPort(port, topFrameSender(origin)), true);
  assert.equal(router.handleHello(port, { kind: 'hello', origin }), true);
}

function boundPort(
  router: BackgroundRouter,
  origin: string = RPC.origin
): StubPort {
  const port = new StubPort();
  bindPort(router, port, origin);
  return port;
}

const asResult = (f: OutboundFrame): PortResult => f as PortResult;
const asEvent = (f: OutboundFrame): PortEvent => f as PortEvent;

function okResponse(result: unknown): Response {
  return { v: WEB3_PROTOCOL_VERSION, iid: 'iid', rid: 'rid', ok: true, result };
}

// Build router deps; the default `send` records the wire frames it receives.
function makeDeps(overrides: Partial<RouterDeps> = {}): {
  deps: RouterDeps;
  sent: Request[];
} {
  const sent: Request[] = [];
  const deps: RouterDeps = {
    send: (wire) => {
      sent.push(wire);
      return Promise.resolve(okResponse('OK'));
    },
    iid: () => Promise.resolve('the-iid'),
    newRid: () => 'the-rid',
    ...overrides,
  };
  return { deps, sent };
}

const RPC: PortRequest = {
  kind: 'rpc',
  id: 'req-1',
  ns: 'evm',
  origin: 'https://app.example',
  method: 'eth_requestAccounts',
  params: [],
};

const INCOMPATIBLE: VersionVerdict = {
  compatible: false,
  updateSide: 'extension',
  desktop: { wallet: 2, major: 99, minor: 0 },
};

function pushEvent(origin: string): Event {
  return {
    v: WEB3_PROTOCOL_VERSION,
    iid: 'iid',
    ns: 'evm',
    origin,
    event: 'accountsChanged',
    data: ['0x1'],
  };
}

test('routeEvent delivers a push only to ports serving the target origin', () => {
  const { deps } = makeDeps();
  const router = new BackgroundRouter(deps);
  const a = new StubPort();
  const b = new StubPort();
  bindPort(router, a, 'https://a.example');
  bindPort(router, b, 'https://b.example');

  router.routeEvent(pushEvent('https://a.example'));

  assert.equal(a.sent.length, 1);
  assert.equal(asEvent(a.sent[0]).kind, 'event');
  assert.equal(asEvent(a.sent[0]).event, 'accountsChanged');
  assert.equal(b.sent.length, 0); // another origin never sees it
});

test('routeEvent drops an origin-less event', () => {
  const { deps } = makeDeps();
  const router = new BackgroundRouter(deps);
  const a = new StubPort();
  bindPort(router, a, 'https://a.example');
  router.routeEvent(pushEvent(''));
  assert.equal(a.sent.length, 0);
});

test('dropPort stops further pushes to that port', () => {
  const { deps } = makeDeps();
  const router = new BackgroundRouter(deps);
  const a = new StubPort();
  bindPort(router, a, 'https://a.example');
  router.dropPort(a);
  router.routeEvent(pushEvent('https://a.example'));
  assert.equal(a.sent.length, 0);
});

test('handleRpc fails fast on an incompatible version, without a round-trip', async () => {
  const { deps, sent } = makeDeps();
  const router = new BackgroundRouter(deps);
  router.setVerdict(INCOMPATIBLE);
  const port = boundPort(router);

  await router.handleRpc(port, RPC);

  assert.equal(sent.length, 0); // never reached the desktop
  assert.equal(port.sent.length, 1);
  assert.equal(asResult(port.sent[0]).ok, false);
  assert.equal(
    asResult(port.sent[0]).error?.code,
    ErrorCode.VersionIncompatible
  );
});

test('handleRpc refuses a non-dApp namespace, without a round-trip', async () => {
  const { deps, sent } = makeDeps();
  const router = new BackgroundRouter(deps);
  const port = boundPort(router);

  await router.handleRpc(port, { ...RPC, ns: 'sys', method: 'sys_ping' });

  assert.equal(sent.length, 0);
  assert.equal(port.sent.length, 1);
  assert.equal(asResult(port.sent[0]).error?.code, ErrorCode.MalformedRequest);
});

test('handleRpc builds the wire frame and forwards the desktop result', async () => {
  const captured: Request[] = [];
  const router = new BackgroundRouter({
    send: (wire) => {
      captured.push(wire);
      return Promise.resolve(okResponse(['0xabc']));
    },
    iid: () => Promise.resolve('the-iid'),
    newRid: () => 'the-rid',
  });
  const port = boundPort(router);

  await router.handleRpc(port, RPC);

  assert.equal(captured.length, 1);
  assert.equal(captured[0].iid, 'the-iid');
  assert.equal(captured[0].rid, 'the-rid');
  assert.equal(captured[0].ns, 'evm');
  assert.equal(captured[0].origin, 'https://app.example');
  assert.equal(captured[0].method, 'eth_requestAccounts');
  assert.equal(asResult(port.sent[0]).ok, true);
  assert.deepEqual(asResult(port.sent[0]).result, ['0xabc']);
});

test('handleRpc maps a transport rejection to a Disconnected reply', async () => {
  const { deps } = makeDeps({
    send: () => Promise.reject(new Error('boom')),
  });
  const router = new BackgroundRouter(deps);
  const port = boundPort(router);

  await router.handleRpc(port, RPC);

  assert.equal(port.sent.length, 1);
  assert.equal(asResult(port.sent[0]).ok, false);
  assert.equal(asResult(port.sent[0]).error?.code, ErrorCode.Disconnected);
  assert.equal(asResult(port.sent[0]).error?.message, 'boom');
});

test('handleRpc forwards a desktop application error verbatim (not Disconnected)', async () => {
  // A desktop-returned error (ok:false, e.g. the user rejected) is NOT a
  // transport failure — it must reach the dApp with its own code, not be
  // rewritten as Disconnected.
  const appError = { code: ErrorCode.UserRejected, message: 'user rejected' };
  const router = new BackgroundRouter({
    send: () =>
      Promise.resolve({
        v: WEB3_PROTOCOL_VERSION,
        iid: 'iid',
        rid: 'rid',
        ok: false,
        error: appError,
      }),
    iid: () => Promise.resolve('the-iid'),
    newRid: () => 'the-rid',
  });
  const port = boundPort(router);

  await router.handleRpc(port, RPC);

  assert.equal(port.sent.length, 1);
  assert.equal(asResult(port.sent[0]).ok, false);
  assert.equal(asResult(port.sent[0]).error?.code, ErrorCode.UserRejected);
  assert.equal(asResult(port.sent[0]).error?.message, 'user rejected');
});

test('handleRpc maps a non-Error throw to a generic transport error', async () => {
  const nonError: unknown = 'a bare string, not an Error';
  const router = new BackgroundRouter({
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the non-Error is the case under test
    send: () => Promise.reject(nonError),
    iid: () => Promise.resolve('the-iid'),
    newRid: () => 'the-rid',
  });
  const port = boundPort(router);

  await router.handleRpc(port, RPC);

  assert.equal(asResult(port.sent[0]).error?.code, ErrorCode.Disconnected);
  assert.equal(asResult(port.sent[0]).error?.message, 'transport error');
});

test('handleRpc answers a desktop 4100 to the requesting port only, never as a push', async () => {
  // A page's providers forget their cached accounts when their own request comes
  // back Unauthorized (the desktop no longer grants that origin). The refusal is
  // a REPLY, correlated by the request id — it must not reach another origin's
  // page, nor another tab of the same origin, which learns from its own requests.
  const router = new BackgroundRouter({
    send: () =>
      Promise.resolve({
        v: WEB3_PROTOCOL_VERSION,
        iid: 'iid',
        rid: 'rid',
        ok: false,
        error: {
          code: ErrorCode.Unauthorized,
          message: 'origin is not connected for this chain',
        },
      }),
    iid: () => Promise.resolve('the-iid'),
    newRid: () => 'the-rid',
  });
  const requester = new StubPort();
  const otherOrigin = new StubPort();
  const sameOriginOtherTab = new StubPort();
  bindPort(router, requester, RPC.origin);
  bindPort(router, otherOrigin, 'https://other.example');
  bindPort(router, sameOriginOtherTab, RPC.origin);

  await router.handleRpc(requester, RPC);

  assert.equal(requester.sent.length, 1);
  assert.equal(asResult(requester.sent[0]).kind, 'rpc-result');
  assert.equal(asResult(requester.sent[0]).id, RPC.id);
  assert.equal(asResult(requester.sent[0]).error?.code, ErrorCode.Unauthorized);
  assert.equal(otherOrigin.sent.length, 0);
  assert.equal(sameOriginOtherTab.sent.length, 0);
});

// ── the SW re-checks what the content script relays ──────────────────────────
// The content script refuses these already; the SW refuses them again, so a
// frame the desktop cannot parse never reaches the socket whichever path brought
// it in.

test('handleRpc refuses a non-string chain or a bad method, without a round-trip', async () => {
  const bad: Array<Record<string, unknown>> = [
    { chain: 1 },
    { chain: null },
    { method: '' },
    { method: 7 },
    { method: 'm'.repeat(129) },
    { id: 'i'.repeat(129) },
  ];
  for (const fields of bad) {
    const { deps, sent } = makeDeps();
    const router = new BackgroundRouter(deps);
    const port = boundPort(router);

    await router.handleRpc(port, { ...RPC, ...fields });

    assert.equal(sent.length, 0, JSON.stringify(fields));
    assert.equal(port.sent.length, 1);
    assert.equal(asResult(port.sent[0]).ok, false);
    assert.equal(asResult(port.sent[0]).id, fields.id ?? RPC.id);
    assert.equal(
      asResult(port.sent[0]).error?.code,
      ErrorCode.MalformedRequest
    );
  }
});

test('handleRpc drops a frame with no string id: nothing to answer, nothing sent', async () => {
  for (const id of [undefined, 1, null]) {
    const { deps, sent } = makeDeps();
    const router = new BackgroundRouter(deps);
    const port = boundPort(router);

    await router.handleRpc(port, { ...RPC, id } as unknown as PortRequest);

    assert.equal(sent.length, 0);
    assert.equal(port.sent.length, 0);
  }
});

// ── the origin comes from the browser, not from the frame ────────────────────
// A renderer compromised on one site can write any origin into the frames its
// content script sends. The port's origin is the one the browser attests for its
// sender; the hello and every request must name it, or they are refused.

test('openPort refuses a sender that is not a content script in a top frame', () => {
  const senders: Array<SenderLike | undefined> = [
    undefined,
    { frameId: 0, url: 'https://a.example/', origin: 'https://a.example' },
    {
      tab: { id: 7 },
      frameId: 3,
      url: 'https://a.example/',
      origin: 'https://a.example',
    },
    { tab: { id: 7 }, url: 'https://a.example/', origin: 'https://a.example' },
    { tab: { id: 7 }, frameId: 0 },
  ];
  for (const sender of senders) {
    const { deps } = makeDeps();
    const router = new BackgroundRouter(deps);
    const port = new StubPort();
    assert.equal(router.openPort(port, sender), false, JSON.stringify(sender));
    // Nothing it says afterwards binds it.
    assert.equal(
      router.handleHello(port, { kind: 'hello', origin: 'https://a.example' }),
      false
    );
    router.routeEvent(pushEvent('https://a.example'));
    assert.equal(port.sent.length, 0);
  }
});

test('a hello naming another origin than the sender is refused and binds nothing', async () => {
  const { deps, sent } = makeDeps();
  const router = new BackgroundRouter(deps);
  const port = new StubPort();
  assert.equal(
    router.openPort(port, topFrameSender('https://evil.example')),
    true
  );

  assert.equal(
    router.handleHello(port, { kind: 'hello', origin: 'https://bank.example' }),
    false
  );

  // Neither origin's push reaches it.
  router.routeEvent(pushEvent('https://bank.example'));
  router.routeEvent(pushEvent('https://evil.example'));
  assert.equal(port.sent.length, 0);
  // Nor does a request on it reach the desktop.
  await router.handleRpc(port, { ...RPC, origin: 'https://bank.example' });
  assert.equal(sent.length, 0);
  assert.equal(port.sent.length, 1);
  assert.equal(asResult(port.sent[0]).id, RPC.id);
  assert.equal(asResult(port.sent[0]).error?.code, ErrorCode.MalformedRequest);
});

test('a hello that is not an object with a string origin is refused', () => {
  for (const hello of [{ kind: 'hello' }, { kind: 'hello', origin: 7 }, null]) {
    const { deps } = makeDeps();
    const router = new BackgroundRouter(deps);
    const port = new StubPort();
    router.openPort(port, topFrameSender('https://a.example'));
    assert.equal(
      router.handleHello(port, hello as unknown as PortHello),
      false,
      JSON.stringify(hello)
    );
  }
});

test('a request on a port that has not said hello is refused without a round-trip', async () => {
  const { deps, sent } = makeDeps();
  const router = new BackgroundRouter(deps);
  const port = new StubPort();
  router.openPort(port, topFrameSender(RPC.origin));

  await router.handleRpc(port, RPC);

  assert.equal(sent.length, 0);
  assert.equal(port.sent.length, 1);
  assert.equal(asResult(port.sent[0]).ok, false);
  assert.equal(asResult(port.sent[0]).error?.code, ErrorCode.MalformedRequest);
});

test('a request naming another origin than its port is refused without a round-trip', async () => {
  // The bound page is evil.example; its renderer writes a granted origin into
  // the request to act as that site.
  const { deps, sent } = makeDeps();
  const router = new BackgroundRouter(deps);
  const port = boundPort(router, 'https://evil.example');

  await router.handleRpc(port, { ...RPC, origin: 'https://bank.example' });

  assert.equal(sent.length, 0);
  assert.equal(port.sent.length, 1);
  assert.equal(asResult(port.sent[0]).id, RPC.id);
  assert.equal(asResult(port.sent[0]).ok, false);
  assert.equal(asResult(port.sent[0]).error?.code, ErrorCode.MalformedRequest);
});

test('a port whose sender has only a URL (Firefox) is bound to that URL origin', async () => {
  const { deps, sent } = makeDeps();
  const router = new BackgroundRouter(deps);
  const port = new StubPort();
  assert.equal(
    router.openPort(port, {
      tab: { id: 2 },
      frameId: 0,
      url: 'https://app.example:443/swap?x=1#y',
    }),
    true
  );
  assert.equal(
    router.handleHello(port, { kind: 'hello', origin: 'https://app.example' }),
    true
  );

  await router.handleRpc(port, RPC);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].origin, 'https://app.example');
});

test('dropPort forgets the attested origin too: a later hello binds nothing', () => {
  const { deps } = makeDeps();
  const router = new BackgroundRouter(deps);
  const port = new StubPort();
  router.openPort(port, topFrameSender('https://a.example'));
  router.dropPort(port);
  assert.equal(
    router.handleHello(port, { kind: 'hello', origin: 'https://a.example' }),
    false
  );
});
