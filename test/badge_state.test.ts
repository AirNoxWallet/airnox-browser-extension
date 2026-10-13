import { test } from 'node:test';
import assert from 'node:assert/strict';

import { badgeFace, sameFace, IDLE_TITLE } from '../src/background/badge_state';

test('every desktop state a web3 tab can be in has a NON-EMPTY badge', () => {
  // Load-bearing, not cosmetic: badge.ts reads the badge back to learn which
  // tabs asked for web3 after a service-worker eviction, so an empty text on a
  // web3 tab would make that tab look like an idle one and lose it.
  const faces = [
    badgeFace(false),
    badgeFace(true, 'unlocked'),
    badgeFace(true, 'locked'),
    badgeFace(true, 'unlocked', true),
  ];
  for (const face of faces) {
    assert.notEqual(face.text, '');
    assert.match(face.color, /^#[0-9a-f]{6}$/);
    assert.notEqual(face.title, IDLE_TITLE); // the tooltip always says WHY
  }
});

test('an unreachable desktop is grey, not blank', () => {
  const offline = badgeFace(false);
  assert.equal(offline.color, '#6b7280');
  assert.match(offline.title, /not running/);
  // Distinct from every reachable state.
  for (const live of [
    badgeFace(true, 'unlocked'),
    badgeFace(true, 'locked'),
    badgeFace(true, 'unlocked', true),
  ]) {
    assert.equal(sameFace(offline, live), false);
  }
});

test('lock state and protocol incompatibility are told apart', () => {
  assert.equal(badgeFace(true, 'unlocked').color, '#16a34a');
  assert.equal(badgeFace(true, 'locked').color, '#d97706');
  // Reachable but unusable must never wear the green "ready" dot.
  const stale = badgeFace(true, 'unlocked', true);
  assert.equal(stale.color, '#dc2626');
  assert.equal(stale.text, '!');
});

test('sameFace compares what is painted, so an unchanged status repaints nothing', () => {
  assert.equal(
    sameFace(badgeFace(true, 'locked'), badgeFace(true, 'locked')),
    true
  );
  assert.equal(
    sameFace(badgeFace(true, 'locked'), badgeFace(true, 'unlocked')),
    false
  );
});
