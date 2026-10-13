import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  PAIRING_KEY_DISTRUSTED_MESSAGE,
  PAIRING_NEEDED_MESSAGE,
  SocketAuth,
  WsClient,
  keepsWorkerAwake,
  opensPairing,
} from '../src/transport/ws_client';
import { importAuthKey } from '../src/transport/auth_handshake';
import { keyFingerprint } from '../src/transport/key_fingerprint';
import { PairingPromptGate } from '../src/background/pairing_prompt';
import { BackgroundRouter } from '../src/background/background_router';
import { OutboundFrame, PortPoster } from '../src/background/post_to_port';
import { PortRequest, PortResult } from '../src/protocol/bridge';
import {
  ErrorCode,
  Namespace,
  Response,
  WEB3_PROTOCOL_VERSION,
  isAuthRequiredAt,
  makeRequest,
} from '../src/protocol/envelope';

// A minimal stand-in for the browser WebSocket so WsClient can be driven in node:
// the test opens the socket, answers the sys_ping handshake, then injects frames.
class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }
  removeEventListener(type: string, cb: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(cb);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatch('close', {});
  }
  private dispatch(type: string, ev: unknown): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) {
      cb(ev);
    }
  }

  // Test controls.
  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.dispatch('open', {});
  }
  // What loopback does when nothing is listening: the connect is refused, the
  // browser fires `error` (and logs ERR_CONNECTION_REFUSED where we cannot
  // reach it) and the socket never opens.
  emitRefused(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatch('error', {});
  }
  emitMessage(data: string): void {
    this.dispatch('message', { data });
  }
  sentFrames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const IID = '00000000-0000-4000-8000-000000000abc'; // 36-char placeholder
// The throwaway iid every discovery probe carries instead of the real one.
const PROBE_IID = '00000000-0000-0000-0000-000000000000';
const isProbe = (ws: MockWebSocket): boolean =>
  ws.url.endsWith(`iid=${PROBE_IID}`);

