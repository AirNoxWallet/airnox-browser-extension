import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEB3_PROTOCOL_VERSION,
  isEvent,
  isResponse,
} from '../src/protocol/envelope';

// The two guards on what the desktop sends. Only the desktop writes these frames,
// but a listener squatting on a loopback port can write anything, so a frame
// passes only when every field the extension reads has the type it reads it as.

const RESPONSE = {
  v: WEB3_PROTOCOL_VERSION,
  iid: 'iid',
  rid: 'rid-1',
  ok: false,
  error: { code: 4001, message: 'no' },
};

const EVENT = {
  v: WEB3_PROTOCOL_VERSION,
  iid: 'iid',
  ns: 'evm',
  origin: 'https://a.example',
  chain: 'nt:evm:ci:1',
  event: 'accountsChanged',
  data: ['0x1'],
};

test('isResponse accepts a string rid and a boolean ok', () => {
  assert.equal(isResponse(RESPONSE), true);
  assert.equal(isResponse({ ...RESPONSE, ok: true, result: 1 }), true);
  assert.equal(isResponse({ ...RESPONSE, rid: '' }), true);
});

test('isResponse refuses a non-string rid or a non-boolean ok', () => {
  for (const rid of [1, null, undefined, ['rid-1']]) {
    assert.equal(isResponse({ ...RESPONSE, rid }), false, String(rid));
  }
  for (const ok of ['false', 'true', 0, 1, null, undefined]) {
    assert.equal(isResponse({ ...RESPONSE, ok }), false, String(ok));
  }
  assert.equal(isResponse(null), false);
  assert.equal(isResponse('rid'), false);
});

test('isEvent accepts a known namespace, a string event, and string origin / chain when present', () => {
  assert.equal(isEvent(EVENT), true);
  for (const ns of ['sys', 'evm', 'wstd', 'tonconnect', 'tron']) {
    assert.equal(isEvent({ ...EVENT, ns }), true, ns);
  }
  assert.equal(
    isEvent({ ...EVENT, origin: undefined, chain: undefined }),
    true
  );
});

test('isEvent refuses an unknown namespace, a non-string event, origin or chain, and any rid', () => {
  for (const ns of ['eth', '', 1, undefined]) {
    assert.equal(isEvent({ ...EVENT, ns }), false, String(ns));
  }
  for (const event of [1, null, undefined]) {
    assert.equal(isEvent({ ...EVENT, event }), false, String(event));
  }
  for (const origin of [1, null, { href: 'https://a.example' }]) {
    assert.equal(isEvent({ ...EVENT, origin }), false, JSON.stringify(origin));
  }
  for (const chain of [1, null, ['nt:evm:ci:1']]) {
    assert.equal(isEvent({ ...EVENT, chain }), false, String(chain));
  }
  assert.equal(isEvent({ ...EVENT, rid: 'rid-1' }), false);
  assert.equal(isEvent(null), false);
});
