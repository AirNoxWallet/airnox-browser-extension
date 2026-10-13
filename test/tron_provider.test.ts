import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AirNoxTronProvider } from '../src/inpage/tron_provider';
import {
  MhdaNetwork,
  TRON_MAINNET_CHAIN_URN,
  chainKey,
} from '../src/protocol/chains';
import { ErrorCode, Namespace } from '../src/protocol/envelope';
import { EventHandler, Transport } from '../src/inpage/transport';

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

  // Test helper: a desktop push reaching the provider on ITS OWN namespace (the
  // common case — call sites stay namespace-agnostic).
  fire(event: string, data: unknown, chain?: string): void {
    this.handler?.('tron', event, data, chain);
  }

  // A push for ANOTHER chain's provider arriving on the shared window.
  fireNs(ns: Namespace, event: string, data: unknown): void {
    this.handler?.(ns, event, data);
  }
}

// The abandon-mnemonic TRON account 0 (the desktop's known-answer value): the base58 address
// and its 41-prefixed hex form.
const ADDR_B58 = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH';
const ADDR_HEX = '41c8599111f29c1e1e061265b4af93ea1f274ad78a';

test('before connect: not ready, defaultAddress is the false sentinel', () => {
  const t = new MockTransport();
  const p = new AirNoxTronProvider(t);
  assert.equal(p.ready, false);
  assert.equal(p.connectedAddress, null);
  assert.deepEqual(p.defaultAddress(), {
    base58: false,
    hex: false,
    name: false,
  });
});

test('tron_requestAccounts forwards over the tron ns + caches the account', async () => {
  const t = new MockTransport();
  t.result = [ADDR_B58];
  const p = new AirNoxTronProvider(t);

  const res = await p.request({ method: 'tron_requestAccounts' });
  assert.deepEqual(res, [ADDR_B58]);

  // Forwarded verbatim over the tron namespace + mainnet chain.
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].ns, 'tron');
  assert.equal(t.calls[0].method, 'tron_requestAccounts');
  assert.equal(t.calls[0].chain, TRON_MAINNET_CHAIN_URN);

  // Connected: ready + defaultAddress (base58 + the 41-hex form).
  assert.equal(p.ready, true);
  assert.equal(p.connectedAddress, ADDR_B58);
  assert.deepEqual(p.defaultAddress(), {
    base58: ADDR_B58,
    hex: ADDR_HEX,
    name: false,
  });
});

test('a non-connect request forwards over the tron ns without caching', async () => {
  const t = new MockTransport();
  t.result = 'deadbeef';
  const p = new AirNoxTronProvider(t);

  const sig = await p.request({
    method: 'tron_signMessageV2',
    params: { address: ADDR_B58, message: '0x68656c6c6f' },
  });
  assert.equal(sig, 'deadbeef');
  assert.equal(t.calls[0].ns, 'tron');
  assert.equal(t.calls[0].method, 'tron_signMessageV2');
  assert.equal(t.calls[0].chain, TRON_MAINNET_CHAIN_URN);
  // No account cached from a non-connect method.
  assert.equal(p.ready, false);
});

test('connect emits connect (first time) + accountsChanged', async () => {
  const t = new MockTransport();
  t.result = [ADDR_B58];
  const p = new AirNoxTronProvider(t);

  const events: Array<{ name: string; arg: unknown }> = [];
  p.on('connect', (arg) => events.push({ name: 'connect', arg }));
  p.on('accountsChanged', (arg) =>
    events.push({ name: 'accountsChanged', arg })
  );

  await p.request({ method: 'tron_requestAccounts' });
  assert.deepEqual(events, [
    { name: 'connect', arg: { address: ADDR_B58 } },
    { name: 'accountsChanged', arg: [ADDR_B58] },
  ]);

  // A second connect to the SAME account does not re-fire connect or
  // accountsChanged (deduped — no spurious events).
  events.length = 0;
  await p.request({ method: 'tron_requestAccounts' });
  assert.deepEqual(events, []);
});

test('a desktop accountsChanged push updates the cached account + re-emits', () => {
  const t = new MockTransport();
  const p = new AirNoxTronProvider(t);

  const seen: unknown[] = [];
  p.on('accountsChanged', (arg) => seen.push(arg));

  t.fire('accountsChanged', [ADDR_B58]);
  assert.equal(p.connectedAddress, ADDR_B58);
  assert.deepEqual(seen, [[ADDR_B58]]);

  // A no-op push (same account) does not re-emit.
  t.fire('accountsChanged', [ADDR_B58]);
  assert.deepEqual(seen, [[ADDR_B58]]);

  // An empty push disconnects.
  t.fire('accountsChanged', []);
  assert.equal(p.connectedAddress, null);
  assert.equal(p.ready, false);
});

test('a pushed accountsChanged for ANOTHER namespace is ignored', async () => {
  const t = new MockTransport();
  t.result = [ADDR_B58];
  const p = new AirNoxTronProvider(t);

  // Connect so the TRON account is set, then register the listener with a counter.
  await p.request({ method: 'tron_requestAccounts' });
  const seen: unknown[] = [];
  p.on('accountsChanged', (arg) => seen.push(arg));

  // A foreign-ns push (EVM here) sharing the window must NOT touch the TRON shim.
  t.fireNs('evm', 'accountsChanged', ['0xEvmAddress']);

  // The listener did NOT fire, and the cached account is UNCHANGED.
  assert.deepEqual(seen, []);
  assert.equal(p.connectedAddress, ADDR_B58);
});

