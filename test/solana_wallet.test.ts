import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SOLANA_STD_CHAIN,
  AirNoxSolanaWallet,
  Wallet,
  WalletAccount,
  sendOptionsFrom,
} from '../src/inpage/solana_wallet';
import { registerWallet } from '../src/inpage/wallet_standard';
import {
  SOLANA_DEVNET_CHAIN_URN,
  SOLANA_MAINNET_CHAIN_URN,
  SUI_MAINNET_CHAIN_URN,
} from '../src/protocol/chains';
import { AirNoxSuiWallet } from '../src/inpage/sui_wallet';
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

// The System Program (32 ones → 32 zero bytes) + Wrapped SOL mint — both decode
// to a 32-byte pubkey, so they exercise the WalletAccount shaping.
const ADDR_A = '1'.repeat(32);
const ADDR_B = 'So11111111111111111111111111111111111111112';

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
function signMessageFeature(w: Wallet): {
  signMessage: (
    ...inputs: { account: WalletAccount; message: Uint8Array }[]
  ) => Promise<{ signedMessage: Uint8Array; signature: Uint8Array }[]>;
} {
  return w.features['solana:signMessage'] as never;
}
function signTxFeature(w: Wallet): {
  supportedTransactionVersions: readonly unknown[];
  signTransaction: (
    ...inputs: {
      account: WalletAccount;
      transaction: Uint8Array;
      chain?: string;
    }[]
  ) => Promise<{ signedTransaction: Uint8Array }[]>;
} {
  return w.features['solana:signTransaction'] as never;
}
function signAndSendFeature(w: Wallet): {
  supportedTransactionVersions: readonly unknown[];
  signAndSendTransaction: (
    ...inputs: {
      account: WalletAccount;
      transaction: Uint8Array;
      chain: string;
      options?: {
        preflightCommitment?: string;
        skipPreflight?: boolean;
        maxRetries?: number;
        minContextSlot?: number;
      };
    }[]
  ) => Promise<{ signature: Uint8Array }[]>;
} {
  return w.features['solana:signAndSendTransaction'] as never;
}

test('the Wallet shape advertises version, chains, and the standard features', () => {
  const w = new AirNoxSolanaWallet(new MockTransport());
  assert.equal(w.version, '1.0.0');
  assert.equal(w.name, 'AirNox');
  assert.deepEqual(w.chains, [SOLANA_STD_CHAIN, 'solana:devnet']);
  assert.ok('standard:connect' in w.features);
  assert.ok('standard:disconnect' in w.features);
  assert.ok('standard:events' in w.features);
  assert.deepEqual(w.accounts, []);
  // features is a stable reference across reads.
  assert.equal(w.features, w.features);
});

test('connect round-trips standard:connect + shapes WalletAccounts', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A, ADDR_B];
  const w = new AirNoxSolanaWallet(t);

  const out = await connectFeature(w).connect();
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].ns, 'wstd');
  assert.equal(t.calls[0].method, 'standard:connect');
  assert.equal(t.calls[0].chain, SOLANA_MAINNET_CHAIN_URN);

  assert.equal(out.accounts.length, 2);
  assert.equal(out.accounts[0].address, ADDR_A);
  assert.equal(out.accounts[0].publicKey.length, 32);
  assert.deepEqual([...out.accounts[0].publicKey], new Array(32).fill(0)); // 32 ones → 32 zeros
  assert.deepEqual(out.accounts[0].chains, [SOLANA_STD_CHAIN]);
  assert.equal(out.accounts[1].address, ADDR_B);
  // the Wallet's accounts getter reflects the connect.
  assert.equal(w.accounts.length, 2);
});

test('connect propagates a transport rejection (a denied connect rejects)', async () => {
  const t = new MockTransport();
  t.error = Object.assign(new Error('user rejected'), { code: 4001 });
  const w = new AirNoxSolanaWallet(t);
  await assert.rejects(() => connectFeature(w).connect(), /user rejected/);
  assert.deepEqual(w.accounts, []);
});

