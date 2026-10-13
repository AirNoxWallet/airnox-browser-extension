import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Web3Tabs } from '../src/background/web3_tabs';

test('marking is idempotent and reports only the transition', () => {
  const tabs = new Web3Tabs();
  // The caller paints on `true`, so a page that reads window.ethereum in a
  // render loop must not repaint the toolbar on every touch.
  assert.equal(tabs.mark(7), true);
  assert.equal(tabs.mark(7), false);
  assert.equal(tabs.size, 1);
  assert.deepEqual(tabs.all(), [7]);
});

test('a tab that navigates or closes stops being a web3 tab', () => {
  const tabs = new Web3Tabs();
  tabs.mark(1);
  tabs.mark(2);
  assert.equal(tabs.forget(1), true);
  assert.equal(tabs.forget(1), false); // already gone
  assert.equal(tabs.has(1), false);
  assert.equal(tabs.has(2), true);
  // A fresh document re-marks the same tab id from scratch.
  assert.equal(tabs.mark(1), true);
});

test('adopt MERGES a previous worker’s tabs, it does not replace this one’s', () => {
  const tabs = new Web3Tabs();
  tabs.mark(1); // marked by this worker, after the badge read was taken
  tabs.adopt([2, 3, 1]); // read back off the browser’s per-tab badges
  assert.deepEqual(
    tabs.all().sort((a, b) => a - b),
    [1, 2, 3]
  );
  assert.equal(tabs.size, 3);
});
