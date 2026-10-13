// A name for a pairing key that is not the key: what a record about the key
// (that a desktop's proof failed with it) is filed under, so the record names
// the one key it is about and a key a later pairing stores never matches it.
//
// The key is a non-extractable WebCrypto HMAC key, so its bytes cannot be
// hashed. The fingerprint is instead the key's own HMAC-SHA-256 (RFC 2104) over
// a fixed label, cut to 16 bytes, in hex. HMAC is a pseudorandom function: the
// value says nothing about the key, and nothing about the MAC of any other
// message. The label is 30 bytes and every socket handshake transcript is 81
// (auth_handshake.ts), so a fingerprint is never a proof the desktop would
// accept.
//
// Pure: no I/O, no state.

// The storage.local entry naming the fingerprint of the pairing key a
// desktop's proof failed: the worker writes it, the popup shows it.
export const DISTRUSTED_KEY_RECORD = 'airnox.distrustedKey';

const FINGERPRINT_LABEL = 'AirNox pairing key fingerprint';
export const FINGERPRINT_BYTES = 16;

export const keyFingerprint = async (key: CryptoKey): Promise<string> => {
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(FINGERPRINT_LABEL)
    )
  );
  return Array.from(mac.subarray(0, FINGERPRINT_BYTES), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
};

// Whether `value` reads as a fingerprint (a record from storage is untrusted
// in shape).
export const isKeyFingerprint = (value: unknown): value is string =>
  typeof value === 'string' &&
  new RegExp(`^[0-9a-f]{${2 * FINGERPRINT_BYTES}}$`).test(value);