test('a non-array connect reply resolves to no accounts, never throws', async () => {
  const t = new MockTransport();
  const w = new AirNoxSolanaWallet(t);
  for (const reply of [null, { unexpected: true }, 'oops', 42]) {
    t.result = reply;
    const out = await connectFeature(w).connect();
    assert.deepEqual(out.accounts, []);
  }
});

test('the accounts array is frozen — a dApp cannot mutate the wallet state', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A];
  const w = new AirNoxSolanaWallet(t);
  await connectFeature(w).connect();
  assert.throws(() =>
    (w.accounts as WalletAccount[]).push({} as WalletAccount)
  );
});

test('connect emits a standard:events change with the accounts', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A];
  const w = new AirNoxSolanaWallet(t);

  const changes: unknown[] = [];
  eventsFeature(w).on('change', (props) => changes.push(props));
  await connectFeature(w).connect();

  assert.equal(changes.length, 1);
  assert.equal(
    (changes[0] as { accounts: WalletAccount[] }).accounts[0].address,
    ADDR_A
  );
});

test('a silent connect returns the cached set without a round-trip', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A];
  const w = new AirNoxSolanaWallet(t);

  // before any connect → empty, no round-trip.
  const pre = await connectFeature(w).connect({ silent: true });
  assert.deepEqual(pre.accounts, []);
  assert.equal(t.calls.length, 0);

  await connectFeature(w).connect(); // non-silent → round-trip
  assert.equal(t.calls.length, 1);

  const post = await connectFeature(w).connect({ silent: true });
  assert.equal(post.accounts.length, 1);
  assert.equal(t.calls.length, 1); // still no extra round-trip
});

test('disconnect clears the accounts and emits change', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A];
  const w = new AirNoxSolanaWallet(t);
  await connectFeature(w).connect();

  const changes: unknown[] = [];
  eventsFeature(w).on('change', (props) => changes.push(props));
  await disconnectFeature(w).disconnect();

  assert.deepEqual(w.accounts, []);
  assert.equal(changes.length, 1);
  assert.deepEqual((changes[0] as { accounts: WalletAccount[] }).accounts, []);
});

test('a pushed accountsChanged updates the accounts + emits; a no-op does not', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A];
  const w = new AirNoxSolanaWallet(t);
  await connectFeature(w).connect();

  let count = 0;
  eventsFeature(w).on('change', () => count++);

  t.fire('accountsChanged', [ADDR_B]); // changed → emit
  assert.equal(w.accounts[0].address, ADDR_B);
  assert.equal(count, 1);

  t.fire('accountsChanged', [ADDR_B]); // same set → no emit
  assert.equal(count, 1);

  t.fire('accountsChanged', []); // revoked → emit empty
  assert.deepEqual(w.accounts, []);
  assert.equal(count, 2);
});

test('a wstd accountsChanged is filtered by chain (Solana reacts, Sui chain ignored)', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A];
  const w = new AirNoxSolanaWallet(t);
  await connectFeature(w).connect();

  let count = 0;
  eventsFeature(w).on('change', () => count++);

  // A wstd push tagged with the SUI chain must NOT touch the Solana provider
  // (without the chain filter, a Sui accountsChanged would mis-update it).
  t.fire('accountsChanged', [ADDR_B], SUI_MAINNET_CHAIN_URN);
  assert.equal(count, 0);
  assert.equal(w.accounts[0].address, ADDR_A);

  // A wstd push tagged with OUR chain is applied.
  t.fire('accountsChanged', [ADDR_B], SOLANA_MAINNET_CHAIN_URN);
  assert.equal(count, 1);
  assert.equal(w.accounts[0].address, ADDR_B);

  // A wstd push with NO chain (pre-chain desktop) still applies — no further filter.
  t.fire('accountsChanged', [ADDR_A]);
  assert.equal(count, 2);
  assert.equal(w.accounts[0].address, ADDR_A);
});

