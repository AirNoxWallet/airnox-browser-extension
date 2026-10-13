import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CHAIN_ID_HEX,
  AirNoxEvmProvider,
} from '../src/inpage/evm_provider';
import {
  EVM_MAINNET_CHAIN_URN,
  MhdaNetwork,
  chainKey,
} from '../src/protocol/chains';
import { ErrorCode, Namespace } from '../src/protocol/envelope';
import { AirNoxSolanaWallet } from '../src/inpage/solana_wallet';
import { AirNoxSuiWallet } from '../src/inpage/sui_wallet';
import { AirNoxTronProvider } from '../src/inpage/tron_provider';
import { EventHandler, Transport } from '../src/inpage/transport';
import { Wallet, WalletAccount } from '../src/inpage/wallet_standard';

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

  // Test helper: simulate a desktop push reaching the provider on ITS OWN
  // namespace (the common case — call sites stay namespace-agnostic).
  fire(event: string, data: unknown, chain?: string): void {
    this.handler?.('evm', event, data, chain);
  }

  // Simulate a push for ANOTHER chain's provider arriving on the shared window.
  fireNs(ns: Namespace, event: string, data: unknown): void {
    this.handler?.(ns, event, data);
  }
}

test('eth_chainId is answered locally without a round-trip', async () => {
  const t = new MockTransport();
  const p = new AirNoxEvmProvider(t);
  assert.equal(
    await p.request({ method: 'eth_chainId' }),
    DEFAULT_CHAIN_ID_HEX
  );
  assert.equal(t.calls.length, 0);
});

test('net_version returns the decimal chain id locally', async () => {
  const t = new MockTransport();
  const p = new AirNoxEvmProvider(t);
  assert.equal(await p.request({ method: 'net_version' }), '1');
  assert.equal(t.calls.length, 0);
});

test('net_version keeps full precision for a chain id above 2^53', async () => {
  const t = new MockTransport();
  // 2^53 + 1 = 0x20000000000001. parseInt(hex,16) would round this down to
  // 2^53; BigInt preserves it (see normaliseChainId).
  const p = new AirNoxEvmProvider(t, EVM_MAINNET_CHAIN_URN, '0x20000000000001');
  assert.equal(await p.request({ method: 'net_version' }), '9007199254740993');
});

test('eth_accounts is empty before connect and never prompts', async () => {
  const t = new MockTransport();
  const p = new AirNoxEvmProvider(t);
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), []);
  assert.equal(t.calls.length, 0);
});

test('eth_requestAccounts round-trips on the evm ns + URN chain, then caches', async () => {
  const t = new MockTransport();
  t.result = ['0xAbC0000000000000000000000000000000000001'];
  const p = new AirNoxEvmProvider(t);

  const connects: unknown[] = [];
  const changes: unknown[] = [];
  p.on('connect', (info) => connects.push(info));
  p.on('accountsChanged', (a) => changes.push(a));

  const result = await p.request({ method: 'eth_requestAccounts' });

  assert.deepEqual(result, ['0xAbC0000000000000000000000000000000000001']);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].ns, 'evm');
  assert.equal(t.calls[0].method, 'eth_requestAccounts');
  assert.equal(t.calls[0].chain, EVM_MAINNET_CHAIN_URN);

  // events fired once
  assert.deepEqual(connects, [{ chainId: DEFAULT_CHAIN_ID_HEX }]);
  assert.deepEqual(changes, [['0xAbC0000000000000000000000000000000000001']]);

  // eth_accounts now reflects the granted set, still without a round-trip
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), [
    '0xAbC0000000000000000000000000000000000001',
  ]);
  assert.equal(t.calls.length, 1);
});

test('a second connect with the same accounts re-fires neither connect nor change', async () => {
  const t = new MockTransport();
  t.result = ['0xAbC0000000000000000000000000000000000001'];
  const p = new AirNoxEvmProvider(t);

  let connectCount = 0;
  let changeCount = 0;
  p.on('connect', () => connectCount++);
  p.on('accountsChanged', () => changeCount++);

  await p.request({ method: 'eth_requestAccounts' });
  await p.request({ method: 'eth_requestAccounts' });

  assert.equal(connectCount, 1, 'connect fires once');
  assert.equal(
    changeCount,
    1,
    'accountsChanged fires once for an unchanged set'
  );
});

test('changed accounts fire accountsChanged but not a second connect', async () => {
  const t = new MockTransport();
  t.result = ['0xAAa0000000000000000000000000000000000001'];
  const p = new AirNoxEvmProvider(t);

  let connectCount = 0;
  const changes: unknown[] = [];
  p.on('connect', () => connectCount++);
  p.on('accountsChanged', (a) => changes.push(a));

  await p.request({ method: 'eth_requestAccounts' });
  t.result = ['0xBBb0000000000000000000000000000000000002'];
  await p.request({ method: 'eth_requestAccounts' });

  assert.equal(connectCount, 1);
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[1], ['0xBBb0000000000000000000000000000000000002']);
});

