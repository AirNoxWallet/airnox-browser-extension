import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AirNoxTonConnectBridge } from '../src/inpage/tonconnect_bridge';
import { TON_MAINNET_CHAIN_URN } from '../src/protocol/chains';
import { ErrorCode, Namespace } from '../src/protocol/envelope';
import { rpcError } from '../src/inpage/rpc_error';
import { EventHandler, Transport } from '../src/inpage/transport';
import {
  ConnectEvent,
  ConnectEventErrorCode,
  ConnectRequest,
  DisconnectRpcRequest,
  SendTransactionRpcRequest,
  SignDataRpcRequest,
  SignDataResult,
  WalletEvent,
} from '../src/protocol/tonconnect';

type Call = { ns: string; method: string; params: unknown; chain?: string };

class MockTransport implements Transport {
  calls: Call[] = [];
  result: unknown = null;
  error: Error | null = null;
  private handler?: EventHandler;

  send(
    ns: string,
    method: string,
    params: unknown,
    chain?: string
  ): Promise<unknown> {
    this.calls.push({ ns, method, params, chain });
    if (this.error) {
      return Promise.reject(this.error);
    }
    return Promise.resolve(this.result);
  }

  onEvent(handler: EventHandler): void {
    this.handler = handler;
  }

  // Test helper: a desktop push reaching the bridge on ITS OWN namespace (the
  // common case — call sites stay namespace-agnostic).
  fire(event: string, data: unknown): void {
    this.handler?.('tonconnect', event, data);
  }

  // A push for ANOTHER chain's provider arriving on the shared window.
  fireNs(ns: Namespace, event: string, data: unknown): void {
    this.handler?.(ns, event, data);
  }
}

function tonAddrResult(): unknown {
  return {
    items: [
      {
        name: 'ton_addr',
        address: '0:abc',
        network: '-239',
        publicKey: 'deadbeef',
        walletStateInit: 'te6cc',
      },
    ],
  };
}

test('the bridge advertises an extension, protocol v2, 4-message SendTransaction + SignData', () => {
  const b = new AirNoxTonConnectBridge(new MockTransport());
  assert.equal(b.isWalletBrowser, false);
  assert.equal(b.protocolVersion, 2);
  assert.equal(b.deviceInfo.platform, 'browser');
  assert.equal(b.deviceInfo.maxProtocolVersion, 2);
  assert.deepEqual(b.deviceInfo.features, [
    { name: 'SendTransaction', maxMessages: 4 },
    { name: 'SignData', types: ['text', 'binary', 'cell'] },
  ]);
});

test('connect (no proof) round-trips on the tonconnect ns + the TON URN', async () => {
  const t = new MockTransport();
  t.result = tonAddrResult();
  const b = new AirNoxTonConnectBridge(t);

  const req: ConnectRequest = {
    manifestUrl: 'https://app.ston.fi/manifest.json',
    items: [{ name: 'ton_addr' }],
  };
  const ev = await b.connect(2, req);

  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].ns, 'tonconnect');
  assert.equal(t.calls[0].method, 'tonConnect_connect');
  assert.equal(t.calls[0].chain, TON_MAINNET_CHAIN_URN);
  // No proof requested → no ton_proof param; manifestUrl is NOT forwarded.
  assert.deepEqual(t.calls[0].params, {});

  assert.equal(ev.event, 'connect');
  if (ev.event !== 'connect') {
    return;
  }
  assert.equal(ev.payload.items.length, 1);
  assert.equal(ev.payload.items[0].name, 'ton_addr');
  // The device info the bridge injects (the desktop returns only items).
  assert.equal(ev.payload.device.appName, 'AirNox');
});

