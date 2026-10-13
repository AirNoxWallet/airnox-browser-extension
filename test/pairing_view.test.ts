import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PAIRING_FAILURES } from '../src/transport/pairing_flow';
import { derivePairingView, readOriginHint } from '../src/popup/pairing_view';
import { pairingRow } from '../src/popup/popup_view';
import { PAIRING_PAGE, pairingPagePath } from '../src/protocol/bridge';

test('every failure says what happened and offers Try again, never the code field', () => {
  for (const failure of PAIRING_FAILURES) {
    const view = derivePairingView({ kind: 'failed', failure });
    assert.ok(view.title.length > 0, failure);
    assert.ok(view.detail.length > 0, failure);
    assert.equal(view.tryAgain, true, failure);
    assert.equal(view.codeEntry, false, failure);
    assert.equal(view.busy, false, failure);
    assert.notEqual(view.tone, 'ok', failure);
  }
});

test('a refused code shows the desktop’s own words', () => {
  const view = derivePairingView({
    kind: 'failed',
    failure: 'refused',
    message: 'the code did not match',
  });
  assert.match(view.detail, /^The code did not match\./);
});

test('an unverified desktop confirmation reads as a possible interception, not a typo', () => {
  const view = derivePairingView({ kind: 'failed', failure: 'interception' });
  assert.equal(view.tone, 'error');
  assert.match(`${view.title} ${view.detail}`, /another program/i);
  assert.doesNotMatch(`${view.title} ${view.detail}`, /typo/i);
});

test('a typo keeps the code field and names its cause; nothing went to the desktop', () => {
  for (const reason of ['character', 'length', 'check'] as const) {
    const view = derivePairingView({ kind: 'bad-code', reason });
    assert.equal(view.codeEntry, true, reason);
    assert.equal(view.tryAgain, false, reason);
    assert.ok(view.detail.length > 0, reason);
  }
  assert.notEqual(
    derivePairingView({ kind: 'bad-code', reason: 'check' }).detail,
    derivePairingView({ kind: 'bad-code', reason: 'length' }).detail
  );
});

test('the steps: asking, entering, checking, paired', () => {
  const starting = derivePairingView({ kind: 'starting' });
  assert.equal(starting.busy, true);
  assert.equal(starting.codeEntry, false);
  const enter = derivePairingView({ kind: 'enter-code' });
  assert.equal(enter.codeEntry, true);
  assert.equal(enter.busy, false);
  assert.match(enter.detail, /only here/);
  const checking = derivePairingView({ kind: 'checking' });
  assert.equal(checking.busy, true);
  assert.equal(checking.codeEntry, true);
  const paired = derivePairingView({ kind: 'paired' });
  assert.equal(paired.tone, 'ok');
  assert.equal(paired.close, true);
  assert.equal(paired.tryAgain, false);
  assert.equal(paired.codeEntry, false);
});

test('the origin hint is taken only as a bare web origin', () => {
  assert.equal(
    readOriginHint('?origin=https%3A%2F%2Fapp.example'),
    'https://app.example'
  );
  assert.equal(readOriginHint(''), undefined);
  assert.equal(readOriginHint('?origin='), undefined);
  assert.equal(
    readOriginHint('?origin=https%3A%2F%2Fapp.example%2Fpath'),
    undefined
  );
  assert.equal(readOriginHint('?origin=javascript%3Aalert(1)'), undefined);
  assert.equal(readOriginHint('?origin=not%20a%20url'), undefined);
});

test('the popup’s pairing row: unknown, not paired, paired', () => {
  assert.deepEqual(pairingRow(undefined), {
    value: '—',
    action: 'Pair',
    detail: '',
  });
  assert.deepEqual(pairingRow(false), {
    value: 'Not paired',
    action: 'Pair',
    detail: '',
  });
  assert.deepEqual(pairingRow(true), {
    value: 'Paired',
    action: 'Pair again',
    detail: '',
  });
});

test('the popup’s pairing row for a withheld key says so, and where to reset it', () => {
  const row = pairingRow(true, true);
  assert.equal(row.value, 'Key withheld');
  assert.equal(row.action, 'Pair again');
  assert.match(row.detail, /could not prove it is AirNox Wallet/);
  assert.match(row.detail, /Reset .*pairing key in AirNox Wallet's Settings/);
  // Only a held key can be withheld.
  assert.equal(pairingRow(false, true).value, 'Not paired');
  assert.equal(pairingRow(undefined, true).value, '—');
});

test('the page opens waiting for the person: Pair asks the desktop for a code, nothing before it', () => {
  const ready = derivePairingView({
    kind: 'ready',
    origin: 'https://app.example',
  });
  assert.equal(ready.start, true);
  assert.equal(ready.busy, false);
  assert.equal(ready.codeEntry, false);
  assert.equal(ready.tryAgain, false);
  assert.match(ready.detail, /^https:\/\/app\.example asked to connect/);
  assert.match(ready.detail, /Press Pair/);
  const bare = derivePairingView({ kind: 'ready' });
  assert.equal(bare.start, true);
  assert.doesNotMatch(bare.detail, /asked to connect/);
  for (const step of [
    { kind: 'starting' },
    { kind: 'enter-code' },
    { kind: 'checking' },
    { kind: 'paired' },
    { kind: 'failed', failure: 'refused' },
  ] as const) {
    assert.equal(derivePairingView(step).start, false, step.kind);
  }
});

test('the page the worker opens for a dApp names it, and the page reads back the same origin', () => {
  for (const origin of [
    'https://app.example',
    'http://127.0.0.1:5173',
    'https://xn--80ak6aa92e.com',
  ]) {
    const path = pairingPagePath(origin);
    assert.ok(path.startsWith(`${PAIRING_PAGE}?`), path);
    const url = new URL(`chrome-extension://abc/${path}`);
    assert.equal(readOriginHint(url.search), origin);
  }
  assert.equal(pairingPagePath(), PAIRING_PAGE);
  assert.equal(pairingPagePath(''), PAIRING_PAGE);
  // A value that is not an origin is not passed on as one.
  const odd = new URL(
    `chrome-extension://abc/${pairingPagePath('https://a.example/path&x=1')}`
  );
  assert.equal(readOriginHint(odd.search), undefined);
});
