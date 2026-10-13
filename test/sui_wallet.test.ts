import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUI_STD_CHAIN, AirNoxSuiWallet } from '../src/inpage/sui_wallet';
import {
  SOLANA_MAINNET_CHAIN_URN,
  SUI_MAINNET_CHAIN_URN,
} from '../src/protocol/chains';
import { Wallet, WalletAccount } from '../src/inpage/wallet_standard';
import { EventHandler, Transport } from '../src/inpage/transport';
import { ErrorCode, Namespace } from '../src/protocol/envelope';

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
    this.handler?.('wstd', event, data, chain);
  }

  // A push for ANOTHER chain's provider arriving on the shared window.
  fireNs(ns: Namespace, event: string, data: unknown): void {
    this.handler?.(ns, event, data);
  }
}

// A Sui connect reply entry: { address, publicKey } where address is the 0x-hex
// Sui address and publicKey is the bare lowercase hex of the 32-byte Ed25519
// pubkey. A Sui address is Blake2b-256(flag||pubkey), so
// the two are independent — the test does not require them to be consistent.
const ADDR_A = '0x' + 'aa'.repeat(32);
const PUB_A = 'bb'.repeat(32);
const ADDR_B = '0x' + 'cc'.repeat(32);
const PUB_B = 'dd'.repeat(32);

function connectFeature(w: Wallet): {
  connect: (input?: {
    silent?: boolean;
  }) => Promise<{ accounts: readonly WalletAccount[] }>;
} {
  return w.features['standard:connect'] as never;
}
function disconnectFeature(w: Wallet): { disconnect: () => Promise<void> } {
  return w.features['standard:disconnect'] as never;
}
function eventsFeature(w: Wallet): {
  on: (event: string, listener: (...args: unknown[]) => void) => () => void;
} {
  return w.features['standard:events'] as never;
}
function signPersonalMessageFeature(w: Wallet): {
  signPersonalMessage: (input: {
    account: WalletAccount;
    message: Uint8Array;
  }) => Promise<{ bytes: string; signature: string }>;
} {
  return w.features['sui:signPersonalMessage'] as never;
}
function signTransactionFeature(w: Wallet): {
  signTransaction: (input: {
    transaction: { toJSON(): Promise<string> };
    account: WalletAccount;
    chain: string;
  }) => Promise<{ bytes: string; signature: string }>;
} {
  return w.features['sui:signTransaction'] as never;
}
function signAndExecuteTransactionFeature(w: Wallet): {
  signAndExecuteTransaction: (input: {
    transaction: { toJSON(): Promise<string> };
    account: WalletAccount;
    chain: string;
  }) => Promise<{
    digest: string;
    bytes: string;
    signature: string;
    effects: string;
  }>;
} {
  return w.features['sui:signAndExecuteTransaction'] as never;
}

// A minimal unresolved-transaction stand-in: a dApp's @mysten Transaction whose
// toJSON() yields the Transaction JSON the adapter ships to the desktop.
function txWithJson(json: string): { toJSON(): Promise<string> } {
  return { toJSON: () => Promise.resolve(json) };
}

test('the Wallet shape advertises version, chains, and the standard + sui features', () => {
  const w = new AirNoxSuiWallet(new MockTransport());
  assert.equal(w.version, '1.0.0');
  assert.equal(w.name, 'AirNox');
  assert.deepEqual(w.chains, [SUI_STD_CHAIN]);
  assert.ok('standard:connect' in w.features);
  assert.ok('standard:disconnect' in w.features);
  assert.ok('standard:events' in w.features);
  assert.ok('sui:signPersonalMessage' in w.features);
  assert.ok('sui:signTransaction' in w.features);
  assert.ok('sui:signAndExecuteTransaction' in w.features);
  // The legacy *Block aliases are NOT exposed (see sui_wallet.ts header).
  assert.ok(!('sui:signTransactionBlock' in w.features));
  assert.ok(!('sui:signAndExecuteTransactionBlock' in w.features));
  assert.deepEqual(w.accounts, []);
  // features is a stable reference across reads.
  assert.equal(w.features, w.features);
});

