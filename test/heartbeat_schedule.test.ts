import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PING_PERIOD_MAX_MINUTES,
  PING_PERIOD_MIN_MINUTES,
  nextPingPeriodMinutes,
} from '../src/transport/heartbeat_schedule';

test('a desktop that answers restores the fast cadence from any back-off', () => {
  for (const current of [1, 2, 4, 8, undefined]) {
    assert.equal(nextPingPeriodMinutes(current, true), PING_PERIOD_MIN_MINUTES);
  }
});

test('an absent desktop backs the heartbeat off geometrically, then holds', () => {
  // Each failed tick doubles the period, so an idle browser stops opening (and
  // losing) a socket per candidate port every single minute.
  let period = PING_PERIOD_MIN_MINUTES;
  const seen: number[] = [];
  for (let tick = 0; tick < 6; tick++) {
    period = nextPingPeriodMinutes(period, false);
    seen.push(period);
  }
  assert.deepEqual(seen, [2, 4, 8, 8, 8, 8]);
  assert.equal(seen[seen.length - 1], PING_PERIOD_MAX_MINUTES);
});

test('a missing or nonsensical alarm period restarts the escalation, never stalls it', () => {
  // The alarm is the escalation state; if it is gone we must fall back to the
  // fast end of the scale, not to a period that would leave the badge stale.
  for (const bogus of [
    undefined,
    0,
    -5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.equal(nextPingPeriodMinutes(bogus, false), 2);
  }
});