test('a pushed accountsChanged for ANOTHER namespace is ignored', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A];
  const w = new AirNoxSolanaWallet(t);
  await connectFeature(w).connect();

  let count = 0;
  eventsFeature(w).on('change', () => count++);

  // A foreign-ns push (EVM here) sharing the window must NOT touch the Solana adapter.
  t.fireNs('evm', 'accountsChanged', ['0xEvmAddressNotBase58']);
  assert.equal(count, 0); // the change listener did NOT fire
  assert.equal(w.accounts.length, 1); // accounts UNCHANGED — still the pre-push set
  assert.equal(w.accounts[0].address, ADDR_A);
});

test('a desktop-initiated disconnect clears the accounts + emits empty', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A];
  const w = new AirNoxSolanaWallet(t);
  await connectFeature(w).connect();

  const changes: unknown[] = [];
  eventsFeature(w).on('change', (props) => changes.push(props));

  t.fire('disconnect', {}); // desktop revoke → clear + emit empty
  assert.deepEqual(w.accounts, []);
  assert.equal(changes.length, 1);
  assert.deepEqual((changes[0] as { accounts: WalletAccount[] }).accounts, []);

  t.fire('disconnect', {}); // already empty → no-op (no second emit)
  assert.equal(changes.length, 1);
});

test('shapeAccounts skips malformed entries rather than throwing', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A, '', 42, '0OIl-not-base58'];
  const w = new AirNoxSolanaWallet(t);
  const out = await connectFeature(w).connect();
  assert.equal(out.accounts.length, 1);
  assert.equal(out.accounts[0].address, ADDR_A);
});

test('an off() unsubscribes a change listener', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A];
  const w = new AirNoxSolanaWallet(t);
  let count = 0;
  const off = eventsFeature(w).on('change', () => count++);
  off();
  await connectFeature(w).connect();
  assert.equal(count, 0);
});

// ── solana:signMessage ───────────────────────────────────────────────────────
test('the wallet + a connected account advertise solana:signMessage', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A];
  const w = new AirNoxSolanaWallet(t);
  assert.ok('solana:signMessage' in w.features);
  const out = await connectFeature(w).connect();
  assert.ok(out.accounts[0].features.includes('solana:signMessage'));
});

test('signMessage round-trips per input + decodes the base64 signature', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A];
  const w = new AirNoxSolanaWallet(t);
  const { accounts } = await connectFeature(w).connect();

  t.calls.length = 0;
  t.result = 'SGVsbG8='; // base64 of [72,101,108,108,111]
  const message = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const out = await signMessageFeature(w).signMessage({
    account: accounts[0],
    message,
  });

  assert.equal(out.length, 1);
  assert.deepEqual([...out[0].signedMessage], [0xde, 0xad, 0xbe, 0xef]); // echoed
  assert.deepEqual([...out[0].signature], [72, 101, 108, 108, 111]);
  // the wire call: wstd / solana:signMessage / { address, 0x-hex message }.
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].ns, 'wstd');
  assert.equal(t.calls[0].method, 'solana:signMessage');
  assert.equal(t.calls[0].chain, SOLANA_MAINNET_CHAIN_URN);
  assert.deepEqual(t.calls[0].params, {
    address: ADDR_A,
    message: '0xdeadbeef',
  });
});

test('signMessage signs a batch of inputs in order', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A];
  const w = new AirNoxSolanaWallet(t);
  const { accounts } = await connectFeature(w).connect();

  t.calls.length = 0;
  t.result = 'AA=='; // base64 of [0]
  const out = await signMessageFeature(w).signMessage(
    { account: accounts[0], message: new Uint8Array([1]) },
    { account: accounts[0], message: new Uint8Array([2]) }
  );
  assert.equal(out.length, 2);
  assert.equal(t.calls.length, 2);
  assert.deepEqual(t.calls[0].params, { address: ADDR_A, message: '0x01' });
  assert.deepEqual(t.calls[1].params, { address: ADDR_A, message: '0x02' });
});