test('connect round-trips standard:connect + shapes WalletAccounts from {address, publicKey}', async () => {
  const t = new MockTransport();
  t.result = [
    { address: ADDR_A, publicKey: PUB_A },
    { address: ADDR_B, publicKey: PUB_B },
  ];
  const w = new AirNoxSuiWallet(t);

  const out = await connectFeature(w).connect();
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].ns, 'wstd');
  assert.equal(t.calls[0].method, 'standard:connect');
  assert.equal(t.calls[0].chain, SUI_MAINNET_CHAIN_URN);

  assert.equal(out.accounts.length, 2);
  assert.equal(out.accounts[0].address, ADDR_A);
  // publicKey is the decoded bare hex (NOT derived from the address).
  assert.equal(out.accounts[0].publicKey.length, 32);
  assert.deepEqual([...out.accounts[0].publicKey], new Array(32).fill(0xbb));
  assert.deepEqual(out.accounts[0].chains, [SUI_STD_CHAIN]);
  assert.equal(out.accounts[1].address, ADDR_B);
  assert.deepEqual([...out.accounts[1].publicKey], new Array(32).fill(0xdd));
  assert.equal(w.accounts.length, 2);
});

test('connect propagates a transport rejection (a denied connect rejects)', async () => {
  const t = new MockTransport();
  t.error = Object.assign(new Error('user rejected'), { code: 4001 });
  const w = new AirNoxSuiWallet(t);
  await assert.rejects(() => connectFeature(w).connect(), /user rejected/);
  assert.deepEqual(w.accounts, []);
});

test('a non-array connect reply resolves to no accounts, never throws', async () => {
  const t = new MockTransport();
  const w = new AirNoxSuiWallet(t);
  for (const reply of [null, { unexpected: true }, 'oops', 42]) {
    t.result = reply;
    const out = await connectFeature(w).connect();
    assert.deepEqual(out.accounts, []);
  }
});

test('malformed connect entries are skipped, never surfaced', async () => {
  const t = new MockTransport();
  const w = new AirNoxSuiWallet(t);
  t.result = [
    'a-bare-string', // not an object (Sui needs {address, publicKey})
    { address: ADDR_A }, // missing publicKey
    { publicKey: PUB_A }, // missing address
    { address: '', publicKey: PUB_A }, // empty address
    { address: ADDR_B, publicKey: 'zz' }, // non-hex publicKey
    { address: ADDR_A, publicKey: PUB_A }, // the only valid one
  ];
  const out = await connectFeature(w).connect();
  assert.equal(out.accounts.length, 1);
  assert.equal(out.accounts[0].address, ADDR_A);
});

test('the accounts array is frozen — a dApp cannot mutate the wallet state', async () => {
  const t = new MockTransport();
  t.result = [{ address: ADDR_A, publicKey: PUB_A }];
  const w = new AirNoxSuiWallet(t);
  await connectFeature(w).connect();
  assert.throws(() =>
    (w.accounts as WalletAccount[]).push({} as WalletAccount)
  );
});

test('connect emits a standard:events change with the accounts', async () => {
  const t = new MockTransport();
  t.result = [{ address: ADDR_A, publicKey: PUB_A }];
  const w = new AirNoxSuiWallet(t);

  const changes: unknown[] = [];
  eventsFeature(w).on('change', (props) => changes.push(props));
  await connectFeature(w).connect();

  assert.equal(changes.length, 1);
  assert.equal(
    (changes[0] as { accounts: WalletAccount[] }).accounts[0].address,
    ADDR_A
  );
});

test('disconnect clears the accounts + emits a change', async () => {
  const t = new MockTransport();
  t.result = [{ address: ADDR_A, publicKey: PUB_A }];
  const w = new AirNoxSuiWallet(t);
  await connectFeature(w).connect();

  const changes: unknown[] = [];
  eventsFeature(w).on('change', (props) => changes.push(props));
  await disconnectFeature(w).disconnect();
  assert.deepEqual(w.accounts, []);
  assert.equal(changes.length, 1);
});