const flush = async (): Promise<void> => {
  // Drain the connect → open → send microtask chain (a couple of macrotasks).
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

function responseFrame(rid: string, ok: boolean, extra: object): string {
  return JSON.stringify({
    v: WEB3_PROTOCOL_VERSION,
    iid: IID,
    rid,
    ok,
    ...extra,
  });
}

const lastSocket = (): MockWebSocket =>
  MockWebSocket.instances[MockWebSocket.instances.length - 1];

// Answer a discovery probe as the desktop does: open, then a sys_ping reply that
// carries a protocol version.
function serveProbe(ws: MockWebSocket): void {
  assert.ok(isProbe(ws), 'the socket is a probe');
  ws.emitOpen();
  const ping = ws.sentFrames().find((f) => f.method === 'sys_ping');
  assert.ok(ping, 'the probe sent a sys_ping');
  ws.emitMessage(
    responseFrame(ping.rid as string, true, {
      result: { protocol_version: WEB3_PROTOCOL_VERSION },
    })
  );
}

// Bring a single-port (Manual) client's connect up: the probe the client opens
// first is verified, then the real socket it opens next is opened and returned.
async function openManualSocket(): Promise<MockWebSocket> {
  await flush();
  serveProbe(lastSocket());
  await flush();
  const ws = lastSocket();
  assert.ok(!isProbe(ws), 'the verified port got the real socket');
  ws.emitOpen(); // resolves the connect; openOnce fires a sys_ping; send writes the frame
  await flush();
  return ws;
}

// Bring a WsClient up against a MockWebSocket and answer the sys_ping handshake,
// leaving exactly the caller's dApp request in flight.
async function connectAndSysPing(): Promise<{
  ws: MockWebSocket;
  reqP: Promise<Response>;
}> {
  MockWebSocket.instances = [];
  const client = new WsClient(IID, [8114]); // single port → Manual
  const reqP = client.send(
    makeRequest(IID, 'rid-dapp', 'evm', 'https://a.app', 'eth_requestAccounts')
  );
  const ws = await openManualSocket();

  // Answer the sys_ping so it leaves the pending map — the dApp request is then
  // the only thing in flight, so whatever settles it is unambiguous.
  const ping = ws.sentFrames().find((f) => f.method === 'sys_ping');
  assert.ok(ping, 'a sys_ping handshake was sent on connect');
  ws.emitMessage(
    responseFrame(ping.rid as string, true, {
      result: {
        wallet_status: 'unlocked',
        protocol_version: WEB3_PROTOCOL_VERSION,
      },
    })
  );
  await flush();
  return { ws, reqP };
}

test('an empty-rid error settles nothing: the in-flight request still settles by its own rid', async () => {
  const saved = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = MockWebSocket;
  try {
    const { ws, reqP } = await connectAndSysPing();
    let settled = false;
    void reqP.then(
      () => (settled = true),
      () => (settled = true)
    );

    // The desktop could not parse SOME frame and answered without a rid. Nothing
    // says which request that frame was, so it must not settle one: the request
    // in flight may be another page's, waiting on the person's confirmation.
    ws.emitMessage(
      responseFrame('', false, {
        error: { code: 1100, message: 'malformed frame: bad json' },
      })
    );
    await flush();
    assert.equal(settled, false);

    ws.emitMessage(responseFrame('rid-dapp', true, { result: ['0xabc'] }));
    const resp = await reqP;
    assert.equal(resp.ok, true);
    assert.deepEqual(resp.result, ['0xabc']);
  } finally {
    (globalThis as { WebSocket?: unknown }).WebSocket = saved;
  }
});

test('a reply to an in-flight rid that fails the frame guard rejects that request', async () => {
  const saved = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = MockWebSocket;
  try {
    const { ws, reqP } = await connectAndSysPing();
    // `"false"` is truthy: passed on, it would read as a success.
    ws.emitMessage(
      JSON.stringify({
        v: WEB3_PROTOCOL_VERSION,
        iid: IID,
        rid: 'rid-dapp',
        ok: 'false',
        result: ['0xabc'],
      })
    );
    // Settled at once, not at the request timeout.
    let failure: unknown;
    reqP.catch((e: unknown) => {
      failure = e;
    });
    await flush();
    assert.ok(failure instanceof Error, 'the request was rejected');
    assert.match(failure.message, /malformed/);
  } finally {
    for (const ws of MockWebSocket.instances) {
      ws.close();
    }
    (globalThis as { WebSocket?: unknown }).WebSocket = saved;
  }
});

test('an unknown NON-empty rid is ignored (a stale/duplicate reply does not fail a request)', async () => {
  const saved = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = MockWebSocket;
  try {
    const { ws, reqP } = await connectAndSysPing();

    // A reply for a rid nobody is waiting on (already settled / duplicate) must be
    // dropped — it must NOT settle the still-pending dApp request.
    ws.emitMessage(
      responseFrame('rid-nobody', false, {
        error: { code: 1102, message: 'stale' },
      })
    );
    await flush();

    // The dApp request is still pending; answer it properly and confirm it is the
    // one that settles (the stale reply did not touch it).
    ws.emitMessage(responseFrame('rid-dapp', true, { result: ['0xabc'] }));
    const resp = await reqP;
    assert.equal(resp.ok, true);
    assert.deepEqual(resp.result, ['0xabc']);
  } finally {
    (globalThis as { WebSocket?: unknown }).WebSocket = saved;
  }
});

test('the handshake on a new socket reports the desktop session it names', async () => {
  // Every new socket sys_pings, so a desktop that restarted is seen at the first
  // socket that reaches it, not a heartbeat later.
  const saved = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = MockWebSocket;
  try {
    MockWebSocket.instances = [];
    const sessions: (string | undefined)[] = [];
    const client = new WsClient(IID, [8114], (connected, _s, _v, session) => {
      if (connected) sessions.push(session);
    });
    const reqP = client.send(
      makeRequest(
        IID,
        'rid-dapp',
        'evm',
        'https://a.app',
        'eth_requestAccounts'
      )
    );
    const ws = await openManualSocket();
    const ping = ws.sentFrames().find((f) => f.method === 'sys_ping');
    assert.ok(ping, 'a sys_ping handshake was sent on connect');
    const session = 'fe'.repeat(16);
    ws.emitMessage(
      responseFrame(ping.rid as string, true, {
        result: {
          wallet_status: 'unlocked',
          protocol_version: WEB3_PROTOCOL_VERSION,
          desktop_session: session,
        },
      })
    );
    await flush();
    assert.deepEqual(sessions, [session]);
    // Settle the dApp request, so nothing is left pending behind the case.
    ws.emitMessage(responseFrame('rid-dapp', true, { result: ['0xabc'] }));
    await reqP;
  } finally {
    (globalThis as { WebSocket?: unknown }).WebSocket = saved;
  }
});

test('a heartbeat against an absent desktop opens ONE socket per candidate port', async () => {
  const saved = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = MockWebSocket;
  try {
    MockWebSocket.instances = [];
    const statuses: boolean[] = [];
    // Two ports → the Auto discovery scan, which probes them in order.
    const client = new WsClient(IID, [8114, 8274], (c) => statuses.push(c));
    const pinged = client.ping();

    // Refuse every socket the client opens, as loopback does with no desktop
    // running, until the ping gives up.
    const refused = new Set<MockWebSocket>();
    for (let i = 0; i < 8; i++) {
      await flush();
      for (const ws of MockWebSocket.instances) {
        if (!refused.has(ws)) {
          refused.add(ws);
          ws.emitRefused();
        }
      }
    }
    await pinged;

    // The heartbeat spends ONE connect pass: two probes, one per candidate. A
    // retry loop here would open eight sockets — eight console errors a tick,
    // every tick, for a desktop the user simply has not started.
    assert.equal(MockWebSocket.instances.length, 2);
    assert.ok(statuses.length > 0);
    assert.ok(statuses.every((c) => c === false));
  } finally {
    (globalThis as { WebSocket?: unknown }).WebSocket = saved;
  }
});

test('a dApp request keeps its retry budget, and raises a heartbeat pass it joins', async () => {
  const saved = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = MockWebSocket;
  try {
    MockWebSocket.instances = [];
    const client = new WsClient(IID, [8114]); // Manual: one pinned port
    // The heartbeat starts a single-pass connect; the dApp request joins that
    // same pass and must lift it to the full retry sequence, rather than inherit
    // the heartbeat's one-shot budget and fail with it.
    const pinged = client.ping();
    const reqP = client.send(
      makeRequest(
        IID,
        'rid-dapp',
        'evm',
        'https://a.app',
        'eth_requestAccounts'
      )
    );

    // Refuse the first connect, then let the desktop finish binding. With a
    // one-shot budget there would never be a second socket to open.
    const refused = new Set<MockWebSocket>();
    let opened: MockWebSocket | null = null;
    for (let i = 0; i < 60 && !opened; i++) {
      await new Promise((r) => setTimeout(r, 20)); // outlast the 200ms backoff
      for (const ws of MockWebSocket.instances) {
        if (refused.has(ws)) {
          continue;
        }
        refused.add(ws);
        if (refused.size === 1) {
          ws.emitRefused();
        } else if (isProbe(ws)) {
          serveProbe(ws);
        } else {
          opened = ws;
          ws.emitOpen();
        }
      }
    }
    assert.ok(opened, 'the retried connect reached an open socket');
    await flush();

    // Answer every sys_ping (the heartbeat's, and the one openOnce fires) so
    // nothing is left pending, then the dApp request itself.
    for (const frame of opened.sentFrames()) {
      if (frame.method === 'sys_ping') {
        opened.emitMessage(
          responseFrame(frame.rid as string, true, {
            result: {
              wallet_status: 'unlocked',
              protocol_version: WEB3_PROTOCOL_VERSION,
            },
          })
        );
      }
    }
    await pinged; // the heartbeat settled on the retried connect, not on failure

    opened.emitMessage(responseFrame('rid-dapp', true, { result: ['0xabc'] }));
    const resp = await reqP;
    assert.equal(resp.ok, true);
  } finally {
    (globalThis as { WebSocket?: unknown }).WebSocket = saved;
  }
});

// ── the desktop's held sessions (sys_resume) ─────────────────────────────────
// The desktop holds an instance's dApp sessions when its socket closes and gives
// them back only to a socket whose FIRST frame presents the secret the previous
// one was handed. These cases pin the extension's half: the frame order, what is
// presented and kept, and when the pages are told to forget their accounts.

const SECRET_A = 'a'.repeat(64);
const SECRET_B = 'b'.repeat(64);

type ResumeProbe = {
  stored: string | undefined;
  saved: string[];
  lost: number;
};

function resumeStoreFor(probe: ResumeProbe) {
  return {
    load: () => Promise.resolve(probe.stored),
    save: (secret: string) => {
      probe.saved.push(secret);
      probe.stored = secret;
      return Promise.resolve();
    },
    lost: () => {
      probe.lost += 1;
    },
  };
}

// Open a client with `probe` as its resume store and a dApp request queued
// before the socket opened; return the socket once the open has been handled.
async function openWithResume(
  probe: ResumeProbe | undefined
): Promise<{ ws: MockWebSocket; reqP: Promise<Response> }> {
  MockWebSocket.instances = [];
  const client = new WsClient(
    IID,
    [8114],
    undefined,
    undefined,
    probe ? resumeStoreFor(probe) : undefined
  );
  const reqP = client.send(
    makeRequest(IID, 'rid-dapp', 'evm', 'https://a.app', 'eth_requestAccounts')
  );
  // Closed unanswered at the end of the case (withMockSocket), which rejects it.
  reqP.catch(() => undefined);
  const ws = await openManualSocket();
  return { ws, reqP };
}

async function answerResume(ws: MockWebSocket, extra: object): Promise<void> {
  const resume = ws.sentFrames().find((f) => f.method === 'sys_resume');
  assert.ok(resume, 'a sys_resume was sent');
  ws.emitMessage(responseFrame(resume.rid as string, true, extra));
  await flush();
}

async function withMockSocket(body: () => Promise<void>): Promise<void> {
  const saved = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = MockWebSocket;
  try {
    await body();
  } finally {
    // Closing settles what is still in flight and clears its timers, or the
    // queued request's 5-minute backstop would hold the test process open.
    for (const ws of MockWebSocket.instances) {
      ws.close();
    }
    (globalThis as { WebSocket?: unknown }).WebSocket = saved;
  }
}

test('sys_resume is the FIRST frame of a socket, before a queued dApp request, and presents the kept secret', async () => {
  await withMockSocket(async () => {
    const probe: ResumeProbe = { stored: SECRET_A, saved: [], lost: 0 };
    const { ws } = await openWithResume(probe);
    const frames = ws.sentFrames();
    assert.equal(frames[0]?.method, 'sys_resume');
    assert.equal(frames[0]?.ns, 'sys');
    assert.deepEqual(frames[0]?.params, { resume: SECRET_A });
    const dapp = frames.findIndex((f) => f.rid === 'rid-dapp');
    assert.ok(dapp > 0, 'the queued request follows the resume');
  });
});

test('a socket with no kept secret asks to resume with none', async () => {
  await withMockSocket(async () => {
    const probe: ResumeProbe = { stored: undefined, saved: [], lost: 0 };
    const { ws } = await openWithResume(probe);
    assert.equal(ws.sentFrames()[0]?.method, 'sys_resume');
    assert.deepEqual(ws.sentFrames()[0]?.params, {});
    await answerResume(ws, { result: { resume: SECRET_B, restored: false } });
    assert.deepEqual(probe.saved, [SECRET_B]);
    assert.equal(probe.lost, 0, 'nothing was held, nothing is lost');
  });
});

test('a restored resume keeps the NEXT secret and forgets nothing', async () => {
  await withMockSocket(async () => {
    const probe: ResumeProbe = { stored: SECRET_A, saved: [], lost: 0 };
    const { ws } = await openWithResume(probe);
    await answerResume(ws, { result: { resume: SECRET_B, restored: true } });
    assert.deepEqual(probe.saved, [SECRET_B]);
    assert.equal(probe.stored, SECRET_B);
    assert.equal(probe.lost, 0);
  });
});

test('a presented secret that did not restore: the new one is kept and the pages forget their accounts', async () => {
  await withMockSocket(async () => {
    const probe: ResumeProbe = { stored: SECRET_A, saved: [], lost: 0 };
    const { ws } = await openWithResume(probe);
    await answerResume(ws, { result: { resume: SECRET_B, restored: false } });
    assert.deepEqual(probe.saved, [SECRET_B]);
    assert.equal(probe.lost, 1);
  });
});

test('an older desktop (UnsupportedMethod) or a malformed answer changes nothing', async () => {
  await withMockSocket(async () => {
    const probe: ResumeProbe = { stored: SECRET_A, saved: [], lost: 0 };
    const { ws } = await openWithResume(probe);
    const resume = ws.sentFrames().find((f) => f.method === 'sys_resume');
    assert.ok(resume);
    ws.emitMessage(
      responseFrame(resume.rid as string, false, {
        error: { code: 1104, message: "unknown sys method 'sys_resume'" },
      })
    );
    await flush();
    assert.deepEqual(probe.saved, []);
    assert.equal(probe.lost, 0);
  });
  await withMockSocket(async () => {
    const probe: ResumeProbe = { stored: SECRET_A, saved: [], lost: 0 };
    const { ws } = await openWithResume(probe);
    await answerResume(ws, { result: { resume: 'short', restored: false } });
    assert.deepEqual(probe.saved, []);
    assert.equal(probe.lost, 0);
  });
});

test('a client with no resume store sends no sys_resume', async () => {
  await withMockSocket(async () => {
    const { ws } = await openWithResume(undefined);
    assert.ok(!ws.sentFrames().some((f) => f.method === 'sys_resume'));
  });
});

// ── Manual mode probes its pinned port too ───────────────────────────────────
// The real iid opens the desktop's held sessions and rides every frame, so it
// goes only to a port that has answered a probe as the wallet.

test('a Manual port is probed with the throwaway iid before the real one is sent', async () => {
  await withMockSocket(async () => {
    MockWebSocket.instances = [];
    const client = new WsClient(IID, [8114]);
    const reqP = client.send(
      makeRequest(IID, 'rid-dapp', 'evm', 'https://a.app', 'eth_chainId')
    );
    reqP.catch(() => undefined);
    await flush();
    assert.equal(MockWebSocket.instances.length, 1);
    assert.ok(isProbe(MockWebSocket.instances[0]), 'the first socket probes');
    assert.equal(client.currentPort, null, 'unverified, so not yet in use');
  });
});

test('a Manual port where something else listens never receives the real iid', async () => {
  await withMockSocket(async () => {
    MockWebSocket.instances = [];
    const client = new WsClient(IID, [8114]);
    const reqP = client.send(
      makeRequest(IID, 'rid-dapp', 'evm', 'https://a.app', 'eth_chainId')
    );
    let failed = false;
    reqP.catch(() => (failed = true));
    // Every socket opens and answers its sys_ping with something that is not
    // the wallet's reply: no protocol version.
    const served = new Set<MockWebSocket>();
    for (let i = 0; i < 400 && !failed; i++) {
      await new Promise((r) => setTimeout(r, 10)); // outlast the backoff
      for (const ws of MockWebSocket.instances) {
        if (served.has(ws)) {
          continue;
        }
        served.add(ws);
        ws.emitOpen();
        for (const f of ws.sentFrames()) {
          ws.emitMessage(responseFrame(f.rid as string, true, { result: {} }));
        }
      }
    }
    assert.ok(failed, 'the request failed instead of reaching the listener');
    assert.ok(MockWebSocket.instances.length > 0);
    for (const ws of MockWebSocket.instances) {
      assert.ok(isProbe(ws), `no socket carried the real iid: ${ws.url}`);
      assert.ok(
        ws.sentFrames().every((f) => f.iid === PROBE_IID),
        'no frame carried the real iid'
      );
    }
  });
});

test('a Manual heartbeat against an absent desktop opens ONE socket, a probe', async () => {
  await withMockSocket(async () => {
    MockWebSocket.instances = [];
    const client = new WsClient(IID, [8114]);
    const pinged = client.ping();
    for (let i = 0; i < 4; i++) {
      await flush();
      for (const ws of MockWebSocket.instances) {
        if (ws.readyState !== MockWebSocket.CLOSED) {
          ws.emitRefused();
        }
      }
    }
    await pinged;
    assert.equal(MockWebSocket.instances.length, 1);
    assert.ok(isProbe(MockWebSocket.instances[0]));
  });
});

// ── one page's malformed frame cannot settle another page's request ─────────
// The SW router over the real transport, with a desktop that answers a frame it
// cannot parse the way it does: an error with an empty rid.

class RecordingPort implements PortPoster {
  readonly sent: OutboundFrame[] = [];
  postMessage(frame: OutboundFrame): void {
    this.sent.push(frame);
  }
}

test('a page frame with a numeric chain does not settle another port request', async () => {
  await withMockSocket(async () => {
    MockWebSocket.instances = [];
    const client = new WsClient(IID, [8114]);
    let n = 0;
    const router = new BackgroundRouter({
      send: (wire) => client.send(wire),
      iid: () => Promise.resolve(IID),
      newRid: () => `rid-${++n}`,
    });
    const tabA = new RecordingPort();
    const tabB = new RecordingPort();
    for (const [port, origin] of [
      [tabA, 'https://a.example'],
      [tabB, 'https://b.example'],
    ] as const) {
      router.openPort(port, { tab: { id: 1 }, frameId: 0, origin });
      router.handleHello(port, { kind: 'hello', origin });
    }
    const tx: PortRequest = {
      kind: 'rpc',
      id: 'a-1',
      ns: 'evm',
      origin: 'https://a.example',
      method: 'eth_sendTransaction',
      params: [{ to: '0x1' }],
      chain: 'nt:evm:ci:1',
    };
    const aDone = router.handleRpc(tabA, tx);
    const ws = await openManualSocket();
    for (const f of ws.sentFrames()) {
      if (f.method === 'sys_ping') {
        ws.emitMessage(
          responseFrame(f.rid as string, true, {
            result: { protocol_version: WEB3_PROTOCOL_VERSION },
          })
        );
      }
    }
    await flush();
    assert.ok(
      ws.sentFrames().some((f) => f.method === 'eth_sendTransaction'),
      'tab A is waiting on the desktop'
    );

    // Tab B's page posts a frame whose chain is a number.
    const bDone = router.handleRpc(tabB, {
      kind: 'rpc',
      id: 'b-1',
      ns: 'evm',
      origin: 'https://b.example',
      method: 'eth_chainId',
      chain: 1,
    } as unknown as PortRequest);
    await flush();
    // The desktop answers whatever it could not parse with an empty rid.
    for (const f of ws.sentFrames()) {
      if ('chain' in f && typeof f.chain !== 'string') {
        ws.emitMessage(
          responseFrame('', false, {
            error: { code: 1100, message: 'malformed frame' },
          })
        );
      }
    }
    // Not awaited: a frame that got through would leave tab B waiting on the
    // request timeout, and the assertions below must say so at once.
    void bDone;
    await flush();

    assert.equal(tabA.sent.length, 0, 'tab A is still waiting');
    assert.equal(tabB.sent.length, 1);
    const b = tabB.sent[0] as PortResult;
    assert.equal(b.id, 'b-1');
    assert.equal(b.error?.code, ErrorCode.MalformedRequest);

    // Tab A settles on its own reply.
    const aFrame = ws
      .sentFrames()
      .find((f) => f.method === 'eth_sendTransaction');
    ws.emitMessage(
      responseFrame(aFrame?.rid as string, true, { result: '0xh' })
    );
    await aDone;
    assert.equal((tabA.sent[0] as PortResult).ok, true);
    assert.equal((tabA.sent[0] as PortResult).result, '0xh');
  });
});

test('exchange answers with the port the frame went out on', async () => {
  await withMockSocket(async () => {
    MockWebSocket.instances = [];
    const client = new WsClient(IID, [18114]); // single port → Manual
    const reqP = client.exchange(
      makeRequest(IID, 'rid-pair', 'sys', '', 'sys_pair_begin', {})
    );
    const ws = await openManualSocket();
    assert.ok(ws.url.startsWith('ws://127.0.0.1:18114/'));
    const ping = ws.sentFrames().find((f) => f.method === 'sys_ping');
    assert.ok(ping);
    ws.emitMessage(
      responseFrame(ping.rid as string, true, {
        result: { protocol_version: WEB3_PROTOCOL_VERSION },
      })
    );
    ws.emitMessage(responseFrame('rid-pair', true, { result: {} }));
    const { response, port } = await reqP;
    assert.equal(response.rid, 'rid-pair');
    assert.equal(port, 18114);
  });
});

test('a pairing frame keeps the worker awake while the person reads the code; other sys frames do not', () => {
  const frame = (ns: 'sys' | 'evm', method: string) =>
    makeRequest(IID, 'r', ns, '', method);
  assert.equal(keepsWorkerAwake(frame('sys', 'sys_pair_begin')), true);
  assert.equal(keepsWorkerAwake(frame('sys', 'sys_pair_finish')), true);
  assert.equal(keepsWorkerAwake(frame('evm', 'eth_requestAccounts')), true);
  assert.equal(keepsWorkerAwake(frame('sys', 'sys_ping')), false);
  assert.equal(keepsWorkerAwake(frame('sys', 'sys_resume')), false);
});

// ── the socket handshake (sys_auth_begin / sys_auth_finish) ──────────────────
// With a pairing key, a socket is bound (sys_resume, then dApp frames) only after
// it authenticated; the desktop's proof is checked before ours goes out. These
// cases run the desktop's first known-answer vector over the mock socket.

const AUTH_KAT = (
  JSON.parse(
    fs.readFileSync(
      path.join(__dirname, 'testdata', 'auth_handshake_vectors.json'),
      'utf8'
    )
  ) as {
    vectors: Array<{
      secret: string;
      iid: string;
      client_nonce: string;
      server_nonce: string;
      port: number;
      server_mac: string;
      client_mac: string;
    }>;
  }
).vectors[0];
const AUTH_IID = AUTH_KAT.iid;
const hexBytes = (s: string): Uint8Array =>
  Uint8Array.from(Buffer.from(s, 'hex'));
const hexB64 = (s: string): string => Buffer.from(s, 'hex').toString('base64');
const DAPP = 'https://a.app';

// Wait (in real time: WebCrypto settles off the event loop) until `cond` holds.
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

type AuthProbe = {
  key: CryptoKey | undefined;
  needed: string[];
};

function authFor(probe: AuthProbe, required?: boolean): SocketAuth {
  return {
    loadKey: (iid) => {
      assert.equal(iid, AUTH_IID);
      return Promise.resolve(probe.key);
    },
    pairingNeeded: (origin) => {
      probe.needed.push(origin);
    },
    required,
    nonce: () => hexBytes(AUTH_KAT.client_nonce),
  };
}

const pairedProbe = async (): Promise<AuthProbe> => ({
  key: await importAuthKey(hexBytes(AUTH_KAT.secret)),
  needed: [],
});

function authAnswer(
  rid: string,
  ok: boolean,
  extra: object,
  iid: string = AUTH_IID
): string {
  return JSON.stringify({ v: WEB3_PROTOCOL_VERSION, iid, rid, ok, ...extra });
}

const methods = (ws: MockWebSocket): string[] =>
  ws.sentFrames().map((f) => f.method as string);

const frameOf = (ws: MockWebSocket, method: string) =>
  ws.sentFrames().find((f) => f.method === method);

// A client with `auth` and a resume store, with a dApp request queued before
// the socket opened; returns the socket once it is open.
async function openWithAuth(
  auth: SocketAuth,
  method = 'eth_requestAccounts'
): Promise<{
  client: WsClient;
  ws: MockWebSocket;
  reqP: Promise<Response>;
}> {
  MockWebSocket.instances = [];
  const probe: ResumeProbe = { stored: SECRET_A, saved: [], lost: 0 };
  const client = new WsClient(
    AUTH_IID,
    [AUTH_KAT.port],
    undefined,
    undefined,
    resumeStoreFor(probe),
    auth
  );
  const reqP = client.send(
    makeRequest(AUTH_IID, 'rid-dapp', 'evm', DAPP, method)
  );
  reqP.catch(() => undefined);
  const ws = await openManualSocket();
  return { client, ws, reqP };
}

// Answer the `nth` begin on `ws` as the paired desktop, then the finish it
// brings.
async function serveHandshake(ws: MockWebSocket, nth = 1): Promise<void> {
  const count = (m: string) => methods(ws).filter((x) => x === m).length;
  const finishes = count('sys_auth_finish');
  await until(() => count('sys_auth_begin') >= nth, 'the begin');
  const begin = ws.sentFrames().filter((f) => f.method === 'sys_auth_begin')[
    nth - 1
  ];
  ws.emitMessage(
    authAnswer(begin.rid as string, true, {
      result: {
        ns: hexB64(AUTH_KAT.server_nonce),
        mac: hexB64(AUTH_KAT.server_mac),
      },
    })
  );
  await until(() => count('sys_auth_finish') > finishes, 'the finish');
  const finish = ws.sentFrames().filter((f) => f.method === 'sys_auth_finish')[
    finishes
  ];
  assert.deepEqual(finish.params, { mac: hexB64(AUTH_KAT.client_mac) });
  ws.emitMessage(
    authAnswer(finish.rid as string, true, { result: { authenticated: true } })
  );
}

test('with a pairing key the socket authenticates first, then resumes, then carries the dApp frame', async () => {
  await withMockSocket(async () => {
    const probe = await pairedProbe();
    const { ws } = await openWithAuth(authFor(probe));
    await serveHandshake(ws);
    await until(() => methods(ws).includes('eth_requestAccounts'), 'dApp');
    const order = methods(ws).filter((m) => m !== 'sys_ping');
    assert.deepEqual(order, [
      'sys_auth_begin',
      'sys_auth_finish',
      'sys_resume',
      'eth_requestAccounts',
    ]);
    // The socket's own handshake names no dApp.
    assert.deepEqual(frameOf(ws, 'sys_auth_begin')?.params, {
      nc: hexB64(AUTH_KAT.client_nonce),
    });
    assert.deepEqual(frameOf(ws, 'sys_resume')?.params, { resume: SECRET_A });
    assert.deepEqual(probe.needed, []);
  });
});

test('a desktop proof that does not verify: no proof of ours, nothing bound, the socket closed, the dApp told', async () => {
  await withMockSocket(async () => {
    const probe = await pairedProbe();
    const { ws, reqP } = await openWithAuth(authFor(probe));
    await until(() => methods(ws).includes('sys_auth_begin'), 'the begin');
    const begin = frameOf(ws, 'sys_auth_begin');
    const forged = hexBytes(AUTH_KAT.server_mac);
    forged[0] ^= 0x80;
    ws.emitMessage(
      authAnswer(begin?.rid as string, true, {
        result: {
          ns: hexB64(AUTH_KAT.server_nonce),
          mac: Buffer.from(forged).toString('base64'),
        },
      })
    );
    const resp = await reqP;
    assert.equal(resp.ok, false);
    assert.equal(resp.rid, 'rid-dapp');
    assert.equal(resp.error?.code, ErrorCode.Disconnected);
    assert.match(resp.error?.message ?? '', /could not prove/);
    // The dApp is not told which loopback port the desktop listens on.
    assert.doesNotMatch(resp.error?.message ?? '', /\b\d{2,5}\b/);
    assert.deepEqual(methods(ws), ['sys_auth_begin']);
    assert.equal(ws.readyState, MockWebSocket.CLOSED);
    // Not retried blindly: the probe and the one socket, nothing after.
    await flush();
    assert.equal(MockWebSocket.instances.length, 2);
  });
});

test('after a desktop proof that did not verify the key is not tried again: no handshake, and the dApp is sent to reset the pairing key in Settings', async () => {
  await withMockSocket(async () => {
    const probe = await pairedProbe();
    const marks: string[] = [];
    const auth: SocketAuth = {
      ...authFor(probe),
      keyDistrusted: () => Promise.resolve(false),
      distrustKey: (fingerprint) => {
        marks.push(fingerprint);
        return Promise.resolve();
      },
    };
    const { client, ws, reqP } = await openWithAuth(auth);
    await until(() => methods(ws).includes('sys_auth_begin'), 'the begin');
    const forged = hexBytes(AUTH_KAT.server_mac);
    forged[0] ^= 0x80;
    ws.emitMessage(
      authAnswer(frameOf(ws, 'sys_auth_begin')?.rid as string, true, {
        result: {
          ns: hexB64(AUTH_KAT.server_nonce),
          mac: Buffer.from(forged).toString('base64'),
        },
      })
    );
    const first = await reqP;
    assert.equal(first.error?.code, ErrorCode.Disconnected);
    assert.match(first.error?.message ?? '', /reset .*pairing key.* Settings/);
    // Filed under the key's fingerprint, never the key or the instance.
    assert.deepEqual(marks, [await keyFingerprint(probe.key as CryptoKey)]);
    // The next request opens a new socket and begins nothing on it.
    const again = client.send(
      makeRequest(AUTH_IID, 'rid-again', 'evm', DAPP, 'eth_requestAccounts')
    );
    await flush();
    if (isProbe(lastSocket())) {
      serveProbe(lastSocket());
      await flush();
    }
    const next = lastSocket();
    assert.notEqual(next, ws);
    assert.ok(!isProbe(next));
    next.emitOpen();
    const resp = await again;
    assert.equal(resp.error?.code, ErrorCode.Disconnected);
    assert.equal(resp.error?.message, PAIRING_KEY_DISTRUSTED_MESSAGE);
    assert.deepEqual(
      methods(next).filter((m) => m !== 'sys_ping'),
      []
    );
    assert.deepEqual(probe.needed, []);
    // A pairing by code stores a new key, which no record names: the same
    // socket offers it to a handshake. Nothing is written to lift the record.
    probe.key = await importAuthKey(new Uint8Array(32).fill(7));
    client.afterPairing();
    await until(() => methods(next).includes('sys_auth_begin'), 'the begin');
    assert.equal(marks.length, 1);
  });
});

test('a key that failed a proof stays withheld when the same secret is read back as a new key object', async () => {
  await withMockSocket(async () => {
    const probe = await pairedProbe();
    const auth: SocketAuth = {
      ...authFor(probe),
      keyDistrusted: () => Promise.resolve(false),
      distrustKey: () => Promise.resolve(),
    };
    const { client, ws, reqP } = await openWithAuth(auth);
    await until(() => methods(ws).includes('sys_auth_begin'), 'the begin');
    const forged = hexBytes(AUTH_KAT.server_mac);
    forged[0] ^= 0x80;
    ws.emitMessage(
      authAnswer(frameOf(ws, 'sys_auth_begin')?.rid as string, true, {
        result: {
          ns: hexB64(AUTH_KAT.server_nonce),
          mac: Buffer.from(forged).toString('base64'),
        },
      })
    );
    await reqP;
    // IndexedDB hands back a new CryptoKey object on every read.
    probe.key = (await pairedProbe()).key;
    const again = client.send(
      makeRequest(AUTH_IID, 'rid-again', 'evm', DAPP, 'eth_requestAccounts')
    );
    await flush();
    if (isProbe(lastSocket())) {
      serveProbe(lastSocket());
      await flush();
    }
    lastSocket().emitOpen();
    const resp = await again;
    assert.equal(resp.error?.message, PAIRING_KEY_DISTRUSTED_MESSAGE);
    assert.ok(!methods(lastSocket()).includes('sys_auth_begin'));
  });
});

test('a key distrusted before this worker started is not tried either', async () => {
  await withMockSocket(async () => {
    const probe = await pairedProbe();
    const fingerprint = await keyFingerprint(probe.key as CryptoKey);
    const { ws, reqP } = await openWithAuth({
      ...authFor(probe),
      keyDistrusted: (fp) => Promise.resolve(fp === fingerprint),
      distrustKey: () => Promise.resolve(),
    });
    const resp = await reqP;
    assert.equal(resp.error?.code, ErrorCode.Disconnected);
    assert.equal(resp.error?.message, PAIRING_KEY_DISTRUSTED_MESSAGE);
    assert.deepEqual(
      methods(ws).filter((m) => m !== 'sys_ping'),
      []
    );
  });
});

test('locked at connect: the socket stays unbound, and the dApp’s request begins again naming it', async () => {
  await withMockSocket(async () => {
    const probe = await pairedProbe();
    const { ws, reqP } = await openWithAuth(authFor(probe));
    await until(() => methods(ws).includes('sys_auth_begin'), 'the begin');
    ws.emitMessage(
      authAnswer(frameOf(ws, 'sys_auth_begin')?.rid as string, false, {
        error: { code: ErrorCode.WalletLocked, message: 'locked' },
      })
    );
    await serveHandshake(ws, 2);
    const begins = ws.sentFrames().filter((f) => f.method === 'sys_auth_begin');
    assert.equal(
      (begins[0].params as { origin?: string }).origin !== undefined,
      false
    );
    assert.equal((begins[1].params as { origin?: string }).origin, DAPP);
    await until(() => methods(ws).includes('eth_requestAccounts'), 'dApp');
    const order = methods(ws).filter((m) => m !== 'sys_ping');
    assert.deepEqual(order.slice(-2), ['sys_resume', 'eth_requestAccounts']);
    assert.equal(order.indexOf('sys_resume'), order.length - 2);
    ws.emitMessage(authAnswer('rid-dapp', true, { result: ['0x1'] }));
    assert.equal((await reqP).ok, true);
  });
});

test('locked at connect, then a dApp’s begin answered with a proof that does not verify: the dApp hears a disconnect, not 4100', async () => {
  await withMockSocket(async () => {
    const probe = await pairedProbe();
    const { ws, reqP } = await openWithAuth(authFor(probe));
    await until(() => methods(ws).includes('sys_auth_begin'), 'the begin');
    ws.emitMessage(
      authAnswer(frameOf(ws, 'sys_auth_begin')?.rid as string, false, {
        error: { code: ErrorCode.WalletLocked, message: 'locked' },
      })
    );
    await until(
      () => methods(ws).filter((m) => m === 'sys_auth_begin').length >= 2,
      'the dApp begin'
    );
    const second = ws
      .sentFrames()
      .filter((f) => f.method === 'sys_auth_begin')[1];
    const forged = hexBytes(AUTH_KAT.server_mac);
    forged[0] ^= 0x80;
    ws.emitMessage(
      authAnswer(second.rid as string, true, {
        result: {
          ns: hexB64(AUTH_KAT.server_nonce),
          mac: Buffer.from(forged).toString('base64'),
        },
      })
    );
    const resp = await reqP;
    assert.equal(resp.rid, 'rid-dapp');
    assert.equal(resp.error?.code, ErrorCode.Disconnected);
    assert.match(resp.error?.message ?? '', /could not prove/);
    assert.ok(!methods(ws).includes('sys_auth_finish'));
    assert.equal(ws.readyState, MockWebSocket.CLOSED);
  });
});

test('the desktop holds no pairing for this browser: the pairing page opens for the dApp, nothing is bound, the socket stays for the pairing', async () => {
  await withMockSocket(async () => {
    const probe = await pairedProbe();
    const { client, ws, reqP } = await openWithAuth(authFor(probe));
    const notPaired = async (nth: number) => {
      await until(
        () => methods(ws).filter((m) => m === 'sys_auth_begin').length >= nth,
        'a begin'
      );
      const begin = ws
        .sentFrames()
        .filter((f) => f.method === 'sys_auth_begin')[nth - 1];
      ws.emitMessage(
        authAnswer(begin.rid as string, false, {
          error: { code: ErrorCode.NotPaired, message: 'not paired' },
        })
      );
    };
    await notPaired(1); // the socket's own: no dApp named, no page
    await notPaired(2); // the dApp's
    const resp = await reqP;
    assert.equal(resp.ok, false);
    assert.equal(resp.error?.code, ErrorCode.NotPaired);
    assert.equal(resp.error?.message, PAIRING_NEEDED_MESSAGE);
    assert.deepEqual(probe.needed, [DAPP]);
    assert.ok(!methods(ws).includes('sys_resume'));
    assert.ok(!methods(ws).includes('eth_requestAccounts'));
    assert.notEqual(ws.readyState, MockWebSocket.CLOSED);
    // The pairing runs on the same socket.
    const pairP = client.exchange(
      makeRequest(AUTH_IID, 'rid-pair', 'sys', '', 'sys_pair_begin', {})
    );
    await until(() => methods(ws).includes('sys_pair_begin'), 'the pairing');
    ws.emitMessage(authAnswer('rid-pair', true, { result: {} }));
    assert.equal((await pairP).port, AUTH_KAT.port);
    assert.equal(MockWebSocket.instances.length, 2);
  });
});

test('no key, before authentication is required: the socket is bound as before, no handshake', async () => {
  await withMockSocket(async () => {
    const probe: AuthProbe = { key: undefined, needed: [] };
    const { ws } = await openWithAuth(authFor(probe, false));
    await until(() => methods(ws).includes('eth_requestAccounts'), 'dApp');
    const order = methods(ws).filter((m) => m !== 'sys_ping');
    assert.deepEqual(order, ['sys_resume', 'eth_requestAccounts']);
    assert.deepEqual(probe.needed, []);
  });
});

test('this extension’s own version decides whether authentication is required', () => {
  assert.equal(
    isAuthRequiredAt(WEB3_PROTOCOL_VERSION),
    WEB3_PROTOCOL_VERSION.major >= 3
  );
  assert.equal(isAuthRequiredAt({ wallet: 2, major: 2, minor: 0 }), false);
  assert.equal(isAuthRequiredAt({ wallet: 2, major: 3, minor: 0 }), true);
  assert.equal(isAuthRequiredAt({ wallet: 2, major: 4, minor: 0 }), true);
});

test('no key once authentication is required: the pairing page opens for the dApp and nothing is bound until the pairing', async () => {
  await withMockSocket(async () => {
    const probe: AuthProbe = { key: undefined, needed: [] };
    const { client, ws, reqP } = await openWithAuth(authFor(probe, true));
    const resp = await reqP;
    assert.equal(resp.error?.code, ErrorCode.NotPaired);
    assert.deepEqual(probe.needed, [DAPP]);
    assert.deepEqual(
      methods(ws).filter((m) => m !== 'sys_ping'),
      []
    );
    // The pairing stored a key: the same socket authenticates now.
    probe.key = (await pairedProbe()).key;
    client.afterPairing();
    await serveHandshake(ws);
    await until(() => methods(ws).includes('sys_resume'), 'the resume');
    assert.deepEqual(
      methods(ws).filter((m) => m !== 'sys_ping'),
      ['sys_auth_begin', 'sys_auth_finish', 'sys_resume']
    );
    assert.notEqual(ws.readyState, MockWebSocket.CLOSED);
  });
});

// At this extension's own protocol version, with nothing injected: the rules
// the desktop of the same major enforces on a socket.

// Answer the `nth` begin on `ws` with `code`.
async function refuseBegin(
  ws: MockWebSocket,
  nth: number,
  code: ErrorCode
): Promise<void> {
  await until(
    () => methods(ws).filter((m) => m === 'sys_auth_begin').length >= nth,
    'a begin'
  );
  const begin = ws.sentFrames().filter((f) => f.method === 'sys_auth_begin')[
    nth - 1
  ];
  ws.emitMessage(
    authAnswer(begin.rid as string, false, {
      error: { code, message: 'refused' },
    })
  );
}

test('no pairing key, at this extension’s version: nothing but sys_ping goes out, and the dApp’s request opens the pairing page', async () => {
  await withMockSocket(async () => {
    const probe: AuthProbe = { key: undefined, needed: [] };
    const { ws, reqP } = await openWithAuth(authFor(probe));
    const resp = await reqP;
    assert.equal(resp.ok, false);
    assert.equal(resp.rid, 'rid-dapp');
    assert.equal(resp.error?.code, ErrorCode.NotPaired);
    assert.equal(resp.error?.message, PAIRING_NEEDED_MESSAGE);
    assert.deepEqual(probe.needed, [DAPP]);
    assert.deepEqual(
      methods(ws).filter((m) => m !== 'sys_ping'),
      []
    );
    assert.notEqual(ws.readyState, MockWebSocket.CLOSED);
  });
});

// A keyless client whose discovery probe reads `probed` as the desktop's
// version, with a dApp request queued; returns the socket once it is open.
async function openKeylessAgainst(
  probe: AuthProbe,
  probed: object,
  required?: boolean
): Promise<{ client: WsClient; ws: MockWebSocket; reqP: Promise<Response> }> {
  MockWebSocket.instances = [];
  const client = new WsClient(
    AUTH_IID,
    [AUTH_KAT.port],
    undefined,
    undefined,
    undefined,
    authFor(probe, required)
  );
  const reqP = client.send(
    makeRequest(AUTH_IID, 'rid-dapp', 'evm', DAPP, 'eth_requestAccounts')
  );
  reqP.catch(() => undefined);
  await flush();
  const probeWs = lastSocket();
  assert.ok(isProbe(probeWs), 'the socket is a probe');
  probeWs.emitOpen();
  const ping = probeWs.sentFrames().find((f) => f.method === 'sys_ping');
  assert.ok(ping, 'the probe sent a sys_ping');
  probeWs.emitMessage(
    responseFrame(ping.rid as string, true, {
      result: { protocol_version: probed },
    })
  );
  await flush();
  const ws = lastSocket();
  assert.ok(!isProbe(ws), 'the verified port got the real socket');
  ws.emitOpen();
  await flush();
  return { client, ws, reqP };
}

test('no pairing key and a desktop of an older major: the dApp hears 1103 naming the desktop, and no pairing page opens', async () => {
  await withMockSocket(async () => {
    const probe: AuthProbe = { key: undefined, needed: [] };
    const { ws, reqP } = await openKeylessAgainst(probe, {
      wallet: 2,
      major: 2,
      minor: 1,
    });
    const resp = await reqP;
    assert.equal(resp.rid, 'rid-dapp');
    assert.equal(resp.error?.code, ErrorCode.VersionIncompatible);
    assert.match(resp.error?.message ?? '', /desktop 2\.2\.1/);
    assert.match(resp.error?.message ?? '', /Update the desktop app/);
    assert.deepEqual(probe.needed, []);
    assert.deepEqual(
      methods(ws).filter((m) => m !== 'sys_ping'),
      []
    );
  });
});

test('no pairing key, and a heartbeat reads a desktop of a newer major: the dApp hears 1103 naming the extension', async () => {
  await withMockSocket(async () => {
    const probe: AuthProbe = { key: undefined, needed: [] };
    const { client, ws, reqP } = await openKeylessAgainst(
      probe,
      WEB3_PROTOCOL_VERSION
    );
    assert.equal((await reqP).error?.code, ErrorCode.NotPaired);
    assert.deepEqual(probe.needed, [DAPP]);
    const beat = client.ping();
    await until(
      () => methods(ws).filter((m) => m === 'sys_ping').length >= 2,
      'the heartbeat'
    );
    const pings = ws.sentFrames().filter((f) => f.method === 'sys_ping');
    for (const ping of pings) {
      ws.emitMessage(
        authAnswer(ping.rid as string, true, {
          result: {
            wallet_status: 'unlocked',
            protocol_version: { wallet: 2, major: 4, minor: 0 },
          },
        })
      );
    }
    await beat;
    const again = await client.send(
      makeRequest(AUTH_IID, 'rid-again', 'evm', DAPP, 'eth_requestAccounts')
    );
    assert.equal(again.error?.code, ErrorCode.VersionIncompatible);
    assert.match(again.error?.message ?? '', /Update the extension/);
    assert.deepEqual(probe.needed, [DAPP]);
  });
});

test('a pairing the desktop no longer holds is made again once, on the same socket, which then authenticates and serves the dApp', async () => {
  await withMockSocket(async () => {
    const probe = await pairedProbe();
    const { client, ws, reqP } = await openWithAuth(authFor(probe));
    await refuseBegin(ws, 1, ErrorCode.NotPaired); // the socket's own
    await refuseBegin(ws, 2, ErrorCode.NotPaired); // the dApp's
    const refused = await reqP;
    assert.equal(refused.error?.code, ErrorCode.NotPaired);
    assert.deepEqual(probe.needed, [DAPP]);
    // The pairing page runs the pairing by code on that socket: both frames go
    // out on it, and no handshake is begun with the old key meanwhile.
    for (const method of ['sys_pair_begin', 'sys_pair_finish']) {
      const rid = `rid-${method}`;
      const pairP = client.exchange(
        makeRequest(AUTH_IID, rid, 'sys', '', method, {})
      );
      await until(() => methods(ws).includes(method), method);
      ws.emitMessage(authAnswer(rid, true, { result: {} }));
      assert.equal((await pairP).port, AUTH_KAT.port);
    }
    // The page stored the new key: the same socket begins again (naming no
    // dApp), proves itself, resumes, and the dApp's next request goes out.
    client.afterPairing();
    await serveHandshake(ws, 3);
    await until(() => methods(ws).includes('sys_resume'), 'the resume');
    const again = client.send(
      makeRequest(AUTH_IID, 'rid-again', 'evm', DAPP, 'eth_requestAccounts')
    );
    await until(() => methods(ws).includes('eth_requestAccounts'), 'dApp');
    ws.emitMessage(authAnswer('rid-again', true, { result: ['0x1'] }));
    assert.equal((await again).ok, true);
    assert.deepEqual(
      methods(ws).filter((m) => m !== 'sys_ping'),
      [
        'sys_auth_begin',
        'sys_auth_begin',
        'sys_pair_begin',
        'sys_pair_finish',
        'sys_auth_begin',
        'sys_auth_finish',
        'sys_resume',
        'eth_requestAccounts',
      ]
    );
    const begins = ws.sentFrames().filter((f) => f.method === 'sys_auth_begin');
    assert.equal((begins[1].params as { origin?: string }).origin, DAPP);
    assert.equal(
      (begins[2].params as { origin?: string }).origin !== undefined,
      false
    );
    // One socket throughout (the AUTO probe aside), never closed.
    assert.equal(MockWebSocket.instances.length, 2);
    assert.notEqual(ws.readyState, MockWebSocket.CLOSED);
  });
});

test('until the finish verified only sys_ping and the handshake go out; sys_resume is the first frame after it, then the dApp frames', async () => {
  await withMockSocket(async () => {
    const probe = await pairedProbe();
    const { client, ws } = await openWithAuth(authFor(probe));
    await until(() => methods(ws).includes('sys_auth_begin'), 'the begin');
    // A heartbeat and a second dApp's request while the begin is unanswered:
    // neither goes out ahead of the handshake.
    void client.ping();
    const other = client.send(
      makeRequest(AUTH_IID, 'rid-other', 'evm', 'https://b.app', 'eth_chainId')
    );
    other.catch(() => undefined);
    await flush();
    assert.deepEqual(
      methods(ws).filter((m) => m !== 'sys_ping'),
      ['sys_auth_begin']
    );
    await serveHandshake(ws);
    await until(
      () =>
        methods(ws).includes('eth_requestAccounts') &&
        methods(ws).includes('eth_chainId'),
      'both dApp frames'
    );
    const order = methods(ws).filter((m) => m !== 'sys_ping');
    assert.deepEqual(order.slice(0, 3), [
      'sys_auth_begin',
      'sys_auth_finish',
      'sys_resume',
    ]);
    assert.deepEqual(order.slice(3).sort(), [
      'eth_chainId',
      'eth_requestAccounts',
    ]);
  });
});

test('a pairing over a socket bound without the new key closes it, so the next one authenticates', async () => {
  await withMockSocket(async () => {
    const probe: AuthProbe = { key: undefined, needed: [] };
    const { client, ws } = await openWithAuth(authFor(probe, false));
    await until(() => methods(ws).includes('sys_resume'), 'the resume');
    client.afterPairing();
    assert.equal(ws.readyState, MockWebSocket.CLOSED);
  });
});

test('while a pairing is under way a new socket is left for it, not authenticated with the key it replaces', async () => {
  await withMockSocket(async () => {
    MockWebSocket.instances = [];
    const probe = await pairedProbe();
    const client = new WsClient(
      AUTH_IID,
      [AUTH_KAT.port],
      undefined,
      undefined,
      undefined,
      authFor(probe)
    );
    const pairP = client.exchange(
      makeRequest(AUTH_IID, 'rid-pair', 'sys', '', 'sys_pair_begin', {})
    );
    const ws = await openManualSocket();
    await until(() => methods(ws).includes('sys_pair_begin'), 'the pairing');
    assert.ok(!methods(ws).includes('sys_auth_begin'));
    ws.emitMessage(authAnswer('rid-pair', true, { result: {} }));
    await pairP;
    // Paired: the socket, still unbound, authenticates with the new key.
    client.afterPairing();
    await serveHandshake(ws);
  });
});

test('a pairing key that cannot be read refuses the socket: it is never served as if this browser held none', async () => {
  await withMockSocket(async () => {
    const needed: string[] = [];
    const { ws, reqP } = await openWithAuth({
      loadKey: () => Promise.reject(new Error('indexedDB failed')),
      pairingNeeded: (origin) => {
        needed.push(origin);
      },
      required: false,
      nonce: () => hexBytes(AUTH_KAT.client_nonce),
    });
    const resp = await reqP;
    assert.equal(resp.error?.code, ErrorCode.Internal);
    assert.deepEqual(needed, []);
    assert.deepEqual(
      methods(ws).filter((m) => m !== 'sys_ping'),
      []
    );
    assert.notEqual(ws.readyState, MockWebSocket.CLOSED);
  });
});

// A client with `auth` and no resume store whose first frame is a pairing
// begin; returns the socket the pairing went out on, and the begin's answer.
async function startPairing(probe: AuthProbe): Promise<{
  client: WsClient;
  ws: MockWebSocket;
  pairP: Promise<{ response: Response; port: number }>;
}> {
  MockWebSocket.instances = [];
  const client = new WsClient(
    AUTH_IID,
    [AUTH_KAT.port],
    undefined,
    undefined,
    undefined,
    authFor(probe)
  );
  const pairP = client.exchange(
    makeRequest(AUTH_IID, 'rid-pair', 'sys', '', 'sys_pair_begin', {})
  );
  pairP.catch(() => undefined);
  const ws = await openManualSocket();
  await until(() => methods(ws).includes('sys_pair_begin'), 'the pairing');
  assert.ok(!methods(ws).includes('sys_auth_begin'));
  return { client, ws, pairP };
}

test('a pairing the desktop refused ends: the socket left for it authenticates on its own', async () => {
  await withMockSocket(async () => {
    const { ws, pairP } = await startPairing(await pairedProbe());
    ws.emitMessage(
      authAnswer('rid-pair', false, {
        error: { code: ErrorCode.UserRejected, message: 'cancelled' },
      })
    );
    assert.equal((await pairP).response.ok, false);
    await serveHandshake(ws);
  });
});

test('the close of the socket a pairing ran on ends the pairing: the next socket authenticates on its own', async () => {
  await withMockSocket(async () => {
    const { client, ws, pairP } = await startPairing(await pairedProbe());
    // The begin was answered; then the desktop drops the socket mid-pairing.
    ws.emitMessage(authAnswer('rid-pair', true, { result: {} }));
    await pairP;
    ws.close();
    void client.ping();
    await flush();
    let next = lastSocket();
    if (isProbe(next)) {
      serveProbe(next);
      await flush();
      next = lastSocket();
    }
    assert.notEqual(next, ws);
    next.emitOpen();
    await flush();
    await serveHandshake(next);
  });
});

test('a pairing frame answered malformed ends the pairing: the socket left for it authenticates on its own', async () => {
  await withMockSocket(async () => {
    const { ws, pairP } = await startPairing(await pairedProbe());
    ws.emitMessage(JSON.stringify({ rid: 'rid-pair', ok: 'yes' }));
    await assert.rejects(pairP);
    await serveHandshake(ws);
  });
});

test('a dApp that asks while the socket’s own bind is in flight begins again naming itself when that bind is refused', async () => {
  await withMockSocket(async () => {
    const { client, ws, pairP } = await startPairing(await pairedProbe());
    ws.emitMessage(authAnswer('rid-pair', true, { result: {} }));
    await pairP;
    // The pairing window closed: the socket's own bind begins, naming no dApp.
    client.pairingEnded();
    await until(() => methods(ws).includes('sys_auth_begin'), 'the begin');
    const reqP = client.send(
      makeRequest(AUTH_IID, 'rid-dapp', 'evm', DAPP, 'eth_requestAccounts')
    );
    reqP.catch(() => undefined);
    await flush();
    ws.emitMessage(
      authAnswer(frameOf(ws, 'sys_auth_begin')?.rid as string, false, {
        error: { code: ErrorCode.WalletLocked, message: 'locked' },
      })
    );
    await serveHandshake(ws, 2);
    const begins = ws.sentFrames().filter((f) => f.method === 'sys_auth_begin');
    assert.equal((begins[1].params as { origin?: string }).origin, DAPP);
  });
});

test('a handshake that never ended closes its socket', async () => {
  await withMockSocket(async () => {
    const probe = await pairedProbe();
    const { ws } = await openWithAuth(authFor(probe));
    await until(() => methods(ws).includes('sys_auth_begin'), 'the begin');
    ws.emitMessage(
      JSON.stringify({ rid: frameOf(ws, 'sys_auth_begin')?.rid, ok: 'yes' })
    );
    await until(() => ws.readyState === MockWebSocket.CLOSED, 'the close');
    assert.ok(!methods(ws).includes('sys_auth_finish'));
    assert.ok(!methods(ws).includes('sys_resume'));
  });
});

test('the pairing window closed while a pairing was under way: the socket left for it authenticates', async () => {
  await withMockSocket(async () => {
    const { client, ws, pairP } = await startPairing(await pairedProbe());
    ws.emitMessage(authAnswer('rid-pair', true, { result: {} }));
    await pairP;
    // The begin was answered: the pairing is still under way, nothing binds.
    await flush();
    assert.ok(!methods(ws).includes('sys_auth_begin'));
    client.pairingEnded();
    await serveHandshake(ws);
  });
});

test('a socket the lock kept unbound authenticates once the heartbeat reads the wallet unlocked', async () => {
  await withMockSocket(async () => {
    const probe = await pairedProbe();
    const { client, ws } = await openWithAuth(authFor(probe));
    await until(() => methods(ws).includes('sys_auth_begin'), 'the begin');
    ws.emitMessage(
      authAnswer(frameOf(ws, 'sys_auth_begin')?.rid as string, false, {
        error: { code: ErrorCode.WalletLocked, message: 'locked' },
      })
    );
    // The dApp's begin (naming it) is pending; answer it locked as well.
    await until(
      () => methods(ws).filter((m) => m === 'sys_auth_begin').length >= 2,
      'the dApp begin'
    );
    const second = ws
      .sentFrames()
      .filter((f) => f.method === 'sys_auth_begin')[1];
    ws.emitMessage(
      authAnswer(second.rid as string, false, {
        error: { code: ErrorCode.UserRejected, message: 'skipped' },
      })
    );
    const pingP = client.ping();
    await until(
      () => methods(ws).filter((m) => m === 'sys_ping').length >= 2,
      'the heartbeat'
    );
    const pings = ws.sentFrames().filter((f) => f.method === 'sys_ping');
    for (const p of pings) {
      ws.emitMessage(
        authAnswer(p.rid as string, true, {
          result: {
            wallet_status: 'unlocked',
            protocol_version: WEB3_PROTOCOL_VERSION,
          },
        })
      );
    }
    await pingP;
    await serveHandshake(ws, 3);
    await until(() => methods(ws).includes('sys_resume'), 'the resume');
  });
});

test('a handshake begin that names a dApp keeps the worker awake through the unlock window; the others do not', () => {
  const frame = (method: string, params?: object) =>
    makeRequest(IID, 'r', 'sys', '', method, params);
  assert.equal(
    keepsWorkerAwake(frame('sys_auth_begin', { nc: 'x', origin: DAPP })),
    true
  );
  assert.equal(keepsWorkerAwake(frame('sys_auth_begin', { nc: 'x' })), false);
  assert.equal(keepsWorkerAwake(frame('sys_auth_finish', { mac: 'x' })), false);
});

// ── which failures withhold the key ──────────────────────────────────────────
// Only a desktop proof that does not verify withholds the key. A desktop that
// refused our proof, or answered with something malformed, proved nothing
// either way: the key is offered again on the next socket.

// A client with `auth` whose distrust records land in `marks`; the next dApp
// request after the first failed opens a new socket, returned with its reply.
function markingAuth(probe: AuthProbe, marks: string[]): SocketAuth {
  return {
    ...authFor(probe),
    keyDistrusted: () => Promise.resolve(false),
    distrustKey: (fingerprint) => {
      marks.push(fingerprint);
      return Promise.resolve();
    },
  };
}

async function nextSocketAfter(
  client: WsClient,
  ws: MockWebSocket
): Promise<MockWebSocket> {
  const again = client.send(
    makeRequest(AUTH_IID, 'rid-again', 'evm', DAPP, 'eth_requestAccounts')
  );
  again.catch(() => undefined);
  await flush();
  if (isProbe(lastSocket())) {
    serveProbe(lastSocket());
    await flush();
  }
  const next = lastSocket();
  assert.notEqual(next, ws);
  next.emitOpen();
  return next;
}

test('a desktop that refuses our proof does not withhold the key: the next socket offers it again', async () => {
  await withMockSocket(async () => {
    const probe = await pairedProbe();
    const marks: string[] = [];
    const { client, ws, reqP } = await openWithAuth(markingAuth(probe, marks));
    await until(() => methods(ws).includes('sys_auth_begin'), 'the begin');
    ws.emitMessage(
      authAnswer(frameOf(ws, 'sys_auth_begin')?.rid as string, true, {
        result: {
          ns: hexB64(AUTH_KAT.server_nonce),
          mac: hexB64(AUTH_KAT.server_mac),
        },
      })
    );
    await until(() => methods(ws).includes('sys_auth_finish'), 'the finish');
    ws.emitMessage(
      authAnswer(frameOf(ws, 'sys_auth_finish')?.rid as string, false, {
        error: {
          code: ErrorCode.Unauthorized,
          message: 'authentication refused',
        },
      })
    );
    const resp = await reqP;
    assert.equal(resp.error?.code, ErrorCode.Disconnected);
    assert.match(resp.error?.message ?? '', /did not accept/);
    assert.deepEqual(marks, []);
    const next = await nextSocketAfter(client, ws);
    await until(() => methods(next).includes('sys_auth_begin'), 'a new begin');
  });
});

test('a malformed handshake answer does not withhold the key: the next socket offers it again', async () => {
  await withMockSocket(async () => {
    const probe = await pairedProbe();
    const marks: string[] = [];
    const { client, ws, reqP } = await openWithAuth(markingAuth(probe, marks));
    await until(() => methods(ws).includes('sys_auth_begin'), 'the begin');
    ws.emitMessage(
      authAnswer(frameOf(ws, 'sys_auth_begin')?.rid as string, true, {
        result: { ns: 'not base64 at all', mac: '' },
      })
    );
    const resp = await reqP;
    assert.equal(resp.error?.code, ErrorCode.Disconnected);
    assert.match(resp.error?.message ?? '', /something unexpected/);
    assert.deepEqual(marks, []);
    assert.ok(!methods(ws).includes('sys_auth_finish'));
    const next = await nextSocketAfter(client, ws);
    await until(() => methods(next).includes('sys_auth_begin'), 'a new begin');
  });
});

test('a distrust record that cannot be read counts as none: the handshake runs and still checks the desktop first', async () => {
  await withMockSocket(async () => {
    const probe = await pairedProbe();
    const { ws, reqP } = await openWithAuth({
      ...authFor(probe),
      keyDistrusted: () => Promise.reject(new Error('storage failed')),
      distrustKey: () => Promise.resolve(),
    });
    await serveHandshake(ws);
    await until(() => methods(ws).includes('eth_requestAccounts'), 'dApp');
    ws.emitMessage(authAnswer('rid-dapp', true, { result: ['0x1'] }));
    assert.equal((await reqP).ok, true);
  });
});

// ── which requests may open the pairing page ─────────────────────────────────
// Only a dApp's connect, never a read, a sign or a sys frame: a page polling a
// read on a timer must not put a pairing window (and, once Pair is pressed, a
// desktop code dialog) in front of the person.

test('the connect methods of every provider open the pairing page; nothing else does', () => {
  const req = (ns: Namespace, method: string) =>
    makeRequest(AUTH_IID, 'r', ns, DAPP, method);
  for (const [ns, method] of <Array<[Namespace, string]>>[
    ['evm', 'eth_requestAccounts'],
    ['evm', 'wallet_requestPermissions'],
    ['wstd', 'standard:connect'],
    ['tonconnect', 'tonConnect_connect'],
    ['tron', 'tron_requestAccounts'],
  ]) {
    assert.equal(opensPairing(req(ns, method)), true, method);
  }
  for (const [ns, method] of <Array<[Namespace, string]>>[
    ['evm', 'eth_blockNumber'],
    ['evm', 'eth_getBalance'],
    ['evm', 'eth_call'],
    ['evm', 'personal_sign'],
    ['evm', 'eth_sendTransaction'],
    ['evm', 'wallet_switchEthereumChain'],
    ['tonconnect', 'tonConnect_restoreConnection'],
    ['wstd', 'standard:disconnect'],
    ['sys', 'eth_requestAccounts'],
    ['sys', 'sys_pair_begin'],
  ]) {
    assert.equal(opensPairing(req(ns, method)), false, method);
  }
});

test('no key: a dApp polling a read is refused each time and opens nothing; its connect asks for the page', async () => {
  await withMockSocket(async () => {
    const probe: AuthProbe = { key: undefined, needed: [] };
    const { client, ws, reqP } = await openWithAuth(
      authFor(probe),
      'eth_blockNumber'
    );
    assert.equal((await reqP).error?.code, ErrorCode.NotPaired);
    for (let i = 0; i < 5; i++) {
      const resp = await client.send(
        makeRequest(AUTH_IID, `rid-poll-${i}`, 'evm', DAPP, 'eth_getBalance')
      );
      assert.equal(resp.error?.code, ErrorCode.NotPaired);
      assert.equal(resp.error?.message, PAIRING_NEEDED_MESSAGE);
    }
    const signed = await client.send(
      makeRequest(AUTH_IID, 'rid-sign', 'evm', DAPP, 'personal_sign')
    );
    assert.equal(signed.error?.code, ErrorCode.NotPaired);
    assert.deepEqual(probe.needed, []);
    const connect = await client.send(
      makeRequest(AUTH_IID, 'rid-connect', 'evm', DAPP, 'eth_requestAccounts')
    );
    assert.equal(connect.error?.code, ErrorCode.NotPaired);
    assert.deepEqual(probe.needed, [DAPP]);
    // Nothing of the pairing went to the desktop: the page begins it only
    // when the person presses Pair.
    assert.deepEqual(
      methods(ws).filter((m) => m !== 'sys_ping'),
      []
    );
  });
});

test('a pairing the desktop no longer holds: a dApp polling a read hears 1002 and opens nothing', async () => {
  await withMockSocket(async () => {
    const probe = await pairedProbe();
    const { ws, reqP } = await openWithAuth(authFor(probe), 'eth_blockNumber');
    await refuseBegin(ws, 1, ErrorCode.NotPaired); // the socket's own
    await refuseBegin(ws, 2, ErrorCode.NotPaired); // the dApp's
    const resp = await reqP;
    assert.equal(resp.error?.code, ErrorCode.NotPaired);
    assert.deepEqual(probe.needed, []);
  });
});

test('a polling dApp raises at most one pairing prompt: reads open nothing, and repeated connects are held back after the first', async () => {
  await withMockSocket(async () => {
    let record = {};
    const gate = new PairingPromptGate(
      {
        load: () => Promise.resolve(record),
        save: (r) => {
          record = r;
          return Promise.resolve();
        },
      },
      () => 1_000_000
    );
    const opened: string[] = [];
    const admitting: Promise<void>[] = [];
    const probe: AuthProbe = { key: undefined, needed: [] };
    const auth: SocketAuth = {
      ...authFor(probe),
      pairingNeeded: (origin) => {
        probe.needed.push(origin);
        admitting.push(
          gate.admit(origin).then((ok) => {
            if (ok) {
              opened.push(origin);
            }
          })
        );
      },
    };
    const { client, ws, reqP } = await openWithAuth(auth, 'eth_blockNumber');
    await reqP;
    for (let i = 0; i < 20; i++) {
      const method = i % 2 === 0 ? 'eth_blockNumber' : 'eth_requestAccounts';
      const resp = await client.send(
        makeRequest(AUTH_IID, `rid-${i}`, 'evm', DAPP, method)
      );
      assert.equal(resp.error?.code, ErrorCode.NotPaired);
    }
    await Promise.all(admitting);
    assert.equal(probe.needed.length, 10); // the connects asked
    assert.deepEqual(opened, [DAPP]); // one window
    assert.deepEqual(
      methods(ws).filter((m) => m !== 'sys_ping'),
      []
    );
  });
});

// ── a keyed browser and a desktop of another major ──────────────────────────

test('with a key, a desktop of an older major read by the probe: no key is offered, and the dApp hears 1103 naming the desktop', async () => {
  await withMockSocket(async () => {
    const probe = await pairedProbe();
    const { ws, reqP } = await openKeylessAgainst(probe, {
      wallet: 2,
      major: 2,
      minor: 1,
    });
    const resp = await reqP;
    assert.equal(resp.error?.code, ErrorCode.VersionIncompatible);
    assert.match(resp.error?.message ?? '', /desktop 2\.2\.1/);
    assert.match(resp.error?.message ?? '', /Update the desktop app/);
    assert.deepEqual(
      methods(ws).filter((m) => m !== 'sys_ping'),
      []
    );
    assert.deepEqual(probe.needed, []);
  });
});

test('with a key, a desktop of another major is never offered it, even where a keyless browser would be served', async () => {
  await withMockSocket(async () => {
    const probe = await pairedProbe();
    const { ws, reqP } = await openKeylessAgainst(
      probe,
      { wallet: 2, major: 2, minor: 1 },
      false
    );
    const resp = await reqP;
    assert.equal(resp.error?.code, ErrorCode.VersionIncompatible);
    assert.match(resp.error?.message ?? '', /Update the desktop app/);
    assert.deepEqual(
      methods(ws).filter((m) => m !== 'sys_ping'),
      []
    );
  });
});

test('with a key, a begin refused with 1103 under an older major: the dApp hears which side to update', async () => {
  await withMockSocket(async () => {
    const probe = await pairedProbe();
    const { ws, reqP } = await openWithAuth(authFor(probe));
    // The socket's own begin, then the dApp's, each answered by a desktop
    // that has moved to another major since the probe read it.
    for (const nth of [1, 2]) {
      await until(
        () => methods(ws).filter((m) => m === 'sys_auth_begin').length >= nth,
        'a begin'
      );
      ws.emitMessage(
        JSON.stringify({
          v: { wallet: 2, major: 2, minor: 1 },
          iid: AUTH_IID,
          rid: ws.sentFrames().filter((f) => f.method === 'sys_auth_begin')[
            nth - 1
          ].rid,
          ok: false,
          error: {
            code: ErrorCode.VersionIncompatible,
            message: 'protocol version mismatch',
          },
        })
      );
    }
    const resp = await reqP;
    assert.equal(resp.error?.code, ErrorCode.VersionIncompatible);
    assert.match(resp.error?.message ?? '', /desktop 2\.2\.1/);
    assert.match(resp.error?.message ?? '', /Update the desktop app/);
  });
});
