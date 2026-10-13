import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base58Decode } from '../src/inpage/base58';

test('empty string decodes to empty bytes', () => {
  assert.deepEqual(base58Decode(''), new Uint8Array(0));
});

test('single-digit KATs', () => {
  assert.deepEqual(base58Decode('1'), new Uint8Array([0]));
  assert.deepEqual(base58Decode('2'), new Uint8Array([1]));
  assert.deepEqual(base58Decode('z'), new Uint8Array([57]));
});

test('leading 1s map to leading zero bytes', () => {
  assert.deepEqual(base58Decode('11'), new Uint8Array([0, 0]));
  assert.deepEqual(base58Decode('111'), new Uint8Array([0, 0, 0]));
});

test('multi-digit KATs', () => {
  assert.deepEqual(base58Decode('21'), new Uint8Array([58])); // 1*58 + 0
  assert.deepEqual(base58Decode('5Q'), new Uint8Array([255])); // 4*58 + 23
});

test('the Solana System Program (32 ones) decodes to 32 zero bytes', () => {
  const sys = '1'.repeat(32);
  assert.deepEqual(base58Decode(sys), new Uint8Array(32));
});

test('a real 44-char Solana address decodes to a 32-byte pubkey', () => {
  // Wrapped SOL mint — a well-known mainnet address.
  const pk = base58Decode('So11111111111111111111111111111111111111112');
  assert.equal(pk.length, 32);
  // Its trailing byte is the 58-alphabet index of '2' (= 1).
  assert.equal(pk[31], 1);
});

test('a non-alphabet character throws', () => {
  // 0, O, I, l are the four characters Base58 excludes.
  for (const bad of ['0', 'O', 'I', 'l', '!', ' ']) {
    assert.throws(() => base58Decode(bad), /invalid base58 character/);
  }
});