test('an empty eth_requestAccounts result emits no events and stays disconnected', async () => {
  const t = new MockTransport();
  t.result = [];
  const p = new AirNoxEvmProvider(t);

  let events = 0;
  p.on('connect', () => events++);
  p.on('accountsChanged', () => events++);

  assert.deepEqual(await p.request({ method: 'eth_requestAccounts' }), []);
  assert.equal(events, 0, 'no connect / accountsChanged for an empty grant');
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), []);
});

test('a non-array eth_requestAccounts result is coerced to empty, no events', async () => {
  const t = new MockTransport();
  t.result = null;
  const p = new AirNoxEvmProvider(t);

  let events = 0;
  p.on('connect', () => events++);
  p.on('accountsChanged', () => events++);

  await p.request({ method: 'eth_requestAccounts' });
  assert.equal(events, 0);
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), []);
});

test('a non-account method round-trips and is not cached', async () => {
  const t = new MockTransport();
  t.result = '0xsignature';
  const p = new AirNoxEvmProvider(t);

  const sig = await p.request({
    method: 'personal_sign',
    params: ['0xdeadbeef', '0xAbC'],
  });

  assert.equal(sig, '0xsignature');
  assert.equal(t.calls[0].ns, 'evm');
  assert.equal(t.calls[0].method, 'personal_sign');
  assert.equal(t.calls[0].chain, EVM_MAINNET_CHAIN_URN);
  // unchanged connect state
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), []);
});

test('a request with no method rejects with MalformedRequest', async () => {
  const t = new MockTransport();
  const p = new AirNoxEvmProvider(t);
  await assert.rejects(
    () => p.request({} as { method: string }),
    (e: unknown) => {
      assert.equal((e as { code: number }).code, ErrorCode.MalformedRequest);
      return true;
    }
  );
  assert.equal(t.calls.length, 0);
});

test('a desktop wire error propagates to the caller', async () => {
  const t = new MockTransport();
  t.error = Object.assign(new Error('user rejected'), {
    code: ErrorCode.UserRejected,
  });
  const p = new AirNoxEvmProvider(t);
  await assert.rejects(
    () => p.request({ method: 'eth_requestAccounts' }),
    (e: unknown) => {
      assert.equal((e as { code: number }).code, ErrorCode.UserRejected);
      return true;
    }
  );
});

const A1 = '0xAaa0000000000000000000000000000000000001';
const A2 = '0xBbb0000000000000000000000000000000000002';

test('a pushed accountsChanged updates eth_accounts and emits', async () => {
  const t = new MockTransport();
  t.result = [A1];
  const p = new AirNoxEvmProvider(t);
  await p.request({ method: 'eth_requestAccounts' }); // connected [A1]

  const changes: unknown[] = [];
  p.on('accountsChanged', (a) => changes.push(a));

  t.fire('accountsChanged', [A2]);
  assert.deepEqual(changes, [[A2]]);
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), [A2]);
});

test('a pushed accountsChanged for ANOTHER namespace is ignored', async () => {
  const t = new MockTransport();
  t.result = [A1];
  const p = new AirNoxEvmProvider(t);
  await p.request({ method: 'eth_requestAccounts' }); // connected [A1]

  let count = 0;
  p.on('accountsChanged', () => count++);
  // A Wallet-Standard (Solana / Sui) accountsChanged sharing the window must not
  // touch the EVM provider — without the ns filter this would set accounts to [].
  t.fireNs('wstd', 'accountsChanged', ['SoLaNaBase58Address']);
  assert.equal(count, 0);
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), [A1]);
});

test('a pushed accountsChanged with the same set does not re-emit', async () => {
  const t = new MockTransport();
  t.result = [A1];
  const p = new AirNoxEvmProvider(t);
  await p.request({ method: 'eth_requestAccounts' });

  let count = 0;
  p.on('accountsChanged', () => count++);
  t.fire('accountsChanged', [A1.toLowerCase()]); // same set, different case
  assert.equal(count, 0);
});

test('a pushed empty accountsChanged clears the account set', async () => {
  const t = new MockTransport();
  t.result = [A1];
  const p = new AirNoxEvmProvider(t);
  await p.request({ method: 'eth_requestAccounts' });

  const changes: unknown[] = [];
  p.on('accountsChanged', (a) => changes.push(a));
  t.fire('accountsChanged', []); // eligibility revoked → empty set
  assert.deepEqual(changes, [[]]);
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), []);
});

// The desktop tags an accountsChanged push with the chain whose grant changed
// (in its dispatcher). The provider holds the
// accounts of its ACTIVE chain only, so a push about another EVM chain says
// nothing about them.
const SEPOLIA_CHAIN_URN = chainKey(MhdaNetwork.Evm, '11155111');
const POLYGON_CHAIN_URN = chainKey(MhdaNetwork.Evm, '137');

