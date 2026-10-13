// The key schedule that pairs this extension with the desktop app: an X25519
// exchange mixed with the one-time code (pair_code.ts), then explicit key
// confirmation, the shape of TLS 1.3's psk_dhe_ke (RFC 8446 section 7.1).
// Every field has a fixed width, so the concatenation is injective:
//
//   th        = SHA-256("airnox-web3-pair-v1" | iid(36) | client public(32)
//                       | server public(32) | client nonce(16)
//                       | server nonce(16) | port(u32be)
//                       | wallet, major, minor (u16be each))   161 bytes hashed
//   prk       = HKDF-SHA-256-Extract(salt = th, ikm = X25519 shared(32) | code(16))
//   k_confirm = HKDF-Expand(prk, "airnox-web3-pair-confirm-v1", 32)
//   secret    = HKDF-Expand(prk, "airnox-web3-pair-secret-v1", 32)
//   mac       = HMAC-SHA-256(k_confirm, "cli" | th) from the extension,
//               "srv" | th from the desktop
//
// The extension confirms first: a program posing as the desktop gets one
// online guess at the code and nothing keyed by it. The port binds the
// listener the extension dialled, so a relay on another loopback port cannot
// pass the real desktop's proof through; the version is the DESKTOP's, read off
// its answer, as in the socket handshake (auth_handshake.ts).
//
// WebCrypto does the work and holds the keys: the ephemeral private key is
// generated non-extractable, and k_confirm and the secret are derived straight
// into non-extractable HMAC keys (HKDF is Extract then Expand, RFC 5869, so one
// HKDF call per label is the schedule above). Only the X25519 output and the
// code pass through JS bytes, briefly, to form the HKDF input; they are zeroed
// once imported. The desktop app runs the same schedule; both are checked
// against one known-answer file.
//
// Pure: no I/O, no state, nothing here touches the socket.

import { AuthExchange, AuthRole, isFramable } from './auth_handshake';
import { PAIR_CODE_CHARS, isCanonicalCode } from './pair_code';

export const PAIR_TRANSCRIPT_LABEL = 'airnox-web3-pair-v1';
export const PAIR_CONFIRM_LABEL = 'airnox-web3-pair-confirm-v1';
export const PAIR_SECRET_LABEL = 'airnox-web3-pair-secret-v1';

export const PAIR_PUBLIC_KEY_BYTES = 32;
const DIGEST_BYTES = 32;
const SHARED_BYTES = 32;
const IID_BYTES = 36;
const NONCE_BYTES = 16;

export const PAIR_TRANSCRIPT_BYTES =
  PAIR_TRANSCRIPT_LABEL.length +
  IID_BYTES +
  2 * PAIR_PUBLIC_KEY_BYTES +
  2 * NONCE_BYTES +
  4 +
  3 * 2;

const X25519 = { name: 'X25519' } as const;
const HMAC_KEY: HmacKeyGenParams = {
  name: 'HMAC',
  hash: 'SHA-256',
  length: 256,
};
const TAGS: Record<AuthRole, string> = { server: 'srv', client: 'cli' };

const utf8 = (s: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(s);

// What the transcript binds: the iid, the nonces, the port and the version as
// the socket handshake frames them, and both ephemeral public keys.
export interface PairExchange {
  bind: AuthExchange;
  clientPublic: Uint8Array;
  serverPublic: Uint8Array;
}

// One side's ephemeral key for one pairing attempt.
export interface PairEphemeral {
  privateKey: CryptoKey; // X25519, non-extractable, deriveBits only
  publicKey: Uint8Array; // 32 bytes, what goes on the wire
}

// The keys one pairing derives, both non-extractable HMAC-SHA-256 keys.
export interface PairKeys {
  confirm: CryptoKey; // k_confirm, for the two confirmations only
  secret: CryptoKey; // the pairing secret the socket handshake signs with
}

export const isPairFramable = (ex: PairExchange): boolean =>
  isFramable(ex.bind) &&
  ex.clientPublic.length === PAIR_PUBLIC_KEY_BYTES &&
  ex.serverPublic.length === PAIR_PUBLIC_KEY_BYTES;

// The 161 bytes hashed into th, in a fresh buffer. Throws a RangeError when
// !isPairFramable(ex).
export const buildPairTranscript = (
  ex: PairExchange
): Uint8Array<ArrayBuffer> => {
  if (!isPairFramable(ex)) {
    throw new RangeError(
      'pair handshake: the exchange cannot be framed (32-byte public keys, a 36-byte iid, 16-byte nonces, u16 port and version fields)'
    );
  }
  const t = new Uint8Array(PAIR_TRANSCRIPT_BYTES);
  const view = new DataView(t.buffer);
  let at = 0;
  const put = (bytes: Uint8Array): void => {
    t.set(bytes, at);
    at += bytes.length;
  };
  put(utf8(PAIR_TRANSCRIPT_LABEL));
  put(utf8(ex.bind.iid));
  put(ex.clientPublic);
  put(ex.serverPublic);
  put(ex.bind.clientNonce);
  put(ex.bind.serverNonce);
  view.setUint32(at, ex.bind.port);
  at += 4;
  const v = ex.bind.version;
  for (const field of [v.wallet, v.major, v.minor]) {
    view.setUint16(at, field);
    at += 2;
  }
  if (at !== PAIR_TRANSCRIPT_BYTES) {
    throw new Error('pair handshake: transcript length mismatch');
  }
  return t;
};

// th = SHA-256(transcript). Rejects with a RangeError when !isPairFramable(ex).
export const pairTranscriptHash = async (
  ex: PairExchange
): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(
    await crypto.subtle.digest('SHA-256', buildPairTranscript(ex))
  );

// A fresh ephemeral key from the platform's CSPRNG; the private half can derive
// and nothing else, and is never exportable.
export const generatePairEphemeral = async (): Promise<PairEphemeral> => {
  const pair = (await crypto.subtle.generateKey(X25519, false, [
    'deriveBits',
  ])) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey,
    publicKey: new Uint8Array(
      await crypto.subtle.exportKey('raw', pair.publicKey)
    ),
  };
};