test('connect (with proof) forwards the ton_proof payload, not the manifestUrl', async () => {
  const t = new MockTransport();
  t.result = {
    items: [
      ...(tonAddrResult() as { items: unknown[] }).items,
      {
        name: 'ton_proof',
        proof: {
          timestamp: 1700000000,
          domain: { lengthBytes: 11, value: 'app.ston.fi' },
          payload: 'the-payload',
          signature: 'c2ln',
        },
      },
    ],
  };
  const b = new AirNoxTonConnectBridge(t);

  const req: ConnectRequest = {
    manifestUrl: 'https://app.ston.fi/manifest.json',
    items: [
      { name: 'ton_addr' },
      { name: 'ton_proof', payload: 'the-payload' },
    ],
  };
  const ev = await b.connect(2, req);

  assert.deepEqual(t.calls[0].params, { ton_proof: 'the-payload' });
  assert.equal(ev.event, 'connect');
  if (ev.event !== 'connect') {
    return;
  }
  assert.equal(ev.payload.items.length, 2);
  assert.equal(ev.payload.items[1].name, 'ton_proof');
});

test('connect error maps the wire code to a connect_error', async () => {
  const cases: Array<[number, number]> = [
    [ErrorCode.UserRejected, 300],
    [ErrorCode.UnsupportedMethod, 400],
    [ErrorCode.MalformedRequest, 1],
    [ErrorCode.Unauthorized, 100],
    [ErrorCode.WalletLocked, 0],
    [ErrorCode.Internal, 0],
    [ErrorCode.TransactionRejected, 0],
  ];
  for (const [wire, expected] of cases) {
    const t = new MockTransport();
    t.error = rpcError(wire, 'boom');
    const b = new AirNoxTonConnectBridge(t);
    const ev = await b.connect(2, {
      manifestUrl: 'x',
      items: [{ name: 'ton_addr' }],
    });
    assert.equal(ev.event, 'connect_error');
    if (ev.event !== 'connect_error') {
      continue;
    }
    assert.equal(ev.payload.code, expected);
    assert.equal(ev.payload.message, 'boom');
  }
});

test('connect: a non-array items yields a BadRequest connect_error, never throws', async () => {
  const t = new MockTransport();
  const b = new AirNoxTonConnectBridge(t);
  // The dApp-supplied ConnectRequest is untrusted; `items` here is a garbage
  // non-array. This must NOT reject with a raw TypeError.
  const ev = await b.connect(2, {
    manifestUrl: 'x',
    items: 'oops' as unknown as ConnectRequest['items'],
  });
  assert.equal(ev.event, 'connect_error');
  if (ev.event !== 'connect_error') {
    return;
  }
  assert.equal(ev.payload.code, ConnectEventErrorCode.BadRequest);
  assert.equal(t.calls.length, 0); // never round-tripped a malformed request
});

test('connect: a ton_proof item without a string payload is a BadRequest', async () => {
  const t = new MockTransport();
  const b = new AirNoxTonConnectBridge(t);
  const ev = await b.connect(2, {
    manifestUrl: 'x',
    items: [
      { name: 'ton_addr' },
      { name: 'ton_proof' } as unknown as ConnectRequest['items'][number],
    ],
  });
  assert.equal(ev.event, 'connect_error');
  if (ev.event !== 'connect_error') {
    return;
  }
  assert.equal(ev.payload.code, ConnectEventErrorCode.BadRequest);
  assert.equal(t.calls.length, 0);
});

test('connect: a malformed (null / primitive) items entry is skipped, connect proceeds', async () => {
  const t = new MockTransport();
  t.result = tonAddrResult();
  const b = new AirNoxTonConnectBridge(t);
  // A stray null / primitive alongside a valid ton_addr must not throw; with no
  // valid ton_proof the connect round-trips with empty params.
  const ev = await b.connect(2, {
    manifestUrl: 'x',
    items: [
      null,
      42,
      { name: 'ton_addr' },
    ] as unknown as ConnectRequest['items'],
  });
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.calls[0].params, {});
  assert.equal(ev.event, 'connect');
});

