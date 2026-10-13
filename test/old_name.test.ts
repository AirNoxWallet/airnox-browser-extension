import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// The project is AirNox: this extension is "AirNox", the desktop application it
// serves is "AirNox Wallet". An old name that comes back by habit -- a storage
// key, a message type, a class copied from an old branch -- reads correctly in
// review, so every tracked text file is searched for it, ignoring case. This
// file names the old name to find it, so it is the one file not searched.
const SELF = 'test/old_name.test.ts';

test('no old project name in any tracked text file', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((f) => f !== '' && f !== SELF);
  const hits: string[] = [];
  for (const file of files) {
    const bytes = readFileSync(file);
    if (bytes.includes(0)) {
      continue; // a binary file (an icon, a font)
    }
    bytes
      .toString('utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/soika/i.test(line)) {
          hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
        }
      });
  }
  assert.deepEqual(hits, []);
});
