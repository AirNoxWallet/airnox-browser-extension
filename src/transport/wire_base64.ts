// The wire's byte strings: standard base64 with padding, both ways. A decoded
// string must re-encode to itself: the forgiving decoder would otherwise take a
// missing pad or embedded white space, and the wire allows exactly one spelling
// of each byte string. Pure.

export const toBase64 = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...Array.from(b)));

// The `n` bytes `s` spells, or undefined for anything else: not a string, not
// base64, not canonical, or another length.
export const fromBase64 = (s: unknown, n: number): Uint8Array | undefined => {
  if (typeof s !== 'string') {
    return undefined;
  }
  let bin: string;
  try {
    bin = atob(s);
  } catch {
    return undefined;
  }
  const out = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return out.length === n && toBase64(out) === s ? out : undefined;
};