test('a silent connect returns the cached set without a round-trip', async () => {
  const t = new MockTransport();
  t.result = [{ address: ADDR_A, publicKey: PUB_A }];
  const w = new AirNoxSuiWallet(t);

  const pre = await connectFeature(w).connect({ silent: true });
  assert.deepEqual(pre.accounts, []);
  assert.equal(t.calls.length, 0);

  await connectFeature(w).connect(); // non-silent → round-trip
  assert.equal(t.calls.length, 1);

  const post = await connectFeature(w).connect({ silent: true });
  assert.equal(post.accounts.length, 1);
  assert.equal(t.calls.length, 1); // still no extra round-trip
});

test('sui:signPersonalMessage round-trips 0x-hex message → {bytes, signature} base64', async () => {
  const t = new MockTransport();
  t.result = '3q2+7w=='; // a base64 "signature" the host would return
  const w = new AirNoxSuiWallet(t);
  const account: WalletAccount = {
    address: ADDR_A,
    publicKey: new Uint8Array(32),
    chains: [SUI_STD_CHAIN],
    features: ['sui:signPersonalMessage'],
  };
  const message = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"

  const out = await signPersonalMessageFeature(w).signPersonalMessage({
    account,
    message,
  });

  // the message rode the wire as 0x-hex; the request used the wstd ns + Sui urn.
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].ns, 'wstd');
  assert.equal(t.calls[0].method, 'sui:signPersonalMessage');
  assert.equal(t.calls[0].chain, SUI_MAINNET_CHAIN_URN);
  assert.deepEqual(t.calls[0].params, {
    address: ADDR_A,
    message: '0x68656c6c6f',
  });

  // bytes echoes the message (base64), signature is the host's base64 verbatim.
  assert.equal(out.bytes, 'aGVsbG8='); // base64("hello")
  assert.equal(out.signature, '3q2+7w==');
});

test('sui:signPersonalMessage throws on a non-string signature (contract breach)', async () => {
  const t = new MockTransport();
  t.result = { not: 'a string' };
  const w = new AirNoxSuiWallet(t);
  const account: WalletAccount = {
    address: ADDR_A,
    publicKey: new Uint8Array(32),
    chains: [SUI_STD_CHAIN],
    features: ['sui:signPersonalMessage'],
  };
  await assert.rejects(
    () =>
      signPersonalMessageFeature(w).signPersonalMessage({
        account,
        message: new Uint8Array([1, 2, 3]),
      }),
    /non-string signature/
  );
});

const SUI_ACCOUNT: WalletAccount = {
  address: ADDR_A,
  publicKey: new Uint8Array(32),
  chains: [SUI_STD_CHAIN],
  features: ['sui:signTransaction', 'sui:signAndExecuteTransaction'],
};

test('sui:signTransaction ships toJSON() → { bytes, signature } (single-input)', async () => {
  const t = new MockTransport();
  t.result = { bytes: 'QkNTYjY0', signature: 'U0lHYjY0' };
  const w = new AirNoxSuiWallet(t);

  const out = await signTransactionFeature(w).signTransaction({
    transaction: txWithJson('{"version":2,"sender":null}'),
    account: SUI_ACCOUNT,
    chain: SUI_STD_CHAIN,
  });

  // The request ships the toJSON() string on the wstd ns + Sui urn.
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].ns, 'wstd');
  assert.equal(t.calls[0].method, 'sui:signTransaction');
  assert.equal(t.calls[0].chain, SUI_MAINNET_CHAIN_URN);
  assert.deepEqual(t.calls[0].params, {
    address: ADDR_A,
    transaction: '{"version":2,"sender":null}',
  });

  // The desktop's { bytes, signature } is returned verbatim (both base64 strings).
  assert.deepEqual(out, { bytes: 'QkNTYjY0', signature: 'U0lHYjY0' });
});