test('signMessage handles an empty message (0x) and mixed accounts', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A, ADDR_B];
  const w = new AirNoxSolanaWallet(t);
  const { accounts } = await connectFeature(w).connect();

  // empty message → 0x.
  t.calls.length = 0;
  t.result = 'AA==';
  await signMessageFeature(w).signMessage({
    account: accounts[0],
    message: new Uint8Array([]),
  });
  assert.deepEqual(t.calls[0].params, { address: ADDR_A, message: '0x' });

  // a batch spanning two distinct accounts forwards each account's address.
  t.calls.length = 0;
  await signMessageFeature(w).signMessage(
    { account: accounts[0], message: new Uint8Array([1]) },
    { account: accounts[1], message: new Uint8Array([2]) }
  );
  assert.equal((t.calls[0].params as { address: string }).address, ADDR_A);
  assert.equal((t.calls[1].params as { address: string }).address, ADDR_B);
});

test('a rejected signMessage rejects the whole batch', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A];
  const w = new AirNoxSolanaWallet(t);
  const { accounts } = await connectFeature(w).connect();
  t.error = Object.assign(new Error('user rejected'), { code: 4001 });
  await assert.rejects(
    () =>
      signMessageFeature(w).signMessage({
        account: accounts[0],
        message: new Uint8Array([1]),
      }),
    /user rejected/
  );
});

// ── solana:signTransaction / signAndSendTransaction ──────────────────────────
test('the wallet + account advertise the transaction sign features', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A];
  const w = new AirNoxSolanaWallet(t);
  assert.ok('solana:signTransaction' in w.features);
  assert.ok('solana:signAndSendTransaction' in w.features);
  // supportedTransactionVersions advertises legacy + v0 (the wallet-adapter gate).
  assert.deepEqual(signTxFeature(w).supportedTransactionVersions, [
    'legacy',
    0,
  ]);
  assert.deepEqual(signAndSendFeature(w).supportedTransactionVersions, [
    'legacy',
    0,
  ]);
  const out = await connectFeature(w).connect();
  assert.ok(out.accounts[0].features.includes('solana:signTransaction'));
  assert.ok(out.accounts[0].features.includes('solana:signAndSendTransaction'));
});

test('signTransaction sends the tx as base64 + decodes the base64 signed wire', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A];
  const w = new AirNoxSolanaWallet(t);
  const { accounts } = await connectFeature(w).connect();

  t.calls.length = 0;
  t.result = 'SGVsbG8='; // base64 of "Hello"
  const out = await signTxFeature(w).signTransaction({
    account: accounts[0],
    transaction: new Uint8Array([1, 2, 3]),
  });
  assert.equal(out.length, 1);
  assert.deepEqual([...out[0].signedTransaction], [72, 101, 108, 108, 111]);
  assert.equal(t.calls[0].ns, 'wstd');
  assert.equal(t.calls[0].method, 'solana:signTransaction');
  assert.deepEqual(t.calls[0].params, { address: ADDR_A, transaction: 'AQID' }); // base64 of [1,2,3]
});

test('signAndSendTransaction sends the tx as base64 + base58-decodes the signature', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A];
  const w = new AirNoxSolanaWallet(t);
  const { accounts } = await connectFeature(w).connect();

  t.calls.length = 0;
  t.result = ADDR_B; // a base58 string (the broadcast tx signature)
  const out = await signAndSendFeature(w).signAndSendTransaction({
    account: accounts[0],
    transaction: new Uint8Array([1, 2, 3]),
    chain: SOLANA_STD_CHAIN,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].signature.length, 32); // ADDR_B base58-decodes to 32 bytes
  assert.equal(t.calls[0].method, 'solana:signAndSendTransaction');
  assert.deepEqual(t.calls[0].params, { address: ADDR_A, transaction: 'AQID' });
});

