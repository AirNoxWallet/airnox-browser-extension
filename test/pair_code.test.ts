import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  PAIR_CODE_ALPHABET,
  PAIR_CODE_CHARS,
  PAIR_CODE_CHECK_LABEL,
  checkCharacter,
  isCanonicalCode,
  parseCode,
} from '../src/transport/pair_code';

// The desktop app's known-answer file, copied unchanged: the extension reads a
// typed code exactly as the desktop does, or a code the desktop shows would be
// refused here (or a typo let through to void the attempt there).

interface CodeFile {
  alphabet: string;
  check_label: string;
  code_from_entropy: { name: string; code: string; grouped: string }[];
  code_accepts: { name: string; typed: string; code: string }[];
  code_rejects: { name: string; typed: string; reason: string }[];
  code_not_canonical: { name: string; text: string }[];
}

const KAT = JSON.parse(
  readFileSync(path.join(__dirname, 'testdata', 'pair_vectors.json'), 'utf8')
) as CodeFile;

test('the alphabet, the length and the check label are the desktop’s', () => {
  assert.equal(PAIR_CODE_ALPHABET, KAT.alphabet);
  assert.equal(PAIR_CODE_CHECK_LABEL, KAT.check_label);
  assert.equal(PAIR_CODE_CHARS, 16);
  assert.ok(KAT.code_accepts.length >= 6);
  assert.ok(KAT.code_rejects.length >= 11);
});

test('the check character of every drawn code is the desktop’s', async () => {
  for (const v of KAT.code_from_entropy) {
    assert.equal(await checkCharacter(v.code.slice(0, 15)), v.code[15], v.name);
    assert.equal(await isCanonicalCode(v.code), true, v.name);
    // What the desktop shows reads back as the code.
    assert.deepEqual(
      await parseCode(v.grouped),
      { verdict: 'ok', code: v.code },
      v.name
    );
  }
});

test('what a person types is read as the desktop reads it', async () => {
  for (const v of KAT.code_accepts) {
    assert.deepEqual(
      await parseCode(v.typed),
      { verdict: 'ok', code: v.code },
      v.name
    );
  }
});

test('a refused code names why, and carries no code', async () => {
  for (const v of KAT.code_rejects) {
    assert.deepEqual(await parseCode(v.typed), { verdict: v.reason }, v.name);
  }
});

test('only the canonical form is canonical', async () => {
  for (const v of KAT.code_not_canonical) {
    assert.equal(await isCanonicalCode(v.text), false, v.name);
  }
  assert.equal(await isCanonicalCode(''), false);
  assert.equal(await isCanonicalCode('5PCTFFMDQFZA5BRF0'), false);
});

test('the check character takes exactly 15 body characters', async () => {
  await assert.rejects(checkCharacter('5PCTFFMDQFZA5B'), RangeError);
  await assert.rejects(checkCharacter('5PCTFFMDQFZA5BRF'), RangeError);
});
