import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  AUTH_MAC_BYTES,
  AUTH_SECRET_BYTES,
  AUTH_TRANSCRIPT_BYTES,
  AuthExchange,
  AuthRole,
  buildTranscript,
  computeMac,
  importAuthKey,
  isFramable,
  verifyMac,
} from '../src/transport/auth_handshake';
import { WEB3_PROTOCOL_VERSION } from '../src/protocol/envelope';

// The known-answer file is the desktop app's own, copied unchanged: both sides
// of the handshake must frame the same 81 bytes and reach the same MACs, so they
// are checked against one set of vectors rather than two that could drift.

interface VectorVersion {
  wallet: number;
  major: number;
  minor: number;
}

interface Vector {
  name: string;
  secret: string;
  iid: string;
  client_nonce: string;
  server_nonce: string;
  port: number;
  version: VectorVersion;
  server_transcript: string;
  server_mac: string;
  client_transcript: string;
  client_mac: string;
}

interface Reject {
  name: string;
  iid: string;
  version: VectorVersion;
}

interface VectorFile {
  transcript_bytes: number;
  vectors: Vector[];
  rejects: Reject[];
}

const KAT = JSON.parse(
  readFileSync(
    path.join(__dirname, 'testdata', 'auth_handshake_vectors.json'),
    'utf8'
  )
) as VectorFile;