test('signAndSendTransaction forwards the whitelisted send options', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A];
  const w = new AirNoxSolanaWallet(t);
  const { accounts } = await connectFeature(w).connect();
  t.calls.length = 0;
  t.result = ADDR_B; // a base58 string (the broadcast tx signature)

  await signAndSendFeature(w).signAndSendTransaction({
    account: accounts[0],
    transaction: new Uint8Array([1, 2, 3]),
    chain: SOLANA_STD_CHAIN,
    options: {
      preflightCommitment: 'confirmed',
      skipPreflight: true,
      maxRetries: 2,
      minContextSlot: 777,
    },
  });
  assert.deepEqual(t.calls[0].params, {
    address: ADDR_A,
    transaction: 'AQID',
    options: {
      preflightCommitment: 'confirmed',
      skipPreflight: true,
      maxRetries: 2,
      minContextSlot: 777,
    },
  });
});

test('sendOptionsFrom whitelists: undefined fields dropped, unknown keys never ride, empty → null', () => {
  // Defined fields only — an undefined entry never serializes (not even null).
  assert.deepEqual(sendOptionsFrom({ skipPreflight: false }), {
    skipPreflight: false,
  });
  // Unknown keys cannot ride along (the desktop would refuse the request 1100).
  const withUnknown = {
    skipPreflight: true,
    computeUnits: 5,
  } as unknown as Parameters<typeof sendOptionsFrom>[0];
  assert.deepEqual(sendOptionsFrom(withUnknown), { skipPreflight: true });
  // Nothing to send → null → the caller omits params.options entirely.
  assert.equal(sendOptionsFrom(undefined), null);
  assert.equal(sendOptionsFrom({}), null);
});

test('a transaction sign for an unsupported chain is refused', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A];
  const w = new AirNoxSolanaWallet(t);
  const { accounts } = await connectFeature(w).connect();
  t.calls.length = 0;
  await assert.rejects(
    () =>
      signTxFeature(w).signTransaction({
        account: accounts[0],
        transaction: new Uint8Array([1]),
        chain: 'solana:testnet',
      }),
    /unsupported chain/
  );
  await assert.rejects(
    () =>
      signAndSendFeature(w).signAndSendTransaction({
        account: accounts[0],
        transaction: new Uint8Array([1]),
        chain: 'eip155:1',
      }),
    /unsupported chain/
  );
  assert.equal(t.calls.length, 0); // refused before any round-trip
});

// ── registration (window mechanism) ──────────────────────────────────────────
test('registerWallet dispatches register-wallet and registers on app-ready', () => {
  const dispatched: Event[] = [];
  const listeners = new Map<string, EventListener>();
  const fakeWindow = {
    dispatchEvent: (e: Event) => {
      dispatched.push(e);
      return true;
    },
    addEventListener: (type: string, listener: EventListener) => {
      listeners.set(type, listener);
    },
  };
  const prior = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = fakeWindow;
  try {
    const wallet = new AirNoxSolanaWallet(new MockTransport());
    let touches = 0;
    registerWallet(wallet, () => (touches += 1));

    // Dispatching into a page with no wallet-standard registry is OUR doing, not
    // the page's — it must not mark the tab as wanting web3.
    assert.equal(touches, 0);

    // a register-wallet event was dispatched; its detail registers the wallet.
    assert.equal(dispatched.length, 1);
    const ev = dispatched[0] as Event & {
      detail: (api: { register: (w: Wallet) => void }) => void;
    };
    assert.equal(ev.type, 'wallet-standard:register-wallet');
    let registered: Wallet | null = null;
    ev.detail({ register: (w) => (registered = w) });
    assert.equal(registered, wallet);
    // A registry answered: a wallet-standard app IS running on this page.
    assert.equal(touches, 1);

    // a late dApp firing app-ready also registers via the same callback.
    const onReady = listeners.get('wallet-standard:app-ready');
    assert.ok(onReady);
    let registered2: Wallet | null = null;
    onReady({
      detail: { register: (w: Wallet) => (registered2 = w) },
    } as unknown as Event);
    assert.equal(registered2, wallet);
    assert.equal(touches, 2);
  } finally {
    (globalThis as { window?: unknown }).window = prior;
  }
});

