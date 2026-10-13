import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { importAuthKey } from '../src/transport/auth_handshake';
import { AUTH_TRANSCRIPT_BYTES } from '../src/transport/auth_handshake';
import {
  FINGERPRINT_BYTES,
  isKeyFingerprint,
  keyFingerprint,
} from '../src/transport/key_fingerprint';

const secret = (fill: number) => new Uint8Array(32).fill(fill);

test('the fingerprint is the key’s HMAC-SHA-256 over the label, cut to 16 bytes', async () => {
  const expected = createHmac('sha256', Buffer.from(secret(1)))
    .update('AirNox pairing key fingerprint')
    .digest()
    .subarray(0, FINGERPRINT_BYTES)
    .toString('hex');
  assert.equal(await keyFingerprint(await importAuthKey(secret(1))), expected);
});

test('one secret has one fingerprint, whatever key object holds it; another secret has another', async () => {
  const a1 = await keyFingerprint(await importAuthKey(secret(1)));
  const a2 = await keyFingerprint(await importAuthKey(secret(1)));
  const b = await keyFingerprint(await importAuthKey(secret(2)));
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.ok(isKeyFingerprint(a1));
  assert.ok(!a1.includes(Buffer.from(secret(1)).toString('hex')));
});

test('the label can never be a handshake transcript', () => {
  assert.notEqual(
    new TextEncoder().encode('AirNox pairing key fingerprint').length,
    AUTH_TRANSCRIPT_BYTES
  );
});

test('a stored value reads as a fingerprint only in its exact shape', () => {
  assert.ok(isKeyFingerprint('0'.repeat(32)));
  assert.ok(!isKeyFingerprint('0'.repeat(31)));
  assert.ok(!isKeyFingerprint('0'.repeat(33)));
  assert.ok(!isKeyFingerprint('G'.repeat(32)));
  assert.ok(!isKeyFingerprint('A'.repeat(32)));
  assert.ok(!isKeyFingerprint(undefined));
  assert.ok(!isKeyFingerprint(12));
});
