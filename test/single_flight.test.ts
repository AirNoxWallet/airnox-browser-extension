import { test } from 'node:test';
import assert from 'node:assert/strict';
import { singleFlight } from '../src/transport/single_flight';

// The regression under test is the instance-id race the e2e caught: two callers
// arriving in the same tick each minted a UUID, so the WsClient's socket and the
// router's frames carried different ids and the desktop refused every first
// connect with MalformedRequest (1100). These assert the property that prevents
// it — concurrent callers share ONE factory run — not the iid module itself,
// which is a browser shell (storage.local) and deliberately not mocked.

// The shape that was wrong: guard checked before the await, assigned after it.
// Kept here so the test proves the fix differs from the bug rather than just
// asserting the fix agrees with itself.
function checkThenAwaitCache<T>(factory: () => Promise<T>): () => Promise<T> {
  let cached: T | null = null;
  return async () => {
    if (cached === null) {
      cached = await factory();
    }
    return cached;
  };
}

const counter = () => {
  let calls = 0;
  return {
    calls: () => calls,
    factory: async () => {
      calls += 1;
      // Bind this run's value BEFORE yielding: reading the shared counter after
      // the await would hand every concurrent run the same string and hide the
      // very divergence these tests exist to detect.
      const mine = `value-${calls}`;
      // Yield, so a second caller can interleave exactly as it does in the
      // service worker's cold-start fan-out.
      await Promise.resolve();
      return mine;
    },
  };
};

test('concurrent callers share one factory run and one value', async () => {
  const c = counter();
  const get = singleFlight(c.factory).get;

  const [a, b, d] = await Promise.all([get(), get(), get()]);

  assert.equal(c.calls(), 1, 'the factory must run exactly once');
  assert.equal(a, 'value-1');
  assert.equal(b, 'value-1');
  assert.equal(d, 'value-1');
});

test('the check-then-await cache it replaces really does run twice', async () => {
  const c = counter();
  const get = checkThenAwaitCache(c.factory);

  const [a, b] = await Promise.all([get(), get()]);

  // The bug, pinned: two runs, two different values. If this ever passes with
  // one call, the race stopped being reachable and the guard above is moot.
  assert.equal(c.calls(), 2);
  assert.notEqual(a, b);
});

test('a later call reuses the resolved value without re-running', async () => {
  const c = counter();
  const get = singleFlight(c.factory).get;

  assert.equal(await get(), 'value-1');
  assert.equal(await get(), 'value-1');
  assert.equal(c.calls(), 1);
});

test('reset() builds a fresh value, and only after the reset', async () => {
  const c = counter();
  const flight = singleFlight(c.factory);

  assert.equal(await flight.get(), 'value-1');
  assert.equal(await flight.get(), 'value-1');

  // The transport settings changed: the cached client is built from the old
  // port and must not be handed out again.
  flight.reset();

  assert.equal(await flight.get(), 'value-2');
  assert.equal(c.calls(), 2);
});

test('reset() during an in-flight call does not disturb the caller waiting on it', async () => {
  const c = counter();
  const flight = singleFlight(c.factory);

  const pending = flight.get();
  flight.reset();

  // The in-flight caller keeps the promise it was given — a reset redirects the
  // NEXT call, it never retracts one already made.
  assert.equal(await pending, 'value-1');
  assert.equal(await flight.get(), 'value-2');
});

test('a rejection is not cached, so a transient failure is recoverable', async () => {
  let calls = 0;
  const get = singleFlight(async () => {
    calls += 1;
    // Yield first, as a real storage read does — the failure must be caught on
    // the async path, not synchronously inside get().
    await Promise.resolve();
    if (calls === 1) {
      throw new Error('storage unavailable');
    }
    return 'recovered';
  }).get;

  await assert.rejects(get(), /storage unavailable/);
  // A cached rejection would break every later call for the life of the worker.
  assert.equal(await get(), 'recovered');
  assert.equal(calls, 2);
});

test('concurrent callers all see the same rejection', async () => {
  let calls = 0;
  const get = singleFlight(async () => {
    calls += 1;
    await Promise.resolve();
    throw new Error('boom');
  }).get;

  const results = await Promise.allSettled([get(), get()]);

  assert.equal(calls, 1);
  assert.deepEqual(
    results.map((r) => r.status),
    ['rejected', 'rejected']
  );
});