test('a pushed accountsChanged for ANOTHER EVM chain is ignored', async () => {
  const t = new MockTransport();
  t.result = [A1];
  const p = new AirNoxEvmProvider(t);
  await p.request({ method: 'eth_requestAccounts' }); // connected [A1] on mainnet

  const changes: unknown[] = [];
  p.on('accountsChanged', (a) => changes.push(a));
  t.fire('accountsChanged', [A2], SEPOLIA_CHAIN_URN);
  t.fire('accountsChanged', [], SEPOLIA_CHAIN_URN);
  assert.deepEqual(changes, []);
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), [A1]);
});

test('a pushed accountsChanged naming the active chain, or none, applies', async () => {
  const t = new MockTransport();
  t.result = [A1];
  const p = new AirNoxEvmProvider(t);
  await p.request({ method: 'eth_requestAccounts' });

  const changes: unknown[] = [];
  p.on('accountsChanged', (a) => changes.push(a));
  t.fire('accountsChanged', [A2], EVM_MAINNET_CHAIN_URN);
  // An empty chain is a push not tied to one (the desktop serializes it as "");
  // a missing one is a pre-chain desktop. Neither is a mismatch.
  t.fire('accountsChanged', [A1], '');
  t.fire('accountsChanged', [A2]);
  assert.deepEqual(changes, [[A2], [A1], [A2]]);
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), [A2]);
});

test('after a switch, accountsChanged pushes follow the adopted chain', async () => {
  const t = new MockTransport();
  t.result = [A1];
  const p = new AirNoxEvmProvider(t);
  await p.request({ method: 'eth_requestAccounts' });
  t.result = POLYGON_CHAIN_URN;
  await p.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: '0x89' }],
  });

  const changes: unknown[] = [];
  p.on('accountsChanged', (a) => changes.push(a));
  // The chain the provider left is now "another chain".
  t.fire('accountsChanged', [], EVM_MAINNET_CHAIN_URN);
  assert.deepEqual(changes, []);
  // The live set on the target — what the desktop pushes right after the
  // switch's answer — applies.
  t.fire('accountsChanged', [A2], POLYGON_CHAIN_URN);
  assert.deepEqual(changes, [[A2]]);
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), [A2]);
});

test('after a pushed chainChanged, accountsChanged pushes follow the new chain', async () => {
  const t = new MockTransport();
  t.result = [A1];
  const p = new AirNoxEvmProvider(t);
  await p.request({ method: 'eth_requestAccounts' });
  t.fire('chainChanged', '0x89', POLYGON_CHAIN_URN);

  const changes: unknown[] = [];
  p.on('accountsChanged', (a) => changes.push(a));
  t.fire('accountsChanged', [A2], EVM_MAINNET_CHAIN_URN);
  assert.deepEqual(changes, []);
  t.fire('accountsChanged', [A2], POLYGON_CHAIN_URN);
  assert.deepEqual(changes, [[A2]]);
});

test('an unknown pushed event is ignored', () => {
  const t = new MockTransport();
  const p = new AirNoxEvmProvider(t);
  let accounts = 0;
  let chains = 0;
  p.on('accountsChanged', () => accounts++);
  p.on('chainChanged', () => chains++);
  t.fire('somethingElse', { foo: 'bar' });
  assert.equal(accounts, 0);
  assert.equal(chains, 0);
});

test('a pushed chainChanged adopts the new chainId + wire URN and emits; a no-op does not', async () => {
  const t = new MockTransport();
  const p = new AirNoxEvmProvider(t);
  const chains: unknown[] = [];
  p.on('chainChanged', (c) => chains.push(c));

  // Contract: data = the new EIP-1193 chainId (0x-hex); chain = the new chain-key
  // URN (the wallet's SSOT chain identity).
  t.fire('chainChanged', '0x89', 'nt:evm:ci:137');
  assert.deepEqual(chains, ['0x89']);
  assert.equal(await p.request({ method: 'eth_chainId' }), '0x89');

  // The adopted URN becomes the wire chain for a subsequent round-trip request.
  await p.request({ method: 'personal_sign', params: ['0xmsg', '0xacc'] });
  assert.equal(t.calls[t.calls.length - 1].chain, 'nt:evm:ci:137');

  // A no-op push (same chainId) does not re-emit.
  t.fire('chainChanged', '0x89', 'nt:evm:ci:137');
  assert.equal(chains.length, 1);
});

test('a pushed chainChanged with a malformed chainId or a missing URN is ignored', () => {
  const t = new MockTransport();
  const p = new AirNoxEvmProvider(t);
  let count = 0;
  p.on('chainChanged', () => count++);
  t.fire('chainChanged', 'not-hex', 'nt:evm:ci:137'); // bad chainId
  t.fire('chainChanged', 42, 'nt:evm:ci:137'); // non-string chainId
  t.fire('chainChanged', '0x89'); // no chain URN → incomplete, ignored
  assert.equal(count, 0);
});

