import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRgbaPng } from './png_reader';

// The Chrome Web Store's listing icon is a 128 x 128 PNG whose artwork fills
// the central 96 x 96, with 16 px of transparent padding on every side
// (https://developer.chrome.com/docs/webstore/images). The package's own
// icons/icon-128.png is full bleed, so the store icon is a file of its own: the
// 96 px icon (the metal mark, the same pixels the package ships) on a
// transparent 128 px canvas. It is uploaded in the dashboard, not packaged.

const ROOT = join(__dirname, '..');
const STORE_ICON = 'store/chrome-web-store-icon-128.png';
const PAD = 16;

test('the store icon decodes as a 128 x 128 RGBA PNG', () => {
  const icon = readRgbaPng(readFileSync(join(ROOT, STORE_ICON)));
  assert.equal(icon.width, 128);
  assert.equal(icon.height, 128);
});

test('the store icon keeps 16 px of transparent padding on every side', () => {
  const icon = readRgbaPng(readFileSync(join(ROOT, STORE_ICON)));
  const opaque: string[] = [];
  for (let y = 0; y < icon.height; y++) {
    for (let x = 0; x < icon.width; x++) {
      const inside =
        x >= PAD && x < icon.width - PAD && y >= PAD && y < icon.height - PAD;
      if (!inside && icon.pixels[(y * icon.width + x) * 4 + 3] !== 0) {
        opaque.push(`${x},${y}`);
      }
    }
  }
  assert.deepEqual(opaque.slice(0, 8), []);
});

test('the store icon artwork is the packaged 96 px icon, pixel for pixel', () => {
  const icon = readRgbaPng(readFileSync(join(ROOT, STORE_ICON)));
  const mark = readRgbaPng(readFileSync(join(ROOT, 'icons', 'icon-96.png')));
  assert.equal(mark.width, 96);
  assert.equal(mark.height, 96);
  for (let y = 0; y < 96; y++) {
    const row = icon.pixels.subarray(
      ((y + PAD) * icon.width + PAD) * 4,
      ((y + PAD) * icon.width + PAD + 96) * 4
    );
    const want = mark.pixels.subarray(y * 96 * 4, (y + 1) * 96 * 4);
    assert.ok(row.equals(want), `row ${y}`);
  }
  // The artwork reaches the edges of its box: the padding is exactly 16 px.
  const alpha = (x: number, y: number) =>
    icon.pixels[(y * icon.width + x) * 4 + 3];
  let edge = 0;
  for (let i = PAD; i < 128 - PAD; i++) {
    edge = Math.max(edge, alpha(PAD, i), alpha(127 - PAD, i), alpha(i, PAD));
  }
  assert.ok(edge > 0, 'the mark touches its 96 px box');
});

test('the package icon-128 stays the full-bleed manifest icon', () => {
  const icon = readRgbaPng(readFileSync(join(ROOT, 'icons', 'icon-128.png')));
  assert.equal(icon.width, 128);
  assert.notEqual(icon.pixels[(64 * 128 + 2) * 4 + 3], 0);
});
