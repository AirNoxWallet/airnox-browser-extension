import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PairRelayDeps, relayPairFrame } from '../src/background/pair_relay';
import {
  PAIR_RELAY_MESSAGE,
  parsePairRelayReply,
} from '../src/protocol/bridge';
import {
  Request,
  Response,
  SYS_PAIR_BEGIN,
  SYS_PAIR_FINISH,
  WEB3_PROTOCOL_VERSION,
  makeRequest,
} from '../src/protocol/envelope';

// The service worker relays the pairing page's two frames to the desktop and
// nothing else: the page is an extension page, but the relay must not become a
// general `sys` pipe (sys_resume, sys_auth_* or a dApp method through it).

const IID = '3f2b8c1e-9a4d-4e57-b1c6-0d8e7f6a5b49';
const EPK = Buffer.alloc(32, 1).toString('base64');
const NC = Buffer.alloc(16, 2).toString('base64');
const MAC = Buffer.alloc(32, 3).toString('base64');

function relay(port = 8114): {
  deps: PairRelayDeps;
  sent: Request[];
} {
  const sent: Request[] = [];
  const deps: PairRelayDeps = {
    exchange: (wire) => {
      sent.push(wire);
      const response: Response = {
        v: WEB3_PROTOCOL_VERSION,
        iid: wire.iid,
        rid: wire.rid,
        ok: true,
        result: { echo: wire.method },
      };
      return Promise.resolve({ response, port });
    },
    iid: () => Promise.resolve(IID),
    newRid: () => 'rid-1',
  };
  return { deps, sent };
}

test('a begin and a finish go out as sys frames with the persisted iid, and come back with the port', async () => {
  for (const [method, params] of [
    [SYS_PAIR_BEGIN, { epk: EPK, nc: NC }],
    [SYS_PAIR_BEGIN, { epk: EPK, nc: NC, origin: 'https://app.example' }],
    [SYS_PAIR_FINISH, { mac: MAC }],
  ] as const) {
    const r = relay(18114);
    const reply = await relayPairFrame(r.deps, {
      type: PAIR_RELAY_MESSAGE,
      method,
      params,
    });
    assert.deepEqual(r.sent, [
      makeRequest(IID, 'rid-1', 'sys', '', method, params),
    ]);
    assert.deepEqual(reply, {
      delivered: true,
      answer: {
        iid: IID,
        port: 18114,
        response: {
          v: WEB3_PROTOCOL_VERSION,
          iid: IID,
          rid: 'rid-1',
          ok: true,
          result: { echo: method },
        },
      },
    });
    assert.deepEqual(
      parsePairRelayReply(reply),
      (reply as { answer: unknown }).answer
    );
  }
});

test('anything but the two pairing frames is refused and never sent', async () => {
  const refused: unknown[] = [
    undefined,
    null,
    'sys_pair_begin',
    { type: PAIR_RELAY_MESSAGE },
    { type: PAIR_RELAY_MESSAGE, method: 'sys_ping', params: {} },
    { type: PAIR_RELAY_MESSAGE, method: 'sys_resume', params: {} },
    { type: PAIR_RELAY_MESSAGE, method: 'sys_auth_begin', params: {} },
    { type: PAIR_RELAY_MESSAGE, method: 'eth_requestAccounts', params: {} },
    { type: PAIR_RELAY_MESSAGE, method: SYS_PAIR_BEGIN },
    { type: PAIR_RELAY_MESSAGE, method: SYS_PAIR_BEGIN, params: null },
    { type: PAIR_RELAY_MESSAGE, method: SYS_PAIR_BEGIN, params: [EPK, NC] },
    {
      type: PAIR_RELAY_MESSAGE,
      method: SYS_PAIR_BEGIN,
      params: { epk: EPK, nc: NC, mac: MAC },
    },
    {
      type: PAIR_RELAY_MESSAGE,
      method: SYS_PAIR_FINISH,
      params: { mac: MAC, epk: EPK },
    },
    {
      type: PAIR_RELAY_MESSAGE,
      method: SYS_PAIR_BEGIN,
      params: { epk: EPK, nc: 16 },
    },
    {
      type: PAIR_RELAY_MESSAGE,
      method: SYS_PAIR_FINISH,
      params: { mac: { bytes: MAC } },
    },
  ];
  for (const msg of refused) {
    const r = relay();
    const reply = await relayPairFrame(r.deps, msg);
    assert.equal(reply.delivered, false, JSON.stringify(msg));
    assert.equal(r.sent.length, 0, JSON.stringify(msg));
    assert.throws(() => parsePairRelayReply(reply), Error);
  }
});

test('a transport failure is a reply the page can read, not a hang', async () => {
  const r = relay();
  r.deps.exchange = () =>
    Promise.reject(new Error('cannot reach the AirNox Wallet desktop app'));
  const reply = await relayPairFrame(r.deps, {
    type: PAIR_RELAY_MESSAGE,
    method: SYS_PAIR_FINISH,
    params: { mac: MAC },
  });
  assert.deepEqual(reply, {
    delivered: false,
    message: 'cannot reach the AirNox Wallet desktop app',
  });
  assert.throws(
    () => parsePairRelayReply(reply),
    /cannot reach the AirNox Wallet desktop app/
  );
});

test('the page reads a relay reply only when every field has its type', () => {
  const response = {
    v: WEB3_PROTOCOL_VERSION,
    iid: IID,
    rid: 'r',
    ok: true,
    result: {},
  };
  const good = { delivered: true, answer: { iid: IID, port: 8114, response } };
  assert.deepEqual(parsePairRelayReply(good), good.answer);
  for (const bad of [
    undefined,
    {},
    { delivered: 'true', answer: good.answer },
    { delivered: true },
    { delivered: true, answer: { ...good.answer, port: '8114' } },
    { delivered: true, answer: { ...good.answer, port: 0 } },
    { delivered: true, answer: { ...good.answer, iid: 7 } },
    { delivered: true, answer: { ...good.answer, response: { ok: true } } },
    { delivered: false },
  ]) {
    assert.throws(() => parsePairRelayReply(bad), Error, JSON.stringify(bad));
  }
});
