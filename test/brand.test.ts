import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AIRNOX_ICON_DATA_URI } from '../src/inpage/brand';

// What a dApp receives as EIP6963ProviderInfo.icon and Wallet Standard's
// Wallet.icon. Both take an RFC 2397 data URI; Wallet Standard's WalletIcon type
// narrows it to `data:image/${'svg+xml' | 'webp' | 'png' | 'gif'};base64,...`.
const PREFIX = 'data:image/svg+xml;base64,';

function decodedSvg(): string {
  return Buffer.from(
    AIRNOX_ICON_DATA_URI.slice(PREFIX.length),
    'base64'
  ).toString('utf8');
}

test('the brand icon is a base64 SVG data URI', () => {
  assert.ok(
    AIRNOX_ICON_DATA_URI.startsWith(PREFIX),
    AIRNOX_ICON_DATA_URI.slice(0, 40)
  );
  const payload = AIRNOX_ICON_DATA_URI.slice(PREFIX.length);
  // Canonical base64: decoding and re-encoding gives the same text, so no stray
  // character (a space, a line break from the literal's split) hides in it.
  assert.equal(Buffer.from(payload, 'base64').toString('base64'), payload);
});

test('the brand icon decodes to a 512 x 512 SVG document', () => {
  const svg = decodedSvg();
  assert.ok(svg.startsWith('<svg'), svg.slice(0, 40));
  assert.match(svg, /^<svg [^>]*viewBox="0 0 512 512"/);
  assert.ok(svg.endsWith('</svg>'), svg.slice(-40));
});

test('the brand icon is assets/airnox-icon-flat.svg without its title and formatting', () => {
  // The source of truth named in brand.ts: the inline copy must be that file with
  // only the <title> and the whitespace between tags dropped.
  const source = readFileSync(
    join(__dirname, '..', 'assets', 'airnox-icon-flat.svg'),
    'utf8'
  );
  const expected = source
    .replace(/<title>[\s\S]*?<\/title>/, '')
    .replace(/>\s+</g, '><')
    .trim();
  assert.equal(decodedSvg(), expected);
});
