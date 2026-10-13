import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IntervalId, SwKeepalive } from '../src/transport/sw_keepalive';

// A fake interval clock: records start/clear and lets the test fire the tick.
class FakeClock {
  private cb: (() => void) | null = null;
  starts = 0;
  clears = 0;

  setInterval = (cb: () => void): IntervalId => {
    this.cb = cb;
    this.starts += 1;
    return this.starts as unknown as IntervalId;
  };
  clearInterval = (): void => {
    this.cb = null;
    this.clears += 1;
  };
  tick(): void {
    this.cb?.();
  }
}

test('SwKeepalive: begin starts the ticker, end stops it', () => {
  const clock = new FakeClock();
  let ticks = 0;
  const ka = new SwKeepalive(
    () => {
      ticks += 1;
    },
    20_000,
    clock.setInterval,
    clock.clearInterval
  );

  assert.equal(ka.running, false);
  ka.begin();
  assert.equal(ka.running, true);
  assert.equal(clock.starts, 1);

  // The ticker fires the injected tick (the WS keepalive ping).
  clock.tick();
  clock.tick();
  assert.equal(ticks, 2);

  ka.end();
  assert.equal(ka.running, false);
  assert.equal(clock.clears, 1);
});

test('SwKeepalive: reference-counted — runs until the LAST request settles', () => {
  const clock = new FakeClock();
  const ka = new SwKeepalive(
    () => undefined,
    20_000,
    clock.setInterval,
    clock.clearInterval
  );

  ka.begin(); // request A
  ka.begin(); // request B (concurrent)
  assert.equal(clock.starts, 1); // a single ticker for both
  assert.equal(ka.running, true);

  ka.end(); // A settles — B still outstanding
  assert.equal(ka.running, true);
  assert.equal(clock.clears, 0);

  ka.end(); // B settles — now idle
  assert.equal(ka.running, false);
  assert.equal(clock.clears, 1);
});

test('SwKeepalive: end() without a matching begin is a no-op (no underflow)', () => {
  const clock = new FakeClock();
  const ka = new SwKeepalive(
    () => undefined,
    20_000,
    clock.setInterval,
    clock.clearInterval
  );

  ka.end(); // never began
  assert.equal(ka.running, false);
  assert.equal(clock.clears, 0);

  // A later begin/end pair still balances correctly.
  ka.begin();
  assert.equal(ka.running, true);
  ka.end();
  assert.equal(ka.running, false);
  assert.equal(clock.starts, 1);
  assert.equal(clock.clears, 1);
});
