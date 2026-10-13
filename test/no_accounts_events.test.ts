import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_ACCOUNTS_EVENTS } from '../src/protocol/bridge';
import {
  SOLANA_MAINNET_CHAIN_URN,
  SUI_MAINNET_CHAIN_URN,
} from '../src/protocol/chains';
import { DAPP_NAMESPACES, Namespace } from '../src/protocol/envelope';
import { AirNoxEvmProvider } from '../src/inpage/evm_provider';
import { AirNoxSolanaWallet } from '../src/inpage/solana_wallet';
import { AirNoxSuiWallet } from '../src/inpage/sui_wallet';
import { AirNoxTonConnectBridge } from '../src/inpage/tonconnect_bridge';
import { AirNoxTronProvider } from '../src/inpage/tron_provider';
import { EventHandler, Transport } from '../src/inpage/transport';
import { Wallet, WalletAccount } from '../src/inpage/wallet_standard';
import { WalletEvent } from '../src/protocol/tonconnect';

// What the content script hands its page when the desktop restarted: every provider
// on the page must end up holding no accounts, each through the push it already handles. One transport, as the
// inpage entry builds it — every push reaches every handler, and each filters by its own namespace.

const EVM_ADDR = '0x' + 'ab'.repeat(20);
const SOL_ADDR = '1'.repeat(32);
const SUI_ADDR = '0x' + 'aa'.repeat(32);
const SUI_PUB = 'bb'.repeat(32); // Sui's connect reply carries each account's public key
const TRON_ADDR = 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH';

class SharedTransport implements Transport {
  private readonly handlers: EventHandler[] = [];

  send(
    ns: string,
    method: string,
    params: unknown,
    chain?: string
  ): Promise<unknown> {
    void method;
    void params;
    if (ns === 'evm') return Promise.resolve([EVM_ADDR]);
    if (ns === 'tron') return Promise.resolve([TRON_ADDR]);
    if (ns === 'wstd' && chain === SOLANA_MAINNET_CHAIN_URN) {
      return Promise.resolve([SOL_ADDR]);
    }
    if (ns === 'wstd' && chain === SUI_MAINNET_CHAIN_URN) {
      return Promise.resolve([{ address: SUI_ADDR, publicKey: SUI_PUB }]);
    }
    return Promise.reject(new Error(`unexpected ${ns} ${method}`));
  }

  onEvent(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  deliver(): void {
    for (const ev of NO_ACCOUNTS_EVENTS) {
      for (const h of this.handlers) {
        h(ev.ns, ev.event, ev.data, ev.chain);
      }
    }
  }
}

function connect(w: Wallet): Promise<{ accounts: readonly WalletAccount[] }> {
  return (
    w.features['standard:connect'] as {
      connect: () => Promise<{ accounts: readonly WalletAccount[] }>;
    }
  ).connect();
}

test('every provider on the page forgets its accounts', async () => {
  const t = new SharedTransport();
  const evm = new AirNoxEvmProvider(t);
  const sol = new AirNoxSolanaWallet(t);
  const sui = new AirNoxSuiWallet(t);
  const tron = new AirNoxTronProvider(t);
  const ton = new AirNoxTonConnectBridge(t);

  assert.deepEqual(await evm.request({ method: 'eth_requestAccounts' }), [
    EVM_ADDR,
  ]);
  assert.equal((await connect(sol)).accounts.length, 1);
  assert.equal((await connect(sui)).accounts.length, 1);
  await tron.request({ method: 'tron_requestAccounts' });
  assert.equal(tron.connectedAddress, TRON_ADDR);

  const evmChanges: unknown[] = [];
  evm.on('accountsChanged', (a) => evmChanges.push(a));
  const tronChanges: unknown[] = [];
  tron.on('accountsChanged', (a) => tronChanges.push(a));
  const tonEvents: WalletEvent[] = [];
  ton.listen((ev) => tonEvents.push(ev));

  t.deliver();

  assert.deepEqual(evmChanges, [[]]);
  assert.deepEqual(await evm.request({ method: 'eth_accounts' }), []);
  assert.deepEqual(sol.accounts, []);
  assert.deepEqual(sui.accounts, []);
  assert.equal(tron.connectedAddress, null);
  assert.deepEqual(tronChanges, [[]]);
  assert.equal(tonEvents.length, 1);
  assert.equal(tonEvents[0].event, 'disconnect');
});

test('the events address every dApp namespace and nothing else', () => {
  // A namespace added later without its "no accounts" push would leave its dApps
  // reading "connected" after a restart — the defect this exists for.
  const seen = new Set<Namespace>(NO_ACCOUNTS_EVENTS.map((e) => e.ns));
  assert.deepEqual([...seen].sort(), [...DAPP_NAMESPACES].sort());
  for (const ev of NO_ACCOUNTS_EVENTS) {
    assert.equal(ev.kind, 'event');
    assert.equal(ev.chain, undefined, 'no chain: every chain of the namespace');
  }
});