// ── a 4100 means the desktop no longer grants this origin ───────────────────
// A session-only desktop grant gone after a restart leaves the adapter holding
// the accounts it cached at connect — which a silent connect hands straight back
// — while the desktop refuses every request for them with Unauthorized (4100).
// The adapter forgets them on that refusal with Wallet Standard's own shape for
// "no accounts" (a change carrying accounts: []), as it does for a desktop
// disconnect; the dApp still receives the refusal.

const wireError = (code: number, message = 'refused'): Error =>
  Object.assign(new Error(message), { code });

test('a 4100 answer forgets the accounts and emits change{accounts:[]} once', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A];
  const w = new AirNoxSolanaWallet(t);
  const { accounts } = await connectFeature(w).connect();

  const changes: unknown[] = [];
  eventsFeature(w).on('change', (props) => changes.push(props));

  t.error = wireError(
    ErrorCode.Unauthorized,
    'address is not authorized to sign for this origin'
  );
  await assert.rejects(
    () =>
      signMessageFeature(w).signMessage({
        account: accounts[0],
        message: new Uint8Array([1]),
      }),
    (e: unknown) => (e as { code?: number }).code === ErrorCode.Unauthorized
  );

  assert.equal(changes.length, 1);
  assert.deepEqual((changes[0] as { accounts: WalletAccount[] }).accounts, []);
  assert.deepEqual(w.accounts, []);
  // An auto-reconnect no longer hands back the refused accounts.
  assert.deepEqual(
    (await connectFeature(w).connect({ silent: true })).accounts,
    []
  );

  // Nothing is cached any more: a second refusal emits nothing.
  await assert.rejects(
    () =>
      signTxFeature(w).signTransaction({
        account: accounts[0],
        transaction: new Uint8Array([1]),
      }),
    (e: unknown) => (e as { code?: number }).code === ErrorCode.Unauthorized
  );
  assert.equal(changes.length, 1);
});

test('a 4100 with no accounts cached emits no change', async () => {
  const t = new MockTransport();
  const w = new AirNoxSolanaWallet(t);
  let count = 0;
  eventsFeature(w).on('change', () => count++);

  t.error = wireError(ErrorCode.Unauthorized);
  await assert.rejects(
    () =>
      signAndSendFeature(w).signAndSendTransaction({
        account: {
          address: ADDR_A,
          publicKey: new Uint8Array(32),
          chains: [SOLANA_STD_CHAIN],
          features: [],
        },
        transaction: new Uint8Array([1]),
        chain: SOLANA_STD_CHAIN,
      }),
    (e: unknown) => (e as { code?: number }).code === ErrorCode.Unauthorized
  );

  assert.equal(count, 0);
  assert.deepEqual(w.accounts, []);
});

test('a disconnect or any other refusal keeps the accounts', async () => {
  const t = new MockTransport();
  t.result = [ADDR_A];
  const w = new AirNoxSolanaWallet(t);
  const { accounts } = await connectFeature(w).connect();
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
        signMessageFeature(w).signMessage({
          account: accounts[0],
          message: new Uint8Array([1]),
        }),
      (e: unknown) => (e as { code?: number }).code === code
    );
  }

  assert.equal(count, 0);
  assert.equal(w.accounts.length, 1);
});

