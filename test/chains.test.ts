import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVM_MAINNET_CHAIN_URN,
  MhdaNetwork,
  SOLANA_DEVNET_CHAIN_URN,
  SOLANA_MAINNET_CHAIN_URN,
  SUI_MAINNET_CHAIN_URN,
  TON_MAINNET_CHAIN_URN,
  TRON_MAINNET_CHAIN_URN,
  chainKey,
} from '../src/protocol/chains';

// mhda 1.1 chain-key grammar: `nt:<network>:ci:<chain_id>`. The (network,
// chain_id) pair IS the identity — the SLIP-44 coin type (`ct:`) is no longer
// part of the key. A pre-1.1 key (with `ct:`, or an old network spelling) is
// rejected by the desktop, so the extension must never emit one.

test('chainKey builds the canonical nt:<network>:ci:<chain_id> form', () => {
  assert.equal(chainKey(MhdaNetwork.Evm, '1'), 'nt:evm:ci:1');
  assert.equal(chainKey(MhdaNetwork.Solana, 'mainnet'), 'nt:solana:ci:mainnet');
});

test('chainKey never emits a coin-type (ct:) segment', () => {
  const key = chainKey(MhdaNetwork.Evm, '1');
  assert.ok(!key.includes(':ct:'), `key must not carry ct:, got "${key}"`);
});

test('the mainnet chain keys are canonical mhda 1.1 keys', () => {
  assert.equal(EVM_MAINNET_CHAIN_URN, 'nt:evm:ci:1');
  assert.equal(SOLANA_MAINNET_CHAIN_URN, 'nt:solana:ci:mainnet');
  assert.equal(SUI_MAINNET_CHAIN_URN, 'nt:sui:ci:mainnet');
  assert.equal(TRON_MAINNET_CHAIN_URN, 'nt:tron:ci:mainnet');
  assert.equal(TON_MAINNET_CHAIN_URN, 'nt:ton:ci:mainnet');
});

test('no mainnet chain key carries a pre-1.1 coin-type segment', () => {
  for (const urn of [
    EVM_MAINNET_CHAIN_URN,
    SOLANA_MAINNET_CHAIN_URN,
    SUI_MAINNET_CHAIN_URN,
    TRON_MAINNET_CHAIN_URN,
    TON_MAINNET_CHAIN_URN,
  ]) {
    assert.ok(!urn.includes(':ct:'), `${urn} must not carry ct:`);
    assert.match(urn, /^nt:[a-z]+:ci:[^:]+$/, `${urn} is not a canonical key`);
  }
});

test('the mhda 1.1 network-type spellings are used (not the pre-1.1 names)', () => {
  // 1.1 renamed sol->solana and tvm->tron; evm/sui/ton are unchanged.
  assert.equal(MhdaNetwork.Solana, 'solana');
  assert.equal(MhdaNetwork.Tron, 'tron');
  assert.ok(!SOLANA_MAINNET_CHAIN_URN.includes('nt:sol:'));
  assert.ok(!TRON_MAINNET_CHAIN_URN.includes('nt:tvm:'));
});

test("the Solana devnet key is the desktop manifest's", () => {
  assert.equal(SOLANA_DEVNET_CHAIN_URN, 'nt:solana:ci:devnet');
});