// The desktop tags an accountsChanged push with the chain whose grant changed.
// The shim serves TRON mainnet only, so a push about Shasta says nothing about
// the account it holds.
const SHASTA_CHAIN_URN = chainKey(MhdaNetwork.Tron, 'shasta');

test('a pushed accountsChanged for ANOTHER TRON chain is ignored', async () => {
  const t = new MockTransport();
  t.result = [ADDR_B58];
  const p = new AirNoxTronProvider(t);
  await p.request({ method: 'tron_requestAccounts' });

  const seen: unknown[] = [];
  p.on('accountsChanged', (arg) => seen.push(arg));
  t.fire('accountsChanged', [], SHASTA_CHAIN_URN);
  assert.deepEqual(seen, []);
  assert.equal(p.connectedAddress, ADDR_B58);
  assert.equal(p.ready, true);
});

test('a pushed accountsChanged naming TRON mainnet, or no chain, applies', async () => {
  const t = new MockTransport();
  t.result = [ADDR_B58];
  const p = new AirNoxTronProvider(t);
  await p.request({ method: 'tron_requestAccounts' });

  const seen: unknown[] = [];
  p.on('accountsChanged', (arg) => seen.push(arg));
  t.fire('accountsChanged', [], TRON_MAINNET_CHAIN_URN);
  // An empty chain (a push not tied to one) and a missing one (a pre-chain
  // desktop) are not a mismatch.
  t.fire('accountsChanged', [ADDR_B58], '');
  t.fire('accountsChanged', []);
  assert.deepEqual(seen, [[], [ADDR_B58], []]);
  assert.equal(p.connectedAddress, null);
});

test('a request without a method rejects MalformedRequest', async () => {
  const t = new MockTransport();
  const p = new AirNoxTronProvider(t);
  await assert.rejects(
    () => p.request({} as unknown as { method: string }),
    (e: unknown) => (e as { code?: number }).code === ErrorCode.MalformedRequest
  );
  assert.equal(t.calls.length, 0);
});

// Connect the provider (so the trx.* methods have a signer) and clear the
// recorded call so the trx assertions see only their own send.
async function connected(t: MockTransport): Promise<AirNoxTronProvider> {
  t.result = [ADDR_B58];
  const p = new AirNoxTronProvider(t);
  await p.request({ method: 'tron_requestAccounts' });
  t.calls.length = 0;
  return p;
}

test('trx.signMessageV2 UTF-8-frames a string + forwards 0x-hex', async () => {
  const t = new MockTransport();
  const p = await connected(t);
  t.result = '0xabcd';

  const sig = await p.signMessageV2('hello');
  assert.equal(sig, '0xabcd');

  assert.equal(t.calls[0].ns, 'tron');
  assert.equal(t.calls[0].method, 'tron_signMessageV2');
  assert.equal(t.calls[0].chain, TRON_MAINNET_CHAIN_URN);
  // "hello" → UTF-8 bytes → 0x-hex; the signer is the connected account.
  assert.deepEqual(t.calls[0].params, {
    address: ADDR_B58,
    message: '0x68656c6c6f',
  });
});

test('trx.signMessageV2 forwards raw Uint8Array bytes as 0x-hex', async () => {
  const t = new MockTransport();
  const p = await connected(t);
  t.result = '0x00';

  await p.signMessageV2(new Uint8Array([0x00, 0xde, 0xad]));
  assert.deepEqual(t.calls[0].params, {
    address: ADDR_B58,
    message: '0x00dead',
  });
});

test('trx.signMessageV2 before connect rejects Unauthorized', async () => {
  const t = new MockTransport();
  const p = new AirNoxTronProvider(t);
  await assert.rejects(
    () => p.signMessageV2('hello'),
    (e: unknown) => (e as { code?: number }).code === ErrorCode.Unauthorized
  );
  assert.equal(t.calls.length, 0);
});

test('trx.sign JSON-stringifies the tx + appends the bare sig to signature[]', async () => {
  const t = new MockTransport();
  const p = await connected(t);
  t.result = 'deadbeefsig';

  const tx = { txID: 'ab', raw_data_hex: '0a02abcd' };
  const signed = await p.sign(tx);

  // Forwarded over the tron ns with the tx JSON-stringified (the desktop's sign
  // contract takes a string payload) + the connected signer.
  assert.equal(t.calls[0].method, 'tron_signTransaction');
  assert.deepEqual(t.calls[0].params, {
    address: ADDR_B58,
    transaction: JSON.stringify(tx),
  });
  // The extension assembled the signed tx (bare sig appended to signature[]).
  assert.deepEqual(signed, { ...tx, signature: ['deadbeefsig'] });
});