test('restoreConnection round-trips silently; a no-grant Unauthorized → connect_error', async () => {
  // success path
  {
    const t = new MockTransport();
    t.result = tonAddrResult();
    const b = new AirNoxTonConnectBridge(t);
    const ev = await b.restoreConnection();
    assert.equal(t.calls[0].method, 'tonConnect_restoreConnection');
    assert.deepEqual(t.calls[0].params, {});
    assert.equal(ev.event, 'connect');
  }
  // no grant → Unauthorized → connect_error(UNKNOWN_APP)
  {
    const t = new MockTransport();
    t.error = rpcError(ErrorCode.Unauthorized, 'not connected');
    const b = new AirNoxTonConnectBridge(t);
    const ev = await b.restoreConnection();
    assert.equal(ev.event, 'connect_error');
    if (ev.event !== 'connect_error') {
      return;
    }
    assert.equal(ev.payload.code, 100);
  }
});

test('send(sendTransaction) parses params[0] JSON, returns the signed BoC echoing the id', async () => {
  const t = new MockTransport();
  t.result = { boc: 'te6ccSIGNED' };
  const b = new AirNoxTonConnectBridge(t);

  const txParams = JSON.stringify({
    valid_until: 123,
    messages: [{ address: 'UQ_recipient', amount: '1000000000' }],
  });
  const req: SendTransactionRpcRequest = {
    method: 'sendTransaction',
    params: [txParams],
    id: 'req-7',
  };
  const resp = await b.send(req);

  assert.equal(t.calls[0].ns, 'tonconnect');
  assert.equal(t.calls[0].method, 'tonConnect_sendTransaction');
  assert.equal(t.calls[0].chain, TON_MAINNET_CHAIN_URN);
  // The JSON string is parsed into the wire params object.
  assert.deepEqual(t.calls[0].params, {
    valid_until: 123,
    messages: [{ address: 'UQ_recipient', amount: '1000000000' }],
  });
  assert.ok('result' in resp);
  if (!('result' in resp)) {
    return;
  }
  assert.equal(resp.result, 'te6ccSIGNED');
  assert.equal(resp.id, 'req-7'); // the request id is echoed
});

test('send(sendTransaction) forwards a multi-message (1..4) request verbatim', async () => {
  const t = new MockTransport();
  t.result = { boc: 'te6ccSIGNED' };
  const b = new AirNoxTonConnectBridge(t);

  // A 3-message batch (within maxMessages: 4) — the bridge is count-agnostic and
  // forwards every message to the desktop, which signs them as one external message.
  const messages = [
    { address: 'UQ_recipient_1', amount: '1000000000' },
    { address: 'UQ_recipient_2', amount: '2000000000', payload: 'te6ccTWO' },
    { address: 'UQ_recipient_3', amount: '3000000000' },
  ];
  const resp = await b.send({
    method: 'sendTransaction',
    params: [JSON.stringify({ valid_until: 123, messages })],
    id: 'req-8',
  });

  assert.equal(t.calls[0].method, 'tonConnect_sendTransaction');
  assert.deepEqual(
    (t.calls[0].params as { messages: unknown }).messages,
    messages
  );
  assert.ok('result' in resp);
  if (!('result' in resp)) {
    return;
  }
  assert.equal(resp.result, 'te6ccSIGNED');
});

test('send(sendTransaction) maps a wire error to a WalletResponseError echoing the id', async () => {
  const t = new MockTransport();
  t.error = rpcError(ErrorCode.UserRejected, 'rejected');
  const b = new AirNoxTonConnectBridge(t);
  const resp = await b.send({
    method: 'sendTransaction',
    params: ['{"messages":[]}'],
    id: 'req-9',
  });
  assert.ok('error' in resp);
  if (!('error' in resp)) {
    return;
  }
  assert.equal(resp.error.code, 300);
  assert.equal(resp.id, 'req-9');
});

test('send(sendTransaction): a refusal by the wallet filter (-32003) is UNKNOWN_ERROR, never USER_REJECTS', async () => {
  const t = new MockTransport();
  t.error = rpcError(ErrorCode.TransactionRejected, 'transaction rejected');
  const b = new AirNoxTonConnectBridge(t);
  const resp = await b.send({
    method: 'sendTransaction',
    params: ['{"messages":[]}'],
    id: 'req-10',
  });
  assert.ok('error' in resp);
  if (!('error' in resp)) {
    return;
  }
  assert.equal(resp.error.code, 0);
  assert.equal(resp.error.message, 'transaction rejected');
  assert.equal(resp.id, 'req-10');
});

