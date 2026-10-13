import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTouchReporter } from '../src/inpage/activity';

test('a page is reported ONCE however often it touches a provider', () => {
  let sent = 0;
  const report = createTouchReporter(() => (sent += 1));
  for (let i = 0; i < 100; i++) {
    report(); // e.g. a dApp reading window.ethereum on every render
  }
  assert.equal(sent, 1);
});

test('a throwing sink does not re-arm the reporter', () => {
  // The extension context can be gone (reloaded / updated) when the page posts.
  // If the latch were set after the sink, every later property read would throw
  // again — inside the dApp's own getter call, on its stack.
  let calls = 0;
  const report = createTouchReporter(() => {
    calls += 1;
    throw new Error('extension context invalidated');
  });
  assert.throws(() => report());
  report();
  report();
  assert.equal(calls, 1);
});