test('wallet_switchEthereumChain adopts the resolved chain + emits chainChanged', async () => {
  const t = new MockTransport();
  t.result = 'nt:evm:ci:137'; // desktop returns the resolved chain-key
  const p = new AirNoxEvmProvider(t);

  const changes: unknown[] = [];
  p.on('chainChanged', (c) => changes.push(c));

  const res = await p.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: '0x89' }],
  });

  assert.equal(res, null, 'EIP-3326 result is null to the dApp');
  // round-tripped on the evm ns with the OLD chain urn.
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].method, 'wallet_switchEthereumChain');
  assert.equal(t.calls[0].chain, EVM_MAINNET_CHAIN_URN);
  // chainChanged emitted with the canonical chainId.
  assert.deepEqual(changes, ['0x89']);
  // eth_chainId / net_version now reflect the switch (answered locally).
  assert.equal(await p.request({ method: 'eth_chainId' }), '0x89');
  assert.equal(await p.request({ method: 'net_version' }), '137');
  // a subsequent round-trip rides the NEW chain urn.
  await p.request({ method: 'eth_call', params: [] });
  assert.equal(t.calls[1].chain, 'nt:evm:ci:137');
});

test('wallet_switchEthereumChain canonicalises a non-canonical chainId', async () => {
  const t = new MockTransport();
  t.result = 'nt:evm:ci:137';
  const p = new AirNoxEvmProvider(t);
  const changes: unknown[] = [];
  p.on('chainChanged', (c) => changes.push(c));

  await p.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: '0x089' }], // leading zero
  });
  assert.deepEqual(changes, ['0x89']);
  assert.equal(await p.request({ method: 'eth_chainId' }), '0x89');
});

test('a rejected wallet_switchEthereumChain leaves the active chain unchanged', async () => {
  const t = new MockTransport();
  t.error = Object.assign(new Error('unrecognized chain'), {
    code: ErrorCode.UnrecognizedChain,
  });
  const p = new AirNoxEvmProvider(t);
  let changed = 0;
  p.on('chainChanged', () => changed++);

  await assert.rejects(
    () =>
      p.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x270f' }],
      }),
    (e: unknown) => {
      assert.equal((e as { code: number }).code, ErrorCode.UnrecognizedChain);
      return true;
    }
  );
  assert.equal(changed, 0, 'no chainChanged on a failed switch');
  // chain unchanged.
  assert.equal(
    await p.request({ method: 'eth_chainId' }),
    DEFAULT_CHAIN_ID_HEX
  );
});

test('wallet_switchEthereumChain: a malformed switch result rejects, no half-adoption', async () => {
  const t = new MockTransport();
  t.result = 12345; // desktop contract breach: not a chain-key URN string
  const p = new AirNoxEvmProvider(t);
  let changed = 0;
  p.on('chainChanged', () => changed++);

  await assert.rejects(
    () =>
      p.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x89' }],
      }),
    (e: unknown) => {
      assert.equal((e as { code: number }).code, ErrorCode.Internal);
      return true;
    }
  );
  // ALL-OR-NOTHING: neither the EIP-1193 chainId nor the wire chain moved.
  assert.equal(changed, 0, 'no chainChanged on a malformed switch result');
  assert.equal(
    await p.request({ method: 'eth_chainId' }),
    DEFAULT_CHAIN_ID_HEX
  );
  await p.request({ method: 'eth_blockNumber' });
  const last = t.calls[t.calls.length - 1];
  assert.equal(last.chain, EVM_MAINNET_CHAIN_URN); // still the original wire chain
});

test('wallet_switchEthereumChain: a valid chain-key but unparseable params also rejects', async () => {
  // The other arm of the all-or-nothing guard: the desktop returned a valid
  // resolved chain-key, but the request params carry no parseable chainId.
  const t = new MockTransport();
  t.result = 'nt:evm:ci:137';
  const p = new AirNoxEvmProvider(t);
  let changed = 0;
  p.on('chainChanged', () => changed++);

  await assert.rejects(
    () => p.request({ method: 'wallet_switchEthereumChain', params: [] }),
    (e: unknown) => {
      assert.equal((e as { code: number }).code, ErrorCode.Internal);
      return true;
    }
  );
  assert.equal(changed, 0);
  assert.equal(
    await p.request({ method: 'eth_chainId' }),
    DEFAULT_CHAIN_ID_HEX
  );
});

test('connect after a switch carries the new chainId', async () => {
  const t = new MockTransport();
  t.result = 'nt:evm:ci:137';
  const p = new AirNoxEvmProvider(t);
  await p.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: '0x89' }],
  });

  const connects: unknown[] = [];
  p.on('connect', (info) => connects.push(info));
  t.result = ['0xAaa0000000000000000000000000000000000001'];
  await p.request({ method: 'eth_requestAccounts' });

  assert.deepEqual(connects, [{ chainId: '0x89' }]);
});

