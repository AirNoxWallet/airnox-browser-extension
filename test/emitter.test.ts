import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from '../src/inpage/emitter';

test('on + emit delivers args to every listener', () => {
  const e = new Emitter();
  const seen: unknown[] = [];
  e.on('x', (a) => seen.push(a));
  e.on('x', (a) => seen.push(a));
  assert.equal(e.emit('x', 42), true);
  assert.deepEqual(seen, [42, 42]);
});

test('emit on an event with no listeners returns false', () => {
  const e = new Emitter();
  assert.equal(e.emit('nobody'), false);
});

test('once fires exactly once then auto-removes', () => {
  const e = new Emitter();
  let count = 0;
  e.once('x', () => count++);
  e.emit('x');
  e.emit('x');
  e.emit('x');
  assert.equal(count, 1);
});

test('once passes the emitted args', () => {
  const e = new Emitter();
  let got: unknown;
  e.once('x', (a) => (got = a));
  e.emit('x', 'hello');
  assert.equal(got, 'hello');
});

test('a once listener removed before it fires never fires', () => {
  const e = new Emitter();
  let count = 0;
  const fn = (): void => {
    count++;
  };
  e.once('x', fn);
  // remove by the ORIGINAL reference (the dApp never sees the wrapper)
  e.removeListener('x', fn);
  e.emit('x');
  assert.equal(count, 0);
});

test('off is an alias for removeListener and removes a once listener too', () => {
  const e = new Emitter();
  let onCount = 0;
  let onceCount = 0;
  const onFn = (): void => {
    onCount++;
  };
  const onceFn = (): void => {
    onceCount++;
  };
  e.on('x', onFn);
  e.once('x', onceFn);
  e.off('x', onFn);
  e.off('x', onceFn);
  e.emit('x');
  assert.equal(onCount, 0);
  assert.equal(onceCount, 0);
});

test('removeListener only drops the named listener, others stay', () => {
  const e = new Emitter();
  let a = 0;
  let b = 0;
  const fa = (): void => {
    a++;
  };
  const fb = (): void => {
    b++;
  };
  e.on('x', fa);
  e.on('x', fb);
  e.removeListener('x', fa);
  e.emit('x');
  assert.equal(a, 0);
  assert.equal(b, 1);
});

test('a throwing listener does not break the emit loop', () => {
  const e = new Emitter();
  let reached = false;
  e.on('x', () => {
    throw new Error('boom');
  });
  e.on('x', () => {
    reached = true;
  });
  assert.equal(e.emit('x'), true);
  assert.equal(reached, true);
});

test('on / once / removeListener / off are chainable', () => {
  const e = new Emitter();
  const noop = (): void => undefined;
  assert.equal(
    e.on('a', noop).once('b', noop).removeListener('a', noop).off('b', noop),
    e
  );
});