const hex = (s: string): Uint8Array<ArrayBuffer> => {
  assert.equal(s.length % 2, 0, `odd hex length: ${s}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
};

const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const exchangeOf = (v: Vector): AuthExchange => ({
  iid: v.iid,
  clientNonce: hex(v.client_nonce),
  serverNonce: hex(v.server_nonce),
  port: v.port,
  version: { ...v.version },
});

const FIRST = KAT.vectors[0];

const SIDES: { role: AuthRole; transcript: keyof Vector; mac: keyof Vector }[] =
  [
    { role: 'server', transcript: 'server_transcript', mac: 'server_mac' },
    { role: 'client', transcript: 'client_transcript', mac: 'client_mac' },
  ];

test('the known-answer file is complete', () => {
  assert.equal(KAT.transcript_bytes, AUTH_TRANSCRIPT_BYTES);
  assert.equal(AUTH_TRANSCRIPT_BYTES, 81);
  assert.equal(AUTH_SECRET_BYTES, 32);
  assert.equal(AUTH_MAC_BYTES, 32);
  assert.ok(KAT.vectors.length >= 5, 'vectors');
  assert.ok(KAT.rejects.length >= 9, 'rejects');
});

test('the first vector is the handshake at this extension’s own protocol version', () => {
  // The desktop writes the transcript with the version on its begin answer: a
  // desktop of this extension's major answers with this version.
  assert.deepEqual(FIRST.version, WEB3_PROTOCOL_VERSION);
  assert.equal(FIRST.port, 8114);
});

test('the transcript of each vector matches the desktop byte for byte', () => {
  for (const v of KAT.vectors) {
    const ex = exchangeOf(v);
    assert.equal(isFramable(ex), true, v.name);
    for (const side of SIDES) {
      const t = buildTranscript(side.role, ex);
      assert.equal(t.length, AUTH_TRANSCRIPT_BYTES, `${v.name} ${side.role}`);
      assert.equal(
        toHex(t),
        v[side.transcript] as string,
        `${v.name} ${side.role}`
      );
    }
  }
});

test('the MAC of each vector matches the desktop', async () => {
  for (const v of KAT.vectors) {
    const key = await importAuthKey(hex(v.secret));
    const ex = exchangeOf(v);
    for (const side of SIDES) {
      const mac = await computeMac(key, side.role, ex);
      assert.equal(mac.length, AUTH_MAC_BYTES, `${v.name} ${side.role}`);
      assert.equal(toHex(mac), v[side.mac] as string, `${v.name} ${side.role}`);
    }
  }
});

test('each side accepts its peer’s MAC from the vectors', async () => {
  for (const v of KAT.vectors) {
    const key = await importAuthKey(hex(v.secret));
    const ex = exchangeOf(v);
    for (const side of SIDES) {
      assert.equal(
        await verifyMac(key, side.role, ex, hex(v[side.mac] as string)),
        true,
        `${v.name} ${side.role}`
      );
    }
  }
});

test('one side’s MAC never passes as the other’s', async () => {
  for (const v of KAT.vectors) {
    const key = await importAuthKey(hex(v.secret));
    const ex = exchangeOf(v);
    assert.equal(
      await verifyMac(key, 'client', ex, hex(v.server_mac)),
      false,
      v.name
    );
    assert.equal(
      await verifyMac(key, 'server', ex, hex(v.client_mac)),
      false,
      v.name
    );
  }
});

test('a MAC with any one bit flipped is refused', async () => {
  const key = await importAuthKey(hex(FIRST.secret));
  const ex = exchangeOf(FIRST);
  const good = hex(FIRST.server_mac);
  for (let i = 0; i < good.length; i++) {
    for (const bit of [0x01, 0x80]) {
      const bad = new Uint8Array(good);
      bad[i] ^= bit;
      assert.equal(
        await verifyMac(key, 'server', ex, bad),
        false,
        `byte ${i} bit ${bit}`
      );
    }
  }
});

test('a MAC of another length is refused, even a prefix or an extension of the right one', async () => {
  const key = await importAuthKey(hex(FIRST.secret));
  const ex = exchangeOf(FIRST);
  const good = hex(FIRST.server_mac);
  const longer = new Uint8Array(AUTH_MAC_BYTES + 1);
  longer.set(good);
  for (const bad of [
    new Uint8Array(0),
    good.slice(0, 16),
    good.slice(0, AUTH_MAC_BYTES - 1),
    longer,
  ]) {
    assert.equal(
      await verifyMac(key, 'server', ex, bad),
      false,
      `${bad.length} bytes`
    );
  }
});

test('a MAC under another secret, port, nonce order, iid or version is refused', async () => {
  const key = await importAuthKey(hex(FIRST.secret));
  const other = await importAuthKey(new Uint8Array(AUTH_SECRET_BYTES).fill(7));
  const ex = exchangeOf(FIRST);
  const mac = hex(FIRST.client_mac);
  assert.equal(await verifyMac(other, 'client', ex, mac), false, 'secret');
  const variants: [string, AuthExchange][] = [
    ['port', { ...ex, port: ex.port + 1 }],
    [
      'nonces',
      { ...ex, clientNonce: ex.serverNonce, serverNonce: ex.clientNonce },
    ],
    ['iid', { ...ex, iid: ex.iid.replace('3f2b', '3f2c') }],
    ['wallet', { ...ex, version: { ...ex.version, wallet: 3 } }],
    [
      'major',
      { ...ex, version: { ...ex.version, major: ex.version.major + 1 } },
    ],
    ['minor', { ...ex, version: { ...ex.version, minor: 0 } }],
  ];
  for (const [name, variant] of variants) {
    assert.equal(isFramable(variant), true, name);
    assert.equal(await verifyMac(key, 'client', variant, mac), false, name);
  }
});

test('the desktop’s rejects cannot be framed, signed or verified', async () => {
  const key = await importAuthKey(hex(FIRST.secret));
  for (const r of KAT.rejects) {
    const ex: AuthExchange = {
      ...exchangeOf(FIRST),
      iid: r.iid,
      version: { ...r.version },
    };
    assert.equal(isFramable(ex), false, r.name);
    for (const side of SIDES) {
      assert.throws(() => buildTranscript(side.role, ex), RangeError, r.name);
      await assert.rejects(computeMac(key, side.role, ex), RangeError, r.name);
      assert.equal(
        await verifyMac(key, side.role, ex, hex(FIRST[side.mac] as string)),
        false,
        r.name
      );
    }
  }
});

// The desktop's types make these impossible there (fixed arrays, a u16 port);
// a JS number or a Uint8Array of any length has to be refused here instead.
test('a nonce of another length, or a port or version that is not a u16 integer, cannot be framed', async () => {
  const key = await importAuthKey(hex(FIRST.secret));
  const ex = exchangeOf(FIRST);
  const cases: [string, AuthExchange][] = [
    ['client nonce 15', { ...ex, clientNonce: ex.clientNonce.slice(0, 15) }],
    ['client nonce 17', { ...ex, clientNonce: new Uint8Array(17) }],
    ['server nonce 15', { ...ex, serverNonce: ex.serverNonce.slice(0, 15) }],
    ['server nonce 17', { ...ex, serverNonce: new Uint8Array(17) }],
    ['empty nonce', { ...ex, clientNonce: new Uint8Array(0) }],
    ['port 65536', { ...ex, port: 65536 }],
    ['port -1', { ...ex, port: -1 }],
    ['port 8114.5', { ...ex, port: 8114.5 }],
    ['port NaN', { ...ex, port: NaN }],
    ['minor 1.5', { ...ex, version: { ...ex.version, minor: 1.5 } }],
    ['minor -1', { ...ex, version: { ...ex.version, minor: -1 } }],
    ['major NaN', { ...ex, version: { ...ex.version, major: NaN } }],
    [
      'wallet Infinity',
      { ...ex, version: { ...ex.version, wallet: Infinity } },
    ],
  ];
  for (const [name, bad] of cases) {
    assert.equal(isFramable(bad), false, name);
    assert.throws(() => buildTranscript('client', bad), RangeError, name);
    await assert.rejects(computeMac(key, 'client', bad), RangeError, name);
    assert.equal(
      await verifyMac(key, 'client', bad, hex(FIRST.client_mac)),
      false,
      name
    );
  }
});

test('the u16 bounds themselves still frame', () => {
  const ex = exchangeOf(FIRST);
  for (const port of [0, 65535]) {
    assert.equal(isFramable({ ...ex, port }), true, `port ${port}`);
  }
  for (const n of [0, 65535]) {
    const version = { wallet: n, major: n, minor: n };
    assert.equal(isFramable({ ...ex, version }), true, `version ${n}`);
  }
});

test('the transcript does not alias the caller’s nonces', () => {
  const ex = exchangeOf(FIRST);
  const t = buildTranscript('client', ex);
  t.fill(0);
  assert.equal(toHex(ex.clientNonce), FIRST.client_nonce);
  assert.equal(toHex(ex.serverNonce), FIRST.server_nonce);
});

test('the pairing secret imports as a non-extractable HMAC-SHA-256 key', async () => {
  const key = await importAuthKey(hex(FIRST.secret));
  assert.equal(key.extractable, false);
  assert.equal(key.type, 'secret');
  assert.deepEqual([...key.usages].sort(), ['sign', 'verify']);
  const alg = key.algorithm as HmacKeyAlgorithm;
  assert.equal(alg.name, 'HMAC');
  assert.equal(alg.hash.name, 'SHA-256');
  assert.equal(alg.length, AUTH_SECRET_BYTES * 8);
  await assert.rejects(crypto.subtle.exportKey('raw', key));
});

test('a pairing secret of another length is refused at import', async () => {
  for (const n of [0, 16, AUTH_SECRET_BYTES - 1, AUTH_SECRET_BYTES + 1, 64]) {
    await assert.rejects(
      importAuthKey(new Uint8Array(n)),
      RangeError,
      `${n} bytes`
    );
  }
});

test('a key that is not this handshake’s cannot sign or verify', async () => {
  const ex = exchangeOf(FIRST);
  const raw = hex(FIRST.secret);
  const mac = hex(FIRST.client_mac);
  const wrong: [string, CryptoKey][] = [
    [
      'SHA-1',
      await crypto.subtle.importKey(
        'raw',
        raw,
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['sign', 'verify']
      ),
    ],
    [
      'SHA-512',
      await crypto.subtle.importKey(
        'raw',
        raw,
        { name: 'HMAC', hash: 'SHA-512' },
        false,
        ['sign', 'verify']
      ),
    ],
    [
      '16-byte key',
      await crypto.subtle.importKey(
        'raw',
        raw.slice(0, 16),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify']
      ),
    ],
  ];
  for (const [name, key] of wrong) {
    await assert.rejects(computeMac(key, 'client', ex), RangeError, name);
    assert.equal(await verifyMac(key, 'client', ex, mac), false, name);
  }
});

test('verification fails closed when WebCrypto itself refuses', async () => {
  // A right-shaped key whose usages allow signing only: subtle.verify rejects,
  // and that rejection must read as "not proven", never as a pass.
  const signOnly = await crypto.subtle.importKey(
    'raw',
    hex(FIRST.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const ex = exchangeOf(FIRST);
  assert.equal(
    toHex(await computeMac(signOnly, 'client', ex)),
    FIRST.client_mac
  );
  assert.equal(
    await verifyMac(signOnly, 'client', ex, hex(FIRST.client_mac)),
    false
  );
});