test('enable() aliases eth_requestAccounts and caches', async () => {
  const t = new MockTransport();
  t.result = [A1];
  const p = new AirNoxEvmProvider(t);
  const accounts = await p.enable();
  assert.deepEqual(accounts, [A1]);
  assert.equal(t.calls[0].method, 'eth_requestAccounts');
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), [A1]);
});

test('sendAsync routes through request and calls back node-style', async () => {
  const t = new MockTransport();
  t.result = '0xsig';
  const p = new AirNoxEvmProvider(t);
  const out = await new Promise<{ error: Error | null; response: unknown }>(
    (resolve) => {
      p.sendAsync(
        { method: 'personal_sign', params: ['0xab'], id: 7 },
        (error, response) => resolve({ error, response })
      );
    }
  );
  assert.equal(out.error, null);
  assert.deepEqual(out.response, { id: 7, jsonrpc: '2.0', result: '0xsig' });
  assert.equal(t.calls[0].method, 'personal_sign');
});

test('sendAsync calls back the error on a wire failure', async () => {
  const t = new MockTransport();
  t.error = Object.assign(new Error('rejected'), {
    code: ErrorCode.UserRejected,
  });
  const p = new AirNoxEvmProvider(t);
  const out = await new Promise<{ error: Error | null; response: unknown }>(
    (resolve) => {
      p.sendAsync({ method: 'eth_requestAccounts', id: 1 }, (error, response) =>
        resolve({ error, response })
      );
    }
  );
  assert.equal(out.response, null);
  assert.equal((out.error as { code?: number })?.code, ErrorCode.UserRejected);
});

test('send(method, params) returns a Promise like request', async () => {
  const t = new MockTransport();
  t.result = '0xsig';
  const p = new AirNoxEvmProvider(t);
  const sig = await p.send('personal_sign', ['0xab']);
  assert.equal(sig, '0xsig');
  assert.equal(t.calls[0].method, 'personal_sign');
});

test('send(payload, callback) behaves like sendAsync', async () => {
  const t = new MockTransport();
  t.result = '0x1';
  const p = new AirNoxEvmProvider(t);
  const resp = await new Promise<unknown>((resolve) => {
    p.send({ method: 'eth_blockNumber', id: 3 }, (_e, r) => resolve(r));
  });
  assert.deepEqual(resp, { id: 3, jsonrpc: '2.0', result: '0x1' });
});

test('synchronous send(payload) answers cached reads with no round-trip', () => {
  const t = new MockTransport();
  const p = new AirNoxEvmProvider(t);
  assert.deepEqual(p.send({ method: 'eth_accounts', id: 1 }), {
    id: 1,
    jsonrpc: '2.0',
    result: [],
  });
  assert.deepEqual(p.send({ method: 'eth_chainId', id: 2 }), {
    id: 2,
    jsonrpc: '2.0',
    result: DEFAULT_CHAIN_ID_HEX,
  });
  assert.deepEqual(p.send({ method: 'net_version', id: 3 }), {
    id: 3,
    jsonrpc: '2.0',
    result: '1',
  });
  assert.equal(t.calls.length, 0);
});

test('synchronous send net_version keeps full precision above 2^53', () => {
  const t = new MockTransport();
  const p = new AirNoxEvmProvider(t, EVM_MAINNET_CHAIN_URN, '0x20000000000001');
  assert.deepEqual(p.send({ method: 'net_version', id: 9 }), {
    id: 9,
    jsonrpc: '2.0',
    result: '9007199254740993', // parseInt would round to 9007199254740992
  });
});

test('synchronous send(payload) throws for a non-cached method', () => {
  const t = new MockTransport();
  const p = new AirNoxEvmProvider(t);
  assert.throws(
    () => p.send({ method: 'eth_call', id: 1 }),
    (e: unknown) => {
      assert.equal((e as { code: number }).code, ErrorCode.UnsupportedMethod);
      return true;
    }
  );
});

test('eth_coinbase agrees across request and synchronous send', async () => {
  const t = new MockTransport();
  t.result = [A1];
  const p = new AirNoxEvmProvider(t);
  // before connect → null both ways, no round-trip.
  assert.equal(await p.request({ method: 'eth_coinbase' }), null);
  assert.deepEqual(p.send({ method: 'eth_coinbase', id: 1 }), {
    id: 1,
    jsonrpc: '2.0',
    result: null,
  });
  assert.equal(t.calls.length, 0);

  await p.request({ method: 'eth_requestAccounts' }); // connect [A1]
  assert.equal(await p.request({ method: 'eth_coinbase' }), A1);
  assert.deepEqual(p.send({ method: 'eth_coinbase', id: 2 }), {
    id: 2,
    jsonrpc: '2.0',
    result: A1,
  });
  assert.equal(t.calls.length, 1, 'only the eth_requestAccounts round-tripped');
});

