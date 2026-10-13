import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DesktopSessionWatch } from '../src/background/desktop_session';

// The SW's memory of the last desktop session (storage.session in production).
function memoryWatch(initial?: string): {
  watch: DesktopSessionWatch;
  saved: () => string | undefined;
  saves: () => number;
} {
  let stored = initial;
  let count = 0;
  const watch = new DesktopSessionWatch(
    () => Promise.resolve(stored),
    (s) => {
      stored = s;
      count += 1;
      return Promise.resolve();
    }
  );
  return { watch, saved: () => stored, saves: () => count };
}

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);

test('the first session ever seen is remembered and forgets nothing', async () => {
  // A fresh browser (or a fresh extension) has no stale page state to clear.
  const m = memoryWatch();
  assert.equal(await m.watch.observe(A), false);
  assert.equal(m.saved(), A);
});

test('the same session again is not a restart', async () => {
  const m = memoryWatch(A);
  assert.equal(await m.watch.observe(A), false);
  assert.equal(m.saves(), 0);
});

test('a different session is a restart, and becomes the one remembered', async () => {
  const m = memoryWatch(A);
  assert.equal(await m.watch.observe(B), true);
  assert.equal(m.saved(), B);
  assert.equal(await m.watch.observe(B), false); // told once
});

test('an unknown session (an older desktop) is never a restart and changes nothing', async () => {
  const m = memoryWatch(A);
  assert.equal(await m.watch.observe(undefined), false);
  assert.equal(m.saved(), A);
  assert.equal(m.saves(), 0);
});

test('two sightings of a new session at once report ONE restart', async () => {
  // The handshake of a new socket and the heartbeat can land together; the second
  // must read the session the first saved, or every page is told twice.
  const m = memoryWatch(A);
  const [first, second] = await Promise.all([
    m.watch.observe(B),
    m.watch.observe(B),
  ]);
  assert.deepEqual([first, second].sort(), [false, true]);
  assert.equal(m.saves(), 1);
});

test('a failing load does not wedge the watch', async () => {
  let fail = true;
  let stored: string | undefined = A;
  const watch = new DesktopSessionWatch(
    () =>
      fail
        ? Promise.reject(new Error('storage gone'))
        : Promise.resolve(stored),
    (s) => {
      stored = s;
      return Promise.resolve();
    }
  );
  await assert.rejects(() => watch.observe(B));
  fail = false;
  assert.equal(await watch.observe(B), true);
});