test('a 4100 on Solana leaves Sui, on the same wstd namespace, connected', async () => {
  // Solana and Sui share `wstd` and one transport; the desktop grants each chain
  // separately, and a refusal settles only the request that was refused.
  const t = new MockTransport();
  const solana = new AirNoxSolanaWallet(t);
  const sui = new AirNoxSuiWallet(t);
  t.result = [ADDR_A];
  const { accounts } = await connectFeature(solana).connect();
  t.result = [{ address: '0x' + 'aa'.repeat(32), publicKey: 'bb'.repeat(32) }];
  await connectFeature(sui).connect();

  const heard: string[] = [];
  eventsFeature(solana).on('change', () => heard.push('solana'));
  eventsFeature(sui).on('change', () => heard.push('sui'));

  t.error = wireError(ErrorCode.Unauthorized);
  await assert.rejects(
    () =>
      signMessageFeature(solana).signMessage({
        account: accounts[0],
        message: new Uint8Array([1]),
      }),
    (e: unknown) => (e as { code?: number }).code === ErrorCode.Unauthorized
  );

  assert.deepEqual(heard, ['solana']);
  assert.deepEqual(solana.accounts, []);
  assert.equal(sui.accounts.length, 1);
});

// ── devnet: one wallet, two clusters, switched on first use ──────────────────
//
// The desktop grants a dApp per (origin, chain), and Wallet Standard's connect names no chain, so the wallet
// connects on its current cluster (mainnet first) and moves to another when a request names it: a connect on that
// cluster (the desktop asks the person unless it already granted it), then the request, both on the new cluster.

// A transport that answers each call from a script, in order (an Error rejects), and records the calls.
class ScriptedTransport implements Transport {
  calls: Call[] = [];
  constructor(private readonly answers: unknown[]) {}
  send(
    ns: string,
    method: string,
    params: unknown,
    chain?: string
  ): Promise<unknown> {
    this.calls.push({ ns, method, params, chain });
    const a = this.answers.shift();
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
  }
  private handler?: EventHandler;
  onEvent(handler: EventHandler): void {
    this.handler = handler;
  }
  fire(event: string, data: unknown, chain?: string): void {
    this.handler?.('wstd', event, data, chain);
  }
}

const SIG_B58 = '1'.repeat(64); // 64 zero bytes

test('a devnet send from a mainnet connection connects on devnet first, then sends there', async () => {
  const t = new ScriptedTransport([[ADDR_A], [ADDR_B], SIG_B58]);
  const w = new AirNoxSolanaWallet(t);
  const { accounts } = await connectFeature(w).connect();
  let changes = 0;
  eventsFeature(w).on('change', () => changes++);
  const out = await signAndSendFeature(w).signAndSendTransaction({
    account: accounts[0],
    transaction: new Uint8Array([1, 2]),
    chain: 'solana:devnet',
  });
  assert.deepEqual(
    t.calls.map((c) => [c.method, c.chain]),
    [
      ['standard:connect', SOLANA_MAINNET_CHAIN_URN],
      ['standard:connect', SOLANA_DEVNET_CHAIN_URN],
      ['solana:signAndSendTransaction', SOLANA_DEVNET_CHAIN_URN],
    ]
  );
  assert.equal(out[0].signature.length, 64);
  // The devnet grant's accounts replace the mainnet ones, each naming devnet.
  assert.equal(w.accounts.length, 1);
  assert.equal(w.accounts[0].address, ADDR_B);
  assert.deepEqual(w.accounts[0].chains, ['solana:devnet']);
  assert.equal(changes, 1);
});