test('enable() fires connect + accountsChanged', async () => {
  const t = new MockTransport();
  t.result = [A1];
  const p = new AirNoxEvmProvider(t);
  const connects: unknown[] = [];
  const changes: unknown[] = [];
  p.on('connect', (i) => connects.push(i));
  p.on('accountsChanged', (a) => changes.push(a));
  await p.enable();
  assert.deepEqual(connects, [{ chainId: DEFAULT_CHAIN_ID_HEX }]);
  assert.deepEqual(changes, [[A1]]);
});

test('send / sendAsync reject a malformed payload with MalformedRequest', () => {
  const t = new MockTransport();
  const p = new AirNoxEvmProvider(t);
  const noop = (): void => undefined;
  const isMalformed = (e: unknown): boolean => {
    assert.equal((e as { code: number }).code, ErrorCode.MalformedRequest);
    return true;
  };
  assert.throws(() => p.send({ id: 1 } as never), isMalformed); // no method
  assert.throws(() => p.send(null as never), isMalformed); // null payload
  assert.throws(() => p.sendAsync({ id: 1 } as never, noop), isMalformed);
  assert.equal(t.calls.length, 0);
});

// ── a 4100 means the desktop no longer grants this origin ───────────────────
// The desktop keeps a device wallet's grants for its session only, so after a
// desktop restart an open tab still holds the accounts it cached at connect while
// the desktop refuses every request for them with Unauthorized (4100). The
// refusal is the only signal the page gets, so the provider forgets the cache on
// it — and the dApp still receives the refusal itself.

const wireError = (code: number, message = 'refused'): Error =>
  Object.assign(new Error(message), { code });

const hasCode =
  (code: number) =>
  (e: unknown): boolean => {
    assert.equal((e as { code?: number }).code, code);
    return true;
  };

test('a 4100 answer forgets the cached accounts and emits accountsChanged([]) once', async () => {
  const t = new MockTransport();
  t.result = [A1];
  const p = new AirNoxEvmProvider(t);
  await p.request({ method: 'eth_requestAccounts' }); // connected [A1]

  const order: string[] = [];
  const changes: unknown[] = [];
  p.on('accountsChanged', (a) => {
    changes.push(a);
    order.push('accountsChanged');
  });

  t.error = wireError(
    ErrorCode.Unauthorized,
    'address is not authorized to sign for this origin'
  );
  // The refusal still reaches the dApp with its own code — the clear is IN
  // ADDITION to it, never instead of it.
  await assert.rejects(
    () =>
      p
        .request({ method: 'personal_sign', params: ['0x68656c6c6f', A1] })
        .catch((e: unknown) => {
          order.push('rejected');
          throw e;
        }),
    hasCode(ErrorCode.Unauthorized)
  );

  assert.deepEqual(changes, [[]]);
  // The event lands before the dApp's own error handler runs, so a handler that
  // re-reads eth_accounts already sees the empty set.
  assert.deepEqual(order, ['accountsChanged', 'rejected']);
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), []);
  assert.equal(await p.request({ method: 'eth_coinbase' }), null);
  assert.deepEqual(p.send({ method: 'eth_accounts' }).result, []);

  // A second refusal finds nothing cached: no second event.
  await assert.rejects(
    () => p.request({ method: 'eth_blockNumber' }),
    hasCode(ErrorCode.Unauthorized)
  );
  assert.deepEqual(changes, [[]]);
});

test('a 4100 with nothing cached emits no accountsChanged', async () => {
  const t = new MockTransport();
  const p = new AirNoxEvmProvider(t);
  let count = 0;
  p.on('accountsChanged', () => count++);

  t.error = wireError(
    ErrorCode.Unauthorized,
    'origin is not connected for this chain'
  );
  await assert.rejects(
    () => p.request({ method: 'eth_blockNumber' }),
    hasCode(ErrorCode.Unauthorized)
  );

  assert.equal(count, 0);
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), []);
});

test('after a 4100 clear, a fresh connect announces connect + accountsChanged again', async () => {
  const t = new MockTransport();
  t.result = [A1];
  const p = new AirNoxEvmProvider(t);
  await p.request({ method: 'eth_requestAccounts' });

  t.error = wireError(ErrorCode.Unauthorized);
  await assert.rejects(
    () => p.request({ method: 'eth_blockNumber' }),
    hasCode(ErrorCode.Unauthorized)
  );

  const connects: unknown[] = [];
  const changes: unknown[] = [];
  p.on('connect', (i) => connects.push(i));
  p.on('accountsChanged', (a) => changes.push(a));
  t.error = null;
  await p.request({ method: 'eth_requestAccounts' }); // the user re-approves

  assert.deepEqual(connects, [{ chainId: DEFAULT_CHAIN_ID_HEX }]);
  assert.deepEqual(changes, [[A1]]);
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), [A1]);
});