test('send(sendTransaction) with malformed JSON → BadRequest, no round-trip', async () => {
  const t = new MockTransport();
  const b = new AirNoxTonConnectBridge(t);
  const resp = await b.send({
    method: 'sendTransaction',
    params: ['not json'],
    id: 'req-bad',
  });
  assert.equal(t.calls.length, 0);
  assert.ok('error' in resp);
  if (!('error' in resp)) {
    return;
  }
  assert.equal(resp.error.code, 1);
});

test('send(sendTransaction) with non-[string] params → BadRequest, no round-trip', async () => {
  const t = new MockTransport();
  const b = new AirNoxTonConnectBridge(t);
  // A dApp can send a malformed params shape at runtime despite the [string] type;
  // the explicit guard rejects it cleanly instead of relying on JSON.parse to throw.
  const resp = await b.send({
    method: 'sendTransaction',
    params: [] as unknown as [string], // no payload element
    id: 'req-empty',
  });
  assert.equal(t.calls.length, 0); // never forwarded to the desktop
  assert.ok('error' in resp);
  if (!('error' in resp)) {
    return;
  }
  assert.equal(resp.error.code, 1);
  assert.match(resp.error.message, /single JSON string/i);
});

test('send(signData) parses params[0] JSON, returns the full signData reply echoing the id', async () => {
  const t = new MockTransport();
  const reply: SignDataResult = {
    signature: 'c2lnQjY0',
    address: '0:cafe',
    timestamp: 1703980800,
    domain: 'app.ston.fi',
    payload: { type: 'text', text: 'Hello, TON!' },
  };
  t.result = reply;
  const b = new AirNoxTonConnectBridge(t);

  const payload = JSON.stringify({ type: 'text', text: 'Hello, TON!' });
  const req: SignDataRpcRequest = {
    method: 'signData',
    params: [payload],
    id: 'sd-1',
  };
  const resp = await b.send(req);

  assert.equal(t.calls[0].ns, 'tonconnect');
  assert.equal(t.calls[0].method, 'tonConnect_signData');
  assert.equal(t.calls[0].chain, TON_MAINNET_CHAIN_URN);
  // The JSON string is parsed into the wire payload object.
  assert.deepEqual(t.calls[0].params, { type: 'text', text: 'Hello, TON!' });
  assert.ok('result' in resp);
  if (!('result' in resp)) {
    return;
  }
  // The whole {signature, address, timestamp, domain, payload} reply is returned.
  assert.deepEqual(resp.result, reply);
  assert.equal(resp.id, 'sd-1'); // the request id is echoed
});

test('send(signData) forwards a cell payload verbatim', async () => {
  const t = new MockTransport();
  t.result = {
    signature: 'S',
    address: '0:1',
    timestamp: 1,
    domain: 'd',
    payload: { type: 'cell', schema: 'x#_ = M;', cell: 'te6ccX' },
  };
  const b = new AirNoxTonConnectBridge(t);

  const payload = { type: 'cell', schema: 'x#_ = M;', cell: 'te6ccX' };
  const resp = await b.send({
    method: 'signData',
    params: [JSON.stringify(payload)],
    id: 'sd-cell',
  });

  assert.equal(t.calls[0].method, 'tonConnect_signData');
  assert.deepEqual(t.calls[0].params, payload);
  assert.ok('result' in resp);
});

test('send(signData) forwards a binary payload verbatim', async () => {
  const t = new MockTransport();
  t.result = {
    signature: 'S',
    address: '0:1',
    timestamp: 1,
    domain: 'd',
    payload: { type: 'binary', bytes: 'SGVsbG8=' },
  };
  const b = new AirNoxTonConnectBridge(t);

  const payload = { type: 'binary', bytes: 'SGVsbG8=' };
  const resp = await b.send({
    method: 'signData',
    params: [JSON.stringify(payload)],
    id: 'sd-bin',
  });

  assert.equal(t.calls[0].method, 'tonConnect_signData');
  assert.deepEqual(t.calls[0].params, payload);
  assert.ok('result' in resp);
});

