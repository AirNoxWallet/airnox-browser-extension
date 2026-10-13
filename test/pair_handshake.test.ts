import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { computeMac, importAuthKey } from '../src/transport/auth_handshake';
import {
  PAIR_CONFIRM_LABEL,
  PAIR_PUBLIC_KEY_BYTES,
  PAIR_SECRET_LABEL,
  PAIR_TRANSCRIPT_BYTES,
  PAIR_TRANSCRIPT_LABEL,
  PairExchange,
  buildPairTranscript,
  derivePairKeys,
  generatePairEphemeral,
  isPairFramable,
  pairConfirmation,
  pairTranscriptHash,
  verifyPairConfirmation,
} from '../src/transport/pair_handshake';

// The desktop app's known-answer file, copied unchanged: both sides must frame
// the same 161 bytes, derive the same keys and reach the same confirmations.

interface Version {
  wallet: number;
  major: number;
  minor: number;
}

interface Vector {
  name: string;
  iid: string;
  client_private: string;
  client_public: string;
  server_private: string;
  server_public: string;
  client_nonce: string;
  server_nonce: string;
  port: number;
  version: Version;
  code: string;
  transcript: string;
  th: string;
  k_confirm: string;
  secret: string;
  mac_cli: string;
  mac_srv: string;
}

type Binding = Omit<
  Vector,
  'client_private' | 'client_public' | 'transcript' | 'k_confirm' | 'secret'
>;

interface PairFile {
  transcript_label: string;
  confirm_label: string;
  secret_label: string;
  transcript_bytes: number;
  vectors: Vector[];
  binding: Binding[];
  low_order_publics: { name: string; public: string }[];
  length_rejects: { name: string; field: string; bytes: number }[];
}

const KAT = JSON.parse(
  readFileSync(path.join(__dirname, 'testdata', 'pair_vectors.json'), 'utf8')
) as PairFile;

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

const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url');

// A fixed X25519 private key, as the vectors give it. Production keys are
// generated, never imported; WebCrypto takes a raw private scalar only as a JWK.
const importPrivate = (priv: string, pub: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'X25519', d: b64url(hex(priv)), x: b64url(hex(pub)) },
    { name: 'X25519' },
    false,
    ['deriveBits']
  );

const exchangeOf = (
  v: Binding,
  clientPublic: string,
  serverPublic: string
): PairExchange => ({
  bind: {
    iid: v.iid,
    clientNonce: hex(v.client_nonce),
    serverNonce: hex(v.server_nonce),
    port: v.port,
    version: { ...v.version },
  },
  clientPublic: hex(clientPublic),
  serverPublic: hex(serverPublic),
});

// Two HMAC keys hold the same secret iff they sign a probe alike; neither key
// can be exported, so this is the only way to compare them.
const PROBE = new TextEncoder().encode('probe');
const sameHmacKey = async (a: CryptoKey, b: CryptoKey): Promise<boolean> =>
  toHex(new Uint8Array(await crypto.subtle.sign('HMAC', a, PROBE))) ===
  toHex(new Uint8Array(await crypto.subtle.sign('HMAC', b, PROBE)));

const FIRST = KAT.vectors[0];

test('the known-answer file is complete and its labels are ours', () => {
  assert.equal(KAT.transcript_bytes, PAIR_TRANSCRIPT_BYTES);
  assert.equal(PAIR_TRANSCRIPT_BYTES, 161);
  assert.equal(PAIR_PUBLIC_KEY_BYTES, 32);
  assert.equal(KAT.transcript_label, PAIR_TRANSCRIPT_LABEL);
  assert.equal(KAT.confirm_label, PAIR_CONFIRM_LABEL);
  assert.equal(KAT.secret_label, PAIR_SECRET_LABEL);
  assert.ok(KAT.vectors.length >= 3);
  assert.ok(KAT.binding.length >= 6);
  assert.ok(KAT.low_order_publics.length >= 7);
});

test('the transcript and th of each vector match the desktop byte for byte', async () => {
  for (const v of KAT.vectors) {
    const ex = exchangeOf(v, v.client_public, v.server_public);
    assert.equal(isPairFramable(ex), true, v.name);
    assert.equal(toHex(buildPairTranscript(ex)), v.transcript, v.name);
    assert.equal(toHex(await pairTranscriptHash(ex)), v.th, v.name);
  }
});

test('each side derives the desktop’s k_confirm and secret, and both confirmations', async () => {
  for (const v of KAT.vectors) {
    const th = hex(v.th);
    const sides = [
      {
        own: await importPrivate(v.client_private, v.client_public),
        peer: v.server_public,
      },
      {
        own: await importPrivate(v.server_private, v.server_public),
        peer: v.client_public,
      },
    ];
    for (const side of sides) {
      const keys = await derivePairKeys(side.own, hex(side.peer), v.code, th);
      assert.ok(keys, v.name);
      assert.equal(keys.confirm.extractable, false, v.name);
      assert.equal(keys.secret.extractable, false, v.name);
      const confirm = await importAuthKey(hex(v.k_confirm));
      assert.equal(await sameHmacKey(keys.confirm, confirm), true, v.name);
      const secret = await importAuthKey(hex(v.secret));
      assert.equal(await sameHmacKey(keys.secret, secret), true, v.name);
      assert.equal(
        toHex(await pairConfirmation(keys.confirm, 'client', th)),
        v.mac_cli,
        v.name
      );
      assert.equal(
        toHex(await pairConfirmation(keys.confirm, 'server', th)),
        v.mac_srv,
        v.name
      );
    }
  }
});