test('a disconnect or any other refusal keeps the cached accounts', async () => {
  // 4900 is what the page sees when the content<->SW port drops (an idle MV3
  // eviction) or the desktop socket closes mid-request — the only
  // "reconnect" the page can observe, and it says nothing about the desktop's
  // grants: the same desktop may answer the next request. Only the desktop's
  // own 4100 says the grant is gone.
  const t = new MockTransport();
  t.result = [A1];
  const p = new AirNoxEvmProvider(t);
  await p.request({ method: 'eth_requestAccounts' });

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
      () => p.request({ method: 'personal_sign', params: ['0x00', A1] }),
      hasCode(code)
    );
  }

  assert.equal(count, 0);
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), [A1]);
});

test('a 4100 on EVM leaves the other providers on the shared transport connected', async () => {
  // All five providers share one transport. The refusal settles only the EVM
  // request, so only the EVM cache may go.
  const t = new MockTransport();
  const evm = new AirNoxEvmProvider(t);
  const tron = new AirNoxTronProvider(t);
  const solana = new AirNoxSolanaWallet(t);
  const sui = new AirNoxSuiWallet(t);
  const connect = (w: Wallet): Promise<unknown> =>
    (
      w.features['standard:connect'] as {
        connect: () => Promise<{ accounts: readonly WalletAccount[] }>;
      }
    ).connect();
  const onChange = (w: Wallet, listener: () => void): void => {
    (
      w.features['standard:events'] as {
        on: (event: string, listener: () => void) => () => void;
      }
    ).on('change', listener);
  };

  const TRON = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH';
  t.result = [A1];
  await evm.request({ method: 'eth_requestAccounts' });
  t.result = [TRON];
  await tron.request({ method: 'tron_requestAccounts' });
  t.result = ['1'.repeat(32)];
  await connect(solana);
  t.result = [{ address: '0x' + 'aa'.repeat(32), publicKey: 'bb'.repeat(32) }];
  await connect(sui);

  const heard: string[] = [];
  evm.on('accountsChanged', () => heard.push('evm'));
  tron.on('accountsChanged', () => heard.push('tron'));
  onChange(solana, () => heard.push('solana'));
  onChange(sui, () => heard.push('sui'));

  t.error = wireError(ErrorCode.Unauthorized);
  await assert.rejects(
    () => evm.request({ method: 'personal_sign', params: ['0x00', A1] }),
    hasCode(ErrorCode.Unauthorized)
  );

  assert.deepEqual(heard, ['evm']);
  assert.deepEqual(await evm.request({ method: 'eth_accounts' }), []);
  assert.equal(tron.connectedAddress, TRON);
  assert.equal(solana.accounts.length, 1);
  assert.equal(sui.accounts.length, 1);
});

// ── the legacy provider properties (chainId / networkVersion / selectedAddress) ─
// MetaMask-era dApps read these straight off window.ethereum instead of asking
// eth_chainId / eth_accounts (testnet.soniclabs.com shows "Wrong network" on a
// provider without `chainId`). They are views of the same cached state the four
// local reads answer from, so they can never disagree with them, and a dApp
// listener reading them inside an event already sees the new value.

const MIXED = '0xAbC0000000000000000000000000000000000001';
const MIXED_2 = '0xDeF0000000000000000000000000000000000002';

const legacy = (
  p: AirNoxEvmProvider
): {
  chainId: string;
  networkVersion: string;
  selectedAddress: string | null;
} => ({
  chainId: p.chainId,
  networkVersion: p.networkVersion,
  selectedAddress: p.selectedAddress,
});

test('legacy properties: the bootstrap chain and no account before connect', () => {
  const p = new AirNoxEvmProvider(new MockTransport());
  assert.deepEqual(legacy(p), {
    chainId: DEFAULT_CHAIN_ID_HEX,
    networkVersion: '1',
    selectedAddress: null,
  });
});

test('legacy properties: networkVersion keeps full precision above 2^53', () => {
  const p = new AirNoxEvmProvider(
    new MockTransport(),
    EVM_MAINNET_CHAIN_URN,
    '0x20000000000001'
  );
  assert.equal(p.chainId, '0x20000000000001');
  assert.equal(p.networkVersion, '9007199254740993');
});

