import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  base64Decode,
  base64Encode,
  bytesToHex0x,
  hexDecode,
} from '../src/inpage/encoding';

test('bytesToHex0x produces 0x-prefixed lowercase hex, byte-padded', () => {
  assert.equal(bytesToHex0x(new Uint8Array([])), '0x');
  assert.equal(
    bytesToHex0x(new Uint8Array([0xde, 0xad, 0xbe, 0xef])),
    '0xdeadbeef'
  );
  assert.equal(bytesToHex0x(new Uint8Array([0x00, 0x0f, 0xa0])), '0x000fa0');
});

test('base64Decode decodes standard padded base64 to bytes', () => {
  // "Hello" → "SGVsbG8="
  assert.deepEqual(
    base64Decode('SGVsbG8='),
    new Uint8Array([72, 101, 108, 108, 111])
  );
  assert.deepEqual(base64Decode(''), new Uint8Array(0));
});

test('base64Decode round-trips an arbitrary byte string via btoa', () => {
  const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 64]);
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  assert.deepEqual(base64Decode(btoa(binary)), bytes);
});

test('base64Encode produces standard padded base64', () => {
  assert.equal(
    base64Encode(new Uint8Array([72, 101, 108, 108, 111])),
    'SGVsbG8='
  );
  assert.equal(base64Encode(new Uint8Array([])), '');
});

test('base64Encode/base64Decode round-trip all byte values', () => {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    bytes[i] = i;
  }
  assert.deepEqual(base64Decode(base64Encode(bytes)), bytes);
});

test('hexDecode parses bare hex (the host pubkey form)', () => {
  assert.deepEqual(
    hexDecode('deadbeef'),
    new Uint8Array([0xde, 0xad, 0xbe, 0xef])
  );
  assert.deepEqual(hexDecode(''), new Uint8Array(0));
  assert.deepEqual(hexDecode('00ff'), new Uint8Array([0x00, 0xff]));
});

test('hexDecode accepts an optional 0x prefix (the host address form)', () => {
  assert.deepEqual(
    hexDecode('0xdeadbeef'),
    new Uint8Array([0xde, 0xad, 0xbe, 0xef])
  );
  assert.deepEqual(hexDecode('0Xabcd'), new Uint8Array([0xab, 0xcd]));
});

test('hexDecode round-trips bytesToHex0x for all byte values', () => {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    bytes[i] = i;
  }
  assert.deepEqual(hexDecode(bytesToHex0x(bytes)), bytes);
});

test('hexDecode throws on odd-length or non-hex input (never a truncated key)', () => {
  assert.throws(() => hexDecode('abc'), /odd-length/);
  assert.throws(() => hexDecode('0xabc'), /odd-length/);
  assert.throws(() => hexDecode('zz'), /non-hex/);
  assert.throws(() => hexDecode('00gg'), /non-hex/);
});