test('sui:signTransaction throws on a non-object / missing-field reply', async () => {
  const w1 = new AirNoxSuiWallet(
    Object.assign(new MockTransport(), { result: 'not-an-object' })
  );
  await assert.rejects(
    () =>
      signTransactionFeature(w1).signTransaction({
        transaction: txWithJson('{}'),
        account: SUI_ACCOUNT,
        chain: SUI_STD_CHAIN,
      }),
    /non-object result/
  );

  const w2 = new AirNoxSuiWallet(
    Object.assign(new MockTransport(), { result: { bytes: 'b' } }) // no signature
  );
  await assert.rejects(
    () =>
      signTransactionFeature(w2).signTransaction({
        transaction: txWithJson('{}'),
        account: SUI_ACCOUNT,
        chain: SUI_STD_CHAIN,
      }),
    /non-string 'signature'/
  );
});

test('sui:signAndExecuteTransaction ships toJSON() → { digest, bytes, signature, effects }', async () => {
  const t = new MockTransport();
  t.result = {
    digest: 'ExecDigest',
    bytes: 'QkNT',
    signature: 'U0lH',
    effects: 'RUZG',
  };
  const w = new AirNoxSuiWallet(t);

  const out = await signAndExecuteTransactionFeature(
    w
  ).signAndExecuteTransaction({
    transaction: txWithJson('{"version":2}'),
    account: SUI_ACCOUNT,
    chain: SUI_STD_CHAIN,
  });

  assert.equal(t.calls[0].method, 'sui:signAndExecuteTransaction');
  assert.deepEqual(t.calls[0].params, {
    address: ADDR_A,
    transaction: '{"version":2}',
  });
  assert.deepEqual(out, {
    digest: 'ExecDigest',
    bytes: 'QkNT',
    signature: 'U0lH',
    effects: 'RUZG',
  });
});

test('sui:signAndExecuteTransaction accepts an empty effects (node may omit it)', async () => {
  const t = new MockTransport();
  t.result = { digest: 'D', bytes: 'B', signature: 'S', effects: '' };
  const w = new AirNoxSuiWallet(t);
  const out = await signAndExecuteTransactionFeature(
    w
  ).signAndExecuteTransaction({
    transaction: txWithJson('{"version":2}'),
    account: SUI_ACCOUNT,
    chain: SUI_STD_CHAIN,
  });
  assert.equal(out.effects, '');
  assert.equal(out.digest, 'D');
});

test('sui:signAndExecuteTransaction throws when a required field is missing', async () => {
  const t = new MockTransport();
  t.result = { digest: 'D', bytes: 'B', signature: 'S' }; // no effects
  const w = new AirNoxSuiWallet(t);
  await assert.rejects(
    () =>
      signAndExecuteTransactionFeature(w).signAndExecuteTransaction({
        transaction: txWithJson('{"version":2}'),
        account: SUI_ACCOUNT,
        chain: SUI_STD_CHAIN,
      }),
    /non-string 'effects'/
  );
});

test('the Sui transaction features refuse an out-of-set chain (no silent default)', async () => {
  const t = new MockTransport();
  t.result = { bytes: 'B', signature: 'S' };
  const w = new AirNoxSuiWallet(t);
  await assert.rejects(
    () =>
      signTransactionFeature(w).signTransaction({
        transaction: txWithJson('{}'),
        account: SUI_ACCOUNT,
        chain: 'sui:testnet', // not the advertised sui:mainnet
      }),
    /unsupported chain: sui:testnet/
  );
  // refused BEFORE any round-trip (and before toJSON()).
  assert.equal(t.calls.length, 0);
  await assert.rejects(
    () =>
      signAndExecuteTransactionFeature(w).signAndExecuteTransaction({
        transaction: txWithJson('{}'),
        account: SUI_ACCOUNT,
        chain: 'sui:devnet',
      }),
    /unsupported chain: sui:devnet/
  );
  assert.equal(t.calls.length, 0);
});