test('send(signData) maps a wire error to a WalletResponseError echoing the id', async () => {
  const t = new MockTransport();
  t.error = rpcError(ErrorCode.UserRejected, 'rejected');
  const b = new AirNoxTonConnectBridge(t);
  const resp = await b.send({
    method: 'signData',
    params: ['{"type":"text","text":"x"}'],
    id: 'sd-rej',
  });
  assert.ok('error' in resp);
  if (!('error' in resp)) {
    return;
  }
  assert.equal(resp.error.code, 300);
  assert.equal(resp.id, 'sd-rej');
});

test('send(signData) with malformed JSON → BadRequest, no round-trip', async () => {
  const t = new MockTransport();
  const b = new AirNoxTonConnectBridge(t);
  const resp = await b.send({
    method: 'signData',
    params: ['not json'],
    id: 'sd-bad',
  });
  assert.equal(t.calls.length, 0);
  assert.ok('error' in resp);
  if (!('error' in resp)) {
    return;
  }
  assert.equal(resp.error.code, 1);
});

test('send(disconnect) round-trips and returns an empty result', async () => {
  const t = new MockTransport();
  t.result = {};
  const b = new AirNoxTonConnectBridge(t);
  const req: DisconnectRpcRequest = {
    method: 'disconnect',
    params: [],
    id: 'req-d',
  };
  const resp = await b.send(req);
  assert.equal(t.calls[0].method, 'tonConnect_disconnect');
  assert.ok('result' in resp);
  if (!('result' in resp)) {
    return;
  }
  assert.deepEqual(resp.result, {});
  assert.equal(resp.id, 'req-d');
});

test('disconnect() is a fire-and-forget wire disconnect', () => {
  const t = new MockTransport();
  const b = new AirNoxTonConnectBridge(t);
  b.disconnect();
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].method, 'tonConnect_disconnect');
  assert.deepEqual(t.calls[0].params, {});
});

test('listen receives a desktop disconnect push; unsubscribe stops it', () => {
  const t = new MockTransport();
  const b = new AirNoxTonConnectBridge(t);
  const seen: WalletEvent[] = [];
  const unsub = b.listen((ev) => seen.push(ev));

  t.fire('disconnect', {});
  assert.equal(seen.length, 1);
  assert.equal(seen[0].event, 'disconnect');

  // A non-disconnect push is ignored.
  t.fire('accountsChanged', ['0xA']);
  assert.equal(seen.length, 1);

  unsub();
  t.fire('disconnect', {});
  assert.equal(seen.length, 1); // no further delivery after unsubscribe
});

test('a disconnect push for ANOTHER namespace is ignored', () => {
  const t = new MockTransport();
  const b = new AirNoxTonConnectBridge(t);
  const seen: WalletEvent[] = [];
  b.listen((ev) => seen.push(ev));

  // A foreign-ns disconnect (Wallet-Standard here) sharing the window must NOT
  // disconnect the TON Connect session.
  t.fireNs('wstd', 'disconnect', {});
  assert.equal(seen.length, 0); // no disconnect WalletEvent was delivered

  // The bridge still reacts to its OWN-namespace disconnect.
  t.fire('disconnect', {});
  assert.equal(seen.length, 1);
  assert.equal(seen[0].event, 'disconnect');
});

test('multiple listeners all receive the disconnect push', () => {
  const t = new MockTransport();
  const b = new AirNoxTonConnectBridge(t);
  let a = 0;
  let c = 0;
  b.listen(() => (a += 1));
  b.listen(() => (c += 1));
  t.fire('disconnect', {});
  assert.equal(a, 1);
  assert.equal(c, 1);
});

// Reference: ensure ConnectEvent narrowing compiles against the exported type.
const _typecheck: ConnectEvent = {
  event: 'connect_error',
  id: 0,
  payload: { code: 0, message: '' },
};
void _typecheck;