// The X25519 shared secret with the peer, or null when the peer's key is of
// small order: the output would be all zero (RFC 7748 section 6.1), a value
// anyone can compute, so the peer is refused. WebCrypto itself refuses it
// (an OperationError); the zero test stands for a platform that does not.
const sharedSecret = async (
  own: CryptoKey,
  peerPublic: Uint8Array<ArrayBuffer>
): Promise<Uint8Array | null> => {
  try {
    const peer = await crypto.subtle.importKey(
      'raw',
      peerPublic,
      X25519,
      true,
      []
    );
    const dh = new Uint8Array(
      await crypto.subtle.deriveBits({ name: 'X25519', public: peer }, own, 256)
    );
    if (dh.length !== SHARED_BYTES || dh.every((b) => b === 0)) {
      dh.fill(0);
      return null;
    }
    return dh;
  } catch {
    return null;
  }
};

const expandInto = (
  ikm: CryptoKey,
  th: Uint8Array<ArrayBuffer>,
  label: string
): Promise<CryptoKey> =>
  crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: th, info: utf8(label) },
    ikm,
    HMAC_KEY,
    false,
    ['sign', 'verify']
  );

// The whole schedule for the side holding `own`, against the peer's public
// key. null when the peer's key is of small order: the peer is refused. Rejects
// with a RangeError, a caller bug, on a peer key that is not 32 bytes, a code
// that is not canonical (pair_code.ts parseCode gives the canonical form) or a
// th that is not 32 bytes.
export const derivePairKeys = async (
  own: CryptoKey,
  peerPublic: Uint8Array,
  code: string,
  th: Uint8Array
): Promise<PairKeys | null> => {
  if (peerPublic.length !== PAIR_PUBLIC_KEY_BYTES) {
    throw new RangeError('pair handshake: a public key is 32 bytes');
  }
  if (th.length !== DIGEST_BYTES) {
    throw new RangeError('pair handshake: th is 32 bytes');
  }
  if (!(await isCanonicalCode(code))) {
    throw new RangeError('pair handshake: the code is not canonical');
  }
  const dh = await sharedSecret(own, new Uint8Array(peerPublic));
  if (dh === null) {
    return null;
  }
  const ikm = new Uint8Array(SHARED_BYTES + PAIR_CODE_CHARS);
  ikm.set(dh);
  ikm.set(utf8(code), SHARED_BYTES);
  dh.fill(0);
  let ikmKey: CryptoKey;
  try {
    ikmKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, [
      'deriveKey',
    ]);
  } finally {
    ikm.fill(0);
  }
  const salt = new Uint8Array(th);
  return {
    confirm: await expandInto(ikmKey, salt, PAIR_CONFIRM_LABEL),
    secret: await expandInto(ikmKey, salt, PAIR_SECRET_LABEL),
  };
};

const confirmationInput = (
  role: AuthRole,
  th: Uint8Array
): Uint8Array<ArrayBuffer> => {
  const tag = utf8(TAGS[role]);
  const msg = new Uint8Array(tag.length + th.length);
  msg.set(tag);
  msg.set(th, tag.length);
  return msg;
};

// The confirmation `role` sends: HMAC-SHA-256(k_confirm, tag | th). Rejects
// with a RangeError on a th that is not 32 bytes.
export const pairConfirmation = async (
  confirm: CryptoKey,
  role: AuthRole,
  th: Uint8Array
): Promise<Uint8Array> => {
  if (th.length !== DIGEST_BYTES) {
    throw new RangeError('pair handshake: th is 32 bytes');
  }
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', confirm, confirmationInput(role, th))
  );
};

// Does `presented` (from the peer) confirm `role` over th? WebCrypto compares
// it, in constant time, after a length check. Fails closed and never rejects:
// a confirmation of another length, a th of another length or any WebCrypto
// failure is a false.
export const verifyPairConfirmation = async (
  confirm: CryptoKey,
  role: AuthRole,
  th: Uint8Array,
  presented: Uint8Array
): Promise<boolean> => {
  if (presented.length !== DIGEST_BYTES || th.length !== DIGEST_BYTES) {
    return false;
  }
  try {
    return await crypto.subtle.verify(
      'HMAC',
      confirm,
      new Uint8Array(presented),
      confirmationInput(role, th)
    );
  } catch {
    return false;
  }
};
