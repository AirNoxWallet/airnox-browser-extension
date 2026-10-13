// Base58 (Bitcoin / Solana alphabet) decode. The Wallet-Standard adapter needs
// it to turn a desktop-returned Solana address (base58 of the 32-byte ed25519
// public key) into the `WalletAccount.publicKey` Uint8Array. In-tree (no npm
// dependency — mirrors the custom Emitter), ~30 lines, KAT-covered.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Reverse lookup: char code → digit value (-1 for a non-alphabet char).
const LOOKUP: Int8Array = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) {
    t[ALPHABET.charCodeAt(i)] = i;
  }
  return t;
})();

// Decode a base58 string to its bytes. Throws on any non-alphabet character.
// Leading '1's map to leading zero bytes (the base58 leading-zero convention).
export function base58Decode(input: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    const value = code < 128 ? LOOKUP[code] : -1;
    if (value < 0) {
      throw new Error(`invalid base58 character: '${input[i]}'`);
    }
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Each leading '1' is a leading zero byte.
  for (let i = 0; i < input.length && input[i] === '1'; i++) {
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}
