// The mutual challenge-response that will authenticate the loopback socket and
// the desktop app to each other with the secret they share since pairing. Each
// side sends a 16-byte nonce; each proves the secret with an HMAC-SHA-256
// (RFC 2104) over one transcript, the desktop first ("srv"), the extension
// second ("cli"):
//
//   tag(3) | iid(36) | client nonce(16) | server nonce(16) | port(u32be)
//          | wallet, major, minor (u16be each)
//
// 81 bytes. Every field has a fixed width, so the concatenation is injective
// without separators; a variable-length field may only join behind a
// length-prefixed framing. The tag keeps one side's MAC from ever passing as the
// other's (the desktop answers a handshake begin for any caller, so it is a free
// "srv" MAC oracle); the port keeps a relay on another loopback port from
// forwarding the real desktop's proof. The desktop app frames the same bytes;
// both are checked against one known-answer file.
//
// The secret lives only inside a non-extractable WebCrypto key, and the MACs are
// made and checked by WebCrypto itself (`subtle.sign` / `subtle.verify`), so the
// comparison is the platform's constant-time one, never a JS byte loop.
//
// Pure: no I/O, no state, nothing here touches the socket.

import { ProtocolVersion } from '../protocol/envelope';

const TAG_BYTES = 3;
const IID_BYTES = 36;
const NONCE_BYTES = 16;
const PORT_BYTES = 4;
const VERSION_FIELD_BYTES = 2;

export const AUTH_TRANSCRIPT_BYTES =
  TAG_BYTES +
  IID_BYTES +
  2 * NONCE_BYTES +
  PORT_BYTES +
  3 * VERSION_FIELD_BYTES;
export const AUTH_SECRET_BYTES = 32;
export const AUTH_MAC_BYTES = 32;

const U16_MAX = 0xffff;

const HMAC_SHA256: HmacImportParams = { name: 'HMAC', hash: 'SHA-256' };

const TAGS: Record<AuthRole, string> = { server: 'srv', client: 'cli' };

// Whose proof: the desktop's (tag "srv") or the extension's (tag "cli").
export type AuthRole = 'server' | 'client';

// Everything a MAC binds besides the role. `iid` is the instance id the socket
// presented, exactly 36 UTF-8 bytes; `port` the loopback port the extension
// dialled and the desktop listens on; `version` the protocol version the desktop
// reports. Port and version fields are integers in 0..65535.
export interface AuthExchange {
  iid: string;
  clientNonce: Uint8Array;
  serverNonce: Uint8Array;
  port: number;
  version: ProtocolVersion;
}

const isU16 = (n: number): boolean =>
  Number.isInteger(n) && n >= 0 && n <= U16_MAX;

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// True iff `ex` can be framed: a 36-byte iid, two 16-byte nonces, and a port
// and version fields that are u16 integers (never truncated or rounded).
export const isFramable = (ex: AuthExchange): boolean =>
  utf8(ex.iid).length === IID_BYTES &&
  ex.clientNonce.length === NONCE_BYTES &&
  ex.serverNonce.length === NONCE_BYTES &&
  isU16(ex.port) &&
  isU16(ex.version.wallet) &&
  isU16(ex.version.major) &&
  isU16(ex.version.minor);

// The transcript bytes for `role`, in a fresh buffer. Throws a RangeError when
// !isFramable(ex).
export const buildTranscript = (
  role: AuthRole,
  ex: AuthExchange
): Uint8Array<ArrayBuffer> => {
  if (!isFramable(ex)) {
    throw new RangeError(
      'auth handshake: the exchange cannot be framed (a 36-byte iid, 16-byte nonces, u16 port and version fields)'
    );
  }
  const t = new Uint8Array(AUTH_TRANSCRIPT_BYTES);
  const view = new DataView(t.buffer);
  let at = 0;
  const put = (bytes: Uint8Array): void => {
    t.set(bytes, at);
    at += bytes.length;
  };
  put(utf8(TAGS[role]));
  put(utf8(ex.iid));
  put(ex.clientNonce);
  put(ex.serverNonce);
  view.setUint32(at, ex.port);
  at += PORT_BYTES;
  for (const field of [ex.version.wallet, ex.version.major, ex.version.minor]) {
    view.setUint16(at, field);
    at += VERSION_FIELD_BYTES;
  }
  if (at !== AUTH_TRANSCRIPT_BYTES) {
    throw new Error('auth handshake: transcript length mismatch');
  }
  return t;
};

// Import the 32-byte pairing secret as a non-extractable HMAC-SHA-256 key that
// can only sign and verify. Rejects with a RangeError on a secret of another
// length. The caller drops its copy of the raw bytes once this resolves.
export const importAuthKey = async (secret: Uint8Array): Promise<CryptoKey> => {
  if (secret.length !== AUTH_SECRET_BYTES) {
    throw new RangeError('auth handshake: the pairing secret must be 32 bytes');
  }
  return crypto.subtle.importKey(
    'raw',
    new Uint8Array(secret),
    HMAC_SHA256,
    false,
    ['sign', 'verify']
  );
};

// A key this handshake can use: HMAC over SHA-256 with a 256-bit secret. A key
// of another hash or size can only come from a caller bug; it is refused rather
// than used to sign something the peer would never accept.
const isAuthKey = (key: CryptoKey): boolean => {
  const alg = key.algorithm as HmacKeyAlgorithm;
  return (
    alg.name === 'HMAC' &&
    alg.hash.name === 'SHA-256' &&
    alg.length === AUTH_SECRET_BYTES * 8
  );
};

// HMAC-SHA-256 under `key` over buildTranscript(role, ex). Rejects with a
// RangeError on a key that is not an importAuthKey one or an exchange that
// cannot be framed.
export const computeMac = async (
  key: CryptoKey,
  role: AuthRole,
  ex: AuthExchange
): Promise<Uint8Array> => {
  if (!isAuthKey(key)) {
    throw new RangeError('auth handshake: not an HMAC-SHA-256 pairing key');
  }
  const t = buildTranscript(role, ex);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, t));
};

// Does `presented` (from the peer) prove the key's secret for `role` over `ex`?
// WebCrypto compares it, after a length check. Fails closed and never rejects:
// a MAC of another length, a key that is not an importAuthKey one, an exchange
// that cannot be framed or any WebCrypto failure is a false.
export const verifyMac = async (
  key: CryptoKey,
  role: AuthRole,
  ex: AuthExchange,
  presented: Uint8Array
): Promise<boolean> => {
  if (
    presented.length !== AUTH_MAC_BYTES ||
    !isAuthKey(key) ||
    !isFramable(ex)
  ) {
    return false;
  }
  try {
    const t = buildTranscript(role, ex);
    return await crypto.subtle.verify(
      'HMAC',
      key,
      new Uint8Array(presented),
      t
    );
  } catch {
    return false;
  }
};