test('trx.sign appends to an EXISTING signature[] (multisig-safe)', async () => {
  const t = new MockTransport();
  const p = await connected(t);
  t.result = 'sig2';

  const tx = { txID: 'ab', signature: ['sig1'] };
  const signed = await p.sign(tx);
  assert.deepEqual(signed.signature, ['sig1', 'sig2']);
});

test('trx.sign rejects a non-object tx + a non-string sign result', async () => {
  const t = new MockTransport();
  const p = await connected(t);

  await assert.rejects(
    () => p.sign(null as unknown as { signature?: string[] }),
    (e: unknown) => (e as { code?: number }).code === ErrorCode.MalformedRequest
  );

  // A non-string desktop result is an internal contract violation.
  t.result = { not: 'a string' };
  await assert.rejects(
    () => p.sign({ txID: 'ab' }),
    (e: unknown) => (e as { code?: number }).code === ErrorCode.Internal
  );
});

test('trx.sendRawTransaction forwards the tx OBJECT + returns the node response verbatim', async () => {
  const t = new MockTransport();
  const p = await connected(t);

  // Acceptance: the node response is returned verbatim (the dApp checks .result).
  t.result = { result: true, txid: 'ab' };
  const ok = await p.sendRawTransaction({ txID: 'ab', signature: ['s'] });
  assert.deepEqual(ok, { result: true, txid: 'ab' });
  assert.equal(t.calls[0].method, 'tron_sendRawTransaction');
  // The signed tx rides as an OBJECT (not stringified) — the broadcast contract.
  assert.deepEqual(t.calls[0].params, {
    transaction: { txID: 'ab', signature: ['s'] },
  });

  // A node REJECTION is also returned verbatim, NOT thrown (TronWeb-faithful).
  t.result = { result: false, code: 'SIGERROR', message: 'bad sig' };
  const rejected = await p.sendRawTransaction({ txID: 'ab' });
  assert.deepEqual(rejected, {
    result: false,
    code: 'SIGERROR',
    message: 'bad sig',
  });
});

test('trx.sendRawTransaction rejects a non-object tx', async () => {
  const t = new MockTransport();
  const p = await connected(t);
  await assert.rejects(
    () =>
      p.sendRawTransaction(undefined as unknown as { signature?: string[] }),
    (e: unknown) => (e as { code?: number }).code === ErrorCode.MalformedRequest
  );
});

// ── a 4100 means the desktop no longer grants this origin ───────────────────
// Mirror of the EVM provider: a session-only desktop grant gone after a restart
// leaves the shim reporting a connected account the desktop refuses. The
// desktop's Unauthorized is the page's only signal, so the shim forgets the
// account on it, and the dApp still receives the refusal.

const wireError = (code: number, message = 'refused'): Error =>
  Object.assign(new Error(message), { code });

test('a 4100 answer forgets the connected account and emits accountsChanged([]) once', async () => {
  const t = new MockTransport();
  const p = await connected(t);
  const seen: unknown[] = [];
  p.on('accountsChanged', (arg) => seen.push(arg));

  t.error = wireError(
    ErrorCode.Unauthorized,
    'address is not authorized to sign for this origin'
  );
  await assert.rejects(
    () => p.sign({ txID: 'ab', raw_data_hex: '0a02' }),
    (e: unknown) => (e as { code?: number }).code === ErrorCode.Unauthorized
  );

  assert.deepEqual(seen, [[]]);
  assert.equal(p.ready, false);
  assert.equal(p.connectedAddress, null);
  assert.deepEqual(p.defaultAddress(), {
    base58: false,
    hex: false,
    name: false,
  });

  // The broadcast path is gated by the grant alone and answers the same code;
  // nothing is cached any more, so no second event.
  await assert.rejects(
    () => p.sendRawTransaction({ txID: 'ab', signature: ['00'] }),
    (e: unknown) => (e as { code?: number }).code === ErrorCode.Unauthorized
  );
  assert.deepEqual(seen, [[]]);
});

test('a 4100 with no connected account emits no accountsChanged', async () => {
  const t = new MockTransport();
  const p = new AirNoxTronProvider(t);
  let count = 0;
  p.on('accountsChanged', () => count++);

  t.error = wireError(
    ErrorCode.Unauthorized,
    'origin is not connected for this chain'
  );
  await assert.rejects(
    () => p.sendRawTransaction({ txID: 'ab', signature: ['00'] }),
    (e: unknown) => (e as { code?: number }).code === ErrorCode.Unauthorized
  );

  assert.equal(count, 0);
  assert.equal(p.ready, false);
});

test('a disconnect or any other refusal keeps the connected account', async () => {
  const t = new MockTransport();
  const p = await connected(t);
  let count = 0;
  p.on('accountsChanged', () => count++);

  for (const code of [
    ErrorCode.Disconnected,
    ErrorCode.UserRejected,
    ErrorCode.WalletLocked,
    ErrorCode.NotPaired,
    ErrorCode.Internal,
  ]) {
    t.error = wireError(code);
    await assert.rejects(
      () => p.signMessageV2('hello'),
      (e: unknown) => (e as { code?: number }).code === code
    );
  }

  assert.equal(count, 0);
  assert.equal(p.connectedAddress, ADDR_B58);
});
