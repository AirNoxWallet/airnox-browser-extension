// Wire encodings shared by the Solana + Sui Wallet-Standard adapters. The desktop
// contract: a message / transaction rides the wire as `0x`-hex, and a signature /
// signed transaction comes back as standard padded base64. The Sui connect reply
// additionally carries a raw public key as bare lowercase hex — hexDecode turns it back into bytes.

// Uint8Array → "0x"-prefixed lowercase hex (the form the desktop decodes).
export function bytesToHex0x(bytes: Uint8Array): string {
  let hex = '0x';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

// Standard (padded) base64 → bytes. atob handles the desktop's base64 output
// (A–Z a–z 0–9 + / with '=' padding). Throws on a non-base64 input.
export function base64Decode(s: string): Uint8Array {
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

// bytes → standard (padded) base64 — the form a serialized transaction rides the
// wire as (the desktop parses standard base64).
export function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Hex string → bytes. Accepts an optional `0x` prefix (the host's address form)
// or a bare hex body (the desktop's public-key form). Throws on an
// odd-length or non-hex input — never a silently truncated / mis-parsed key.
export function hexDecode(hex: string): Uint8Array {
  const body =
    hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (body.length % 2 !== 0) {
    throw new Error('hexDecode: odd-length hex string');
  }
  if (!/^[0-9a-fA-F]*$/.test(body)) {
    throw new Error('hexDecode: non-hex character');
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