test('a switch the person refuses sends nothing and leaves the wallet on its cluster', async () => {
  const refused = Object.assign(new Error('user rejected'), { code: 4001 });
  const t = new ScriptedTransport([[ADDR_A], refused, [ADDR_A]]);
  const w = new AirNoxSolanaWallet(t);
  const { accounts } = await connectFeature(w).connect();
  await assert.rejects(
    () =>
      signAndSendFeature(w).signAndSendTransaction({
        account: accounts[0],
        transaction: new Uint8Array([1]),
        chain: 'solana:devnet',
      }),
    /user rejected/
  );
  assert.equal(t.calls.length, 2); // the two connects, no send
  assert.equal(w.accounts[0].address, ADDR_A);
  assert.deepEqual(w.accounts[0].chains, [SOLANA_STD_CHAIN]);
  // The next request without a chain still goes to mainnet.
  await connectFeature(w).connect();
  assert.equal(t.calls[2].chain, SOLANA_MAINNET_CHAIN_URN);
});

test('after a switch, a request that names no cluster stays on devnet', async () => {
  const t = new ScriptedTransport([
    [ADDR_A],
    [ADDR_A],
    SIG_B58,
    'AAAA',
    'AQID',
  ]);
  const w = new AirNoxSolanaWallet(t);
  const { accounts } = await connectFeature(w).connect();
  await signAndSendFeature(w).signAndSendTransaction({
    account: accounts[0],
    transaction: new Uint8Array([1]),
    chain: 'solana:devnet',
  });
  await signMessageFeature(w).signMessage({
    account: w.accounts[0],
    message: new Uint8Array([1]),
  });
  await signTxFeature(w).signTransaction({
    account: w.accounts[0],
    transaction: new Uint8Array([1]),
  });
  assert.deepEqual(
    t.calls.slice(3).map((c) => [c.method, c.chain]),
    [
      ['solana:signMessage', SOLANA_DEVNET_CHAIN_URN],
      ['solana:signTransaction', SOLANA_DEVNET_CHAIN_URN],
    ]
  );
});

test('a request on the cluster already in use does not connect again', async () => {
  const t = new ScriptedTransport([[ADDR_A], SIG_B58]);
  const w = new AirNoxSolanaWallet(t);
  const { accounts } = await connectFeature(w).connect();
  await signAndSendFeature(w).signAndSendTransaction({
    account: accounts[0],
    transaction: new Uint8Array([1]),
    chain: SOLANA_STD_CHAIN,
  });
  assert.deepEqual(
    t.calls.map((c) => c.method),
    ['standard:connect', 'solana:signAndSendTransaction']
  );
});

test('after a switch, pushes are taken for devnet and ignored for mainnet', async () => {
  const t = new ScriptedTransport([[ADDR_A], [ADDR_A], SIG_B58]);
  const w = new AirNoxSolanaWallet(t);
  const { accounts } = await connectFeature(w).connect();
  await signAndSendFeature(w).signAndSendTransaction({
    account: accounts[0],
    transaction: new Uint8Array([1]),
    chain: 'solana:devnet',
  });
  t.fire('accountsChanged', [ADDR_B], SOLANA_MAINNET_CHAIN_URN);
  assert.equal(w.accounts[0].address, ADDR_A);
  t.fire('accountsChanged', [ADDR_B], SOLANA_DEVNET_CHAIN_URN);
  assert.equal(w.accounts[0].address, ADDR_B);
});

test('a sign-only request naming devnet switches too', async () => {
  const t = new ScriptedTransport([[ADDR_A], [ADDR_A], 'AQID']);
  const w = new AirNoxSolanaWallet(t);
  const { accounts } = await connectFeature(w).connect();
  await signTxFeature(w).signTransaction({
    account: accounts[0],
    transaction: new Uint8Array([1]),
    chain: 'solana:devnet',
  });
  assert.deepEqual(
    t.calls.map((c) => [c.method, c.chain]),
    [
      ['standard:connect', SOLANA_MAINNET_CHAIN_URN],
      ['standard:connect', SOLANA_DEVNET_CHAIN_URN],
      ['solana:signTransaction', SOLANA_DEVNET_CHAIN_URN],
    ]
  );
});