test('legacy properties: a connect sets selectedAddress, lowercase, before its events', async () => {
  const t = new MockTransport();
  t.result = [MIXED, MIXED_2];
  const p = new AirNoxEvmProvider(t);
  const seen: unknown[] = [];
  p.on('connect', () => seen.push(['connect', legacy(p)]));
  p.on('accountsChanged', () => seen.push(['accountsChanged', legacy(p)]));

  await p.request({ method: 'eth_requestAccounts' });

  const after = {
    chainId: DEFAULT_CHAIN_ID_HEX,
    networkVersion: '1',
    selectedAddress: MIXED.toLowerCase(),
  };
  assert.deepEqual(seen, [
    ['connect', after],
    ['accountsChanged', after],
  ]);
  assert.deepEqual(legacy(p), after);
  // The accounts themselves are passed through as the desktop sent them; only
  // the legacy selectedAddress is lowercased, as MetaMask's is.
  assert.deepEqual(await p.request({ method: 'eth_accounts' }), [
    MIXED,
    MIXED_2,
  ]);
});

test('legacy properties: a pushed accountsChanged moves selectedAddress, an empty one clears it', () => {
  const t = new MockTransport();
  const p = new AirNoxEvmProvider(t);
  const seen: unknown[] = [];
  p.on('accountsChanged', () => seen.push(p.selectedAddress));

  t.fire('accountsChanged', [MIXED_2], EVM_MAINNET_CHAIN_URN);
  assert.equal(p.selectedAddress, MIXED_2.toLowerCase());
  // A push about another EVM chain leaves the active chain's account alone.
  t.fire('accountsChanged', [MIXED], 'nt:evm:ci:11155111');
  assert.equal(p.selectedAddress, MIXED_2.toLowerCase());
  t.fire('accountsChanged', [], EVM_MAINNET_CHAIN_URN);
  assert.equal(p.selectedAddress, null);
  assert.deepEqual(seen, [MIXED_2.toLowerCase(), null]);
});

test('legacy properties: a pushed chainChanged moves chainId + networkVersion before its event', () => {
  const t = new MockTransport();
  const p = new AirNoxEvmProvider(t);
  const seen: unknown[] = [];
  p.on('chainChanged', () => seen.push([p.chainId, p.networkVersion]));

  t.fire('chainChanged', '0xFA', 'nt:evm:ci:250');

  assert.deepEqual(seen, [['0xfa', '250']]);
  assert.equal(p.chainId, '0xfa');
  assert.equal(p.networkVersion, '250');
  // A malformed push changes nothing.
  t.fire('chainChanged', 'not-hex', 'nt:evm:ci:1');
  assert.equal(p.chainId, '0xfa');
});

test('legacy properties: wallet_switchEthereumChain moves chainId; a refused one does not', async () => {
  const t = new MockTransport();
  const p = new AirNoxEvmProvider(t);
  const seen: unknown[] = [];
  p.on('chainChanged', () => seen.push([p.chainId, p.networkVersion]));

  t.result = 'nt:evm:ci:146';
  await p.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: '0x92' }],
  });
  assert.deepEqual(seen, [['0x92', '146']]);

  t.error = wireError(4902, 'unrecognized chain');
  await assert.rejects(() =>
    p.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x89' }],
    })
  );
  assert.equal(p.chainId, '0x92');
  assert.equal(p.networkVersion, '146');
});

test('legacy properties: a 4100 clears selectedAddress before accountsChanged([]) fires', async () => {
  const t = new MockTransport();
  t.result = [MIXED];
  const p = new AirNoxEvmProvider(t);
  await p.request({ method: 'eth_requestAccounts' });
  const seen: unknown[] = [];
  p.on('accountsChanged', () => seen.push(p.selectedAddress));

  t.error = wireError(ErrorCode.Unauthorized);
  await assert.rejects(
    () =>
      p.request({ method: 'personal_sign', params: ['0x68656c6c6f', MIXED] }),
    hasCode(ErrorCode.Unauthorized)
  );

  assert.deepEqual(seen, [null]);
  assert.equal(p.selectedAddress, null);
});

test('legacy properties are read-only: an assignment changes neither them nor the wire chain', async () => {
  const t = new MockTransport();
  t.result = [MIXED];
  const p = new AirNoxEvmProvider(t);
  await p.request({ method: 'eth_requestAccounts' });
  const before = legacy(p);

  // Reflect.set reports a refused write instead of throwing, so this holds for a
  // sloppy-mode page (silently ignored) and a strict-mode one (a TypeError) alike.
  assert.equal(Reflect.set(p, 'chainId', '0x5'), false);
  assert.equal(Reflect.set(p, 'networkVersion', '5'), false);
  assert.equal(Reflect.set(p, 'selectedAddress', MIXED_2), false);
  assert.throws(() => {
    (p as unknown as { chainId: string }).chainId = '0x5';
  }, TypeError);

  assert.deepEqual(legacy(p), before);
  assert.equal(
    await p.request({ method: 'eth_chainId' }),
    DEFAULT_CHAIN_ID_HEX
  );
  await p.request({ method: 'personal_sign', params: ['0x68656c6c6f', MIXED] });
  assert.equal(t.calls[t.calls.length - 1].chain, EVM_MAINNET_CHAIN_URN);
});