test('a transport rejection propagates through the Sui transaction features', async () => {
  const t = new MockTransport();
  t.error = Object.assign(new Error('user rejected'), { code: 4001 });
  const w = new AirNoxSuiWallet(t);
  await assert.rejects(
    () =>
      signTransactionFeature(w).signTransaction({
        transaction: txWithJson('{"version":2}'),
        account: SUI_ACCOUNT,
        chain: SUI_STD_CHAIN,
      }),
    /user rejected/
  );
  await assert.rejects(
    () =>
      signAndExecuteTransactionFeature(w).signAndExecuteTransaction({
        transaction: txWithJson('{"version":2}'),
        account: SUI_ACCOUNT,
        chain: SUI_STD_CHAIN,
      }),
    /user rejected/
  );
});

test('a desktop accountsChanged push re-shapes the accounts + emits a change', () => {
  const t = new MockTransport();
  const w = new AirNoxSuiWallet(t);
  const changes: unknown[] = [];
  eventsFeature(w).on('change', (props) => changes.push(props));

  t.fire('accountsChanged', [{ address: ADDR_B, publicKey: PUB_B }]);
  assert.equal(w.accounts.length, 1);
  assert.equal(w.accounts[0].address, ADDR_B);
  assert.equal(changes.length, 1);
});

test('a wstd accountsChanged is filtered by chain (Sui reacts, Solana chain ignored)', () => {
  const t = new MockTransport();
  const w = new AirNoxSuiWallet(t);
  const changes: unknown[] = [];
  eventsFeature(w).on('change', (props) => changes.push(props));

  // A wstd push tagged with the SOLANA chain must NOT touch the Sui provider
  // (without the chain filter, a Solana accountsChanged would mis-update it).
  t.fire(
    'accountsChanged',
    [{ address: ADDR_B, publicKey: PUB_B }],
    SOLANA_MAINNET_CHAIN_URN
  );
  assert.equal(w.accounts.length, 0);
  assert.equal(changes.length, 0);

  // A wstd push tagged with OUR chain is applied.
  t.fire(
    'accountsChanged',
    [{ address: ADDR_B, publicKey: PUB_B }],
    SUI_MAINNET_CHAIN_URN
  );
  assert.equal(w.accounts.length, 1);
  assert.equal(w.accounts[0].address, ADDR_B);
  assert.equal(changes.length, 1);

  // A wstd push with NO chain (pre-chain desktop) still applies — no further filter.
  t.fire('accountsChanged', []);
  assert.equal(w.accounts.length, 0);
  assert.equal(changes.length, 2);
});

test('a pushed accountsChanged for ANOTHER namespace is ignored', () => {
  const t = new MockTransport();
  const w = new AirNoxSuiWallet(t);
  const changes: unknown[] = [];
  eventsFeature(w).on('change', (props) => changes.push(props));

  // Establish the connected account set on Sui's own namespace.
  t.fire('accountsChanged', [{ address: ADDR_B, publicKey: PUB_B }]);
  assert.equal(w.accounts.length, 1);
  assert.equal(w.accounts[0].address, ADDR_B);
  assert.equal(changes.length, 1);

  // A foreign-ns push (EVM here) sharing the window must NOT touch the Sui adapter.
  t.fireNs('evm', 'accountsChanged', [{ address: '0xEvm', publicKey: '0x00' }]);
  // No change event emitted, and the accounts are UNCHANGED.
  assert.equal(changes.length, 1);
  assert.equal(w.accounts.length, 1);
  assert.equal(w.accounts[0].address, ADDR_B);
});

test('a desktop-initiated disconnect clears the accounts + emits empty', () => {
  const t = new MockTransport();
  const w = new AirNoxSuiWallet(t);
  const changes: unknown[] = [];
  eventsFeature(w).on('change', (props) => changes.push(props));

  // Populate the account set first (a desktop accountsChanged push).
  t.fire('accountsChanged', [{ address: ADDR_B, publicKey: PUB_B }]);
  assert.equal(w.accounts.length, 1);
  assert.equal(changes.length, 1);

  t.fire('disconnect', {}); // desktop revoke → clear + emit empty
  assert.deepEqual(w.accounts, []);
  assert.equal(changes.length, 2);
  assert.deepEqual((changes[1] as { accounts: WalletAccount[] }).accounts, []);

  t.fire('disconnect', {}); // already empty → no-op (no third emit)
  assert.equal(changes.length, 2);
});

