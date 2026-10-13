// The one-time code that pairs this extension with the desktop app: the desktop
// shows it, the person types it here, and both sides mix it into the pairing's
// key schedule (pair_handshake.ts). 16 characters of Crockford's base32
// alphabet: 15 carry 75 random bits, the 16th is a check character, the top
// 5 bits of SHA-256("airnox-web3-pair-check-v1" | the 15). The check catches a
// typo (31 in 32) here, before anything is sent, so a typo never spends the
// desktop's one attempt per code nor reads there as an attack.
//
// What a person types is read as the desktop reads it: case-insensitively,
// I and L as 1, O as 0, with spaces and hyphens dropped wherever they stand;
// any other character is refused. Both sides are checked against one
// known-answer file.
//
// Pure: no I/O, no state. The code is a secret while it lives; nothing here
// keeps or logs it.

export const PAIR_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIR_CODE_CHARS = 16;
export const PAIR_CODE_CHECK_LABEL = 'airnox-web3-pair-check-v1';

const BODY_CHARS = PAIR_CODE_CHARS - 1;

// Why a typed code was refused. A character outside the alphabet and its
// readings wins over a wrong length, and a wrong length over a wrong check
// character: the order the desktop reports them in.
export type CodeVerdict = 'ok' | 'character' | 'length' | 'check';

// The canonical code (16 upper-case alphabet characters) when the verdict is
// 'ok'; no code otherwise.
export type ParsedCode =
  | { verdict: 'ok'; code: string }
  | { verdict: Exclude<CodeVerdict, 'ok'> };

// The alphabet character a typed character stands for, or undefined. ASCII
// only: a full-width digit or an accented letter is not read as its plain twin.
const canonicalSymbol = (t: string): string | undefined => {
  const up = t >= 'a' && t <= 'z' ? t.toUpperCase() : t;
  const read = up === 'I' || up === 'L' ? '1' : up === 'O' ? '0' : up;
  return PAIR_CODE_ALPHABET.includes(read) && read.length === 1
    ? read
    : undefined;
};

// The check character of a 15-character body: the alphabet's character at the
// top 5 bits of SHA-256(check label | body). Rejects with a RangeError on a
// body of another length.
export const checkCharacter = async (body: string): Promise<string> => {
  if (body.length !== BODY_CHARS) {
    throw new RangeError('pair code: the body is 15 characters');
  }
  const bytes = new TextEncoder().encode(PAIR_CODE_CHECK_LABEL + body);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return PAIR_CODE_ALPHABET[digest[0] >> 3];
};

// Read what a person typed. Never rejects.
export const parseCode = async (typed: string): Promise<ParsedCode> => {
  let code = '';
  for (const t of typed) {
    if (t === ' ' || t === '-') {
      continue;
    }
    const c = canonicalSymbol(t);
    if (c === undefined) {
      return { verdict: 'character' };
    }
    code += c;
  }
  if (code.length !== PAIR_CODE_CHARS) {
    return { verdict: 'length' };
  }
  if ((await checkCharacter(code.slice(0, BODY_CHARS))) !== code[BODY_CHARS]) {
    return { verdict: 'check' };
  }
  return { verdict: 'ok', code };
};

// True iff `code` is 16 alphabet characters (upper case, no separators) whose
// last is the check character of the rest.
export const isCanonicalCode = async (code: string): Promise<boolean> =>
  code.length === PAIR_CODE_CHARS &&
  [...code].every((c) => PAIR_CODE_ALPHABET.includes(c)) &&
  (await checkCharacter(code.slice(0, BODY_CHARS))) === code[BODY_CHARS];
