import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTENT_TO_PAGE,
  PAGE_TO_CONTENT,
  PROVIDER_GLOBALS,
  isHolderProbe,
  parseHolderReport,
} from '../src/protocol/bridge';

const GOOD = {
  ethereum: 'other',
  tronWeb: 'airnox',
  tronLink: 'airnox',
  tron: 'none',
  airnox: 'airnox',
};

test('a holder report naming every global with a known holder is accepted', () => {
  assert.deepEqual(parseHolderReport(GOOD), GOOD);
  for (const holder of ['airnox', 'other', 'none']) {
    const all = Object.fromEntries(PROVIDER_GLOBALS.map((k) => [k, holder]));
    assert.deepEqual(parseHolderReport(all), all, holder);
  }
});

test('the accepted report is a copy, not the page object', () => {
  const page = { ...GOOD };
  const out = parseHolderReport(page);
  page.ethereum = 'airnox';
  assert.equal(out?.ethereum, 'other');
});

test('a malformed holder report is refused', () => {
  const bad: unknown[] = [
    undefined,
    null,
    'other',
    42,
    [],
    Object.values(GOOD),
    { ...GOOD, ethereum: 'metamask' },
    { ...GOOD, ethereum: undefined },
    { ...GOOD, tron: 1 },
    { ...GOOD, solana: 'other' },
  ];
  const missing: Record<string, unknown> = { ...GOOD };
  delete missing.airnox;
  bad.push(missing);
  for (const report of bad) {
    assert.equal(parseHolderReport(report), undefined, JSON.stringify(report));
  }
});

test('a holder report with an inherited key is refused', () => {
  const report = Object.create({ ethereum: 'other' }) as Record<string, string>;
  for (const key of PROVIDER_GLOBALS.filter((k) => k !== 'ethereum')) {
    report[key] = 'airnox';
  }
  assert.equal(parseHolderReport(report), undefined);
  // ...also when an extra own key makes the count right.
  report.solana = 'airnox';
  assert.equal(parseHolderReport(report), undefined);
});

test('a holder probe is recognised only on the content-to-page channel', () => {
  assert.equal(
    isHolderProbe({ channel: CONTENT_TO_PAGE, probe: 'holders' }),
    true
  );
  assert.equal(
    isHolderProbe({ channel: PAGE_TO_CONTENT, probe: 'holders' }),
    false
  );
  assert.equal(
    isHolderProbe({ channel: CONTENT_TO_PAGE, probe: 'other' }),
    false
  );
  assert.equal(isHolderProbe({ channel: CONTENT_TO_PAGE }), false);
  assert.equal(isHolderProbe(undefined), false);
  assert.equal(isHolderProbe('holders'), false);
});