test('the derived secret is a key the socket handshake signs with', async () => {
  const keys = await derivePairKeys(
    await importPrivate(FIRST.client_private, FIRST.client_public),
    hex(FIRST.server_public),
    FIRST.code,
    hex(FIRST.th)
  );
  assert.ok(keys);
  const ex = exchangeOf(FIRST, FIRST.client_public, FIRST.server_public).bind;
  assert.deepEqual(
    await computeMac(keys.secret, 'client', ex),
    await computeMac(await importAuthKey(hex(FIRST.secret)), 'client', ex)
  );
});

test('each binding vector changes th or the confirmations as the desktop’s does', async () => {
  const own = await importPrivate(FIRST.client_private, FIRST.client_public);
  for (const b of KAT.binding) {
    const ex = exchangeOf(b, FIRST.client_public, b.server_public);
    const th = await pairTranscriptHash(ex);
    assert.equal(toHex(th), b.th, b.name);
    const keys = await derivePairKeys(own, hex(b.server_public), b.code, th);
    assert.ok(keys, b.name);
    const cli = await pairConfirmation(keys.confirm, 'client', th);
    assert.equal(toHex(cli), b.mac_cli, b.name);
    assert.notEqual(toHex(cli), FIRST.mac_cli, b.name);
    assert.equal(
      toHex(await pairConfirmation(keys.confirm, 'server', th)),
      b.mac_srv,
      b.name
    );
  }
});

test('verifyPairConfirmation accepts the peer’s proof and nothing else', async () => {
  const th = hex(FIRST.th);
  const keys = await derivePairKeys(
    await importPrivate(FIRST.client_private, FIRST.client_public),
    hex(FIRST.server_public),
    FIRST.code,
    th
  );
  assert.ok(keys);
  const srv = hex(FIRST.mac_srv);
  assert.equal(
    await verifyPairConfirmation(keys.confirm, 'server', th, srv),
    true
  );
  // Our own proof never passes as the desktop's.
  assert.equal(
    await verifyPairConfirmation(
      keys.confirm,
      'server',
      th,
      hex(FIRST.mac_cli)
    ),
    false
  );
  assert.equal(
    await verifyPairConfirmation(keys.confirm, 'client', th, srv),
    false
  );
  const flipped = new Uint8Array(srv);
  flipped[31] ^= 1;
  assert.equal(
    await verifyPairConfirmation(keys.confirm, 'server', th, flipped),
    false
  );
  for (const r of KAT.length_rejects.filter((x) => x.field === 'mac')) {
    const mac = new Uint8Array(r.bytes);
    mac.set(srv.subarray(0, Math.min(r.bytes, srv.length)));
    assert.equal(
      await verifyPairConfirmation(keys.confirm, 'server', th, mac),
      false,
      r.name
    );
  }
  // Another th (another port, another nonce) is another proof.
  const otherTh = hex(KAT.binding[1].th);
  assert.equal(
    await verifyPairConfirmation(keys.confirm, 'server', otherTh, srv),
    false
  );
});

test('a peer key of small order is refused: no keys', async () => {
  const own = await importPrivate(FIRST.client_private, FIRST.client_public);
  for (const lo of KAT.low_order_publics) {
    assert.equal(
      await derivePairKeys(own, hex(lo.public), FIRST.code, hex(FIRST.th)),
      null,
      lo.name
    );
  }
});

test('a peer key of another length, a non-canonical code or a short th is a caller bug', async () => {
  const own = await importPrivate(FIRST.client_private, FIRST.client_public);
  for (const r of KAT.length_rejects.filter((x) => x.field === 'public')) {
    await assert.rejects(
      derivePairKeys(own, new Uint8Array(r.bytes), FIRST.code, hex(FIRST.th)),
      RangeError,
      r.name
    );
  }
  for (const code of [
    FIRST.code.toLowerCase(),
    `${FIRST.code.slice(0, 15)}G`,
    '5PCT-FFMD-QFZA-5BRF',
  ]) {
    await assert.rejects(
      derivePairKeys(own, hex(FIRST.server_public), code, hex(FIRST.th)),
      RangeError,
      code
    );
  }
  await assert.rejects(
    derivePairKeys(
      own,
      hex(FIRST.server_public),
      FIRST.code,
      hex(FIRST.th).subarray(1)
    ),
    RangeError
  );
});

test('an exchange with a public key of another length cannot be framed', () => {
  const ex = exchangeOf(FIRST, FIRST.client_public, FIRST.server_public);
  assert.equal(
    isPairFramable({ ...ex, clientPublic: ex.clientPublic.subarray(1) }),
    false
  );
  assert.equal(
    isPairFramable({ ...ex, serverPublic: new Uint8Array(33) }),
    false
  );
  assert.equal(
    isPairFramable({ ...ex, bind: { ...ex.bind, port: 65536 } }),
    false
  );
  assert.throws(
    () => buildPairTranscript({ ...ex, serverPublic: new Uint8Array(31) }),
    RangeError
  );
});

test('an ephemeral key: a fresh pair each time, the private half never exportable', async () => {
  const a = await generatePairEphemeral();
  const b = await generatePairEphemeral();
  assert.equal(a.privateKey.extractable, false);
  assert.equal(a.publicKey.length, PAIR_PUBLIC_KEY_BYTES);
  assert.notEqual(toHex(a.publicKey), toHex(b.publicKey));
  await assert.rejects(crypto.subtle.exportKey('pkcs8', a.privateKey));
  // Two fresh keys agree on one schedule.
  const th = hex(FIRST.th);
  const ka = await derivePairKeys(a.privateKey, b.publicKey, FIRST.code, th);
  const kb = await derivePairKeys(b.privateKey, a.publicKey, FIRST.code, th);
  assert.ok(ka && kb);
  assert.equal(await sameHmacKey(ka.secret, kb.secret), true);
});