// ── a 4100 means the desktop no longer grants this origin ───────────────────
// Mirror of the Solana adapter: the desktop's Unauthorized is the page's only
// signal that a session-only grant is gone, so the adapter forgets its accounts
// with a change{accounts:[]} (as a desktop disconnect does), and the dApp still
// receives the refusal.

const wireError = (code: number, message = 'refused'): Error =>
  Object.assign(new Error(message), { code });

test('a 4100 answer forgets the accounts and emits change{accounts:[]} once', async () => {
  const t = new MockTransport();
  t.result = [{ address: ADDR_A, publicKey: PUB_A }];
  const w = new AirNoxSuiWallet(t);
  await connectFeature(w).connect();

  const changes: unknown[] = [];
  eventsFeature(w).on('change', (props) => changes.push(props));

  t.error = wireError(
    ErrorCode.Unauthorized,
    'address is not authorized to sign for this origin'
  );
  await assert.rejects(
    () =>
      signPersonalMessageFeature(w).signPersonalMessage({
        account: SUI_ACCOUNT,
        message: new Uint8Array([1]),
      }),
    (e: unknown) => (e as { code?: number }).code === ErrorCode.Unauthorized
  );

  assert.equal(changes.length, 1);
  assert.deepEqual((changes[0] as { accounts: WalletAccount[] }).accounts, []);
  assert.deepEqual(w.accounts, []);
  assert.deepEqual(
    (await connectFeature(w).connect({ silent: true })).accounts,
    []
  );

  // Nothing is cached any more: a second refusal emits nothing.
  await assert.rejects(
    () =>
      signAndExecuteTransactionFeature(w).signAndExecuteTransaction({
        transaction: txWithJson('{"version":2}'),
        account: SUI_ACCOUNT,
        chain: SUI_STD_CHAIN,
      }),
    (e: unknown) => (e as { code?: number }).code === ErrorCode.Unauthorized
  );
  assert.equal(changes.length, 1);
});

test('a 4100 with no accounts cached emits no change', async () => {
  const t = new MockTransport();
  const w = new AirNoxSuiWallet(t);
  let count = 0;
  eventsFeature(w).on('change', () => count++);

  t.error = wireError(ErrorCode.Unauthorized);
  await assert.rejects(
    () =>
      signTransactionFeature(w).signTransaction({
        transaction: txWithJson('{"version":2}'),
        account: SUI_ACCOUNT,
        chain: SUI_STD_CHAIN,
      }),
    (e: unknown) => (e as { code?: number }).code === ErrorCode.Unauthorized
  );

  assert.equal(count, 0);
  assert.deepEqual(w.accounts, []);
});

test('a disconnect or any other refusal keeps the accounts', async () => {
  const t = new MockTransport();
  t.result = [{ address: ADDR_A, publicKey: PUB_A }];
  const w = new AirNoxSuiWallet(t);
  await connectFeature(w).connect();
  let count = 0;
  eventsFeature(w).on('change', () => count++);

  for (const code of [
    ErrorCode.Disconnected,
    ErrorCode.UserRejected,
    ErrorCode.WalletLocked,
    ErrorCode.NotPaired,
    ErrorCode.Internal,
  ]) {
    t.error = wireError(code);
    await assert.rejects(
      () =>
        signPersonalMessageFeature(w).signPersonalMessage({
          account: SUI_ACCOUNT,
          message: new Uint8Array([1]),
        }),
      (e: unknown) => (e as { code?: number }).code === code
    );
  }

  assert.equal(count, 0);
  assert.equal(w.accounts.length, 1);
});
