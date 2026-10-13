import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HoldersProbe, ProbeTimer } from '../src/content/holders_probe';
import { HolderReport } from '../src/protocol/bridge';

const REPORT: HolderReport = {
  ethereum: 'other',
  tronWeb: 'airnox',
  tronLink: 'airnox',
  tron: 'airnox',
  airnox: 'airnox',
};

function harness(): {
  probe: HoldersProbe;
  posts: () => number;
  fire: () => void;
  pending: () => number;
} {
  let posts = 0;
  const timers = new Map<number, () => void>();
  let next = 0;
  const timer: ProbeTimer = {
    set: (cb) => {
      next += 1;
      timers.set(next, cb);
      return next;
    },
    clear: (handle) => {
      timers.delete(handle as number);
    },
  };
  const probe = new HoldersProbe(() => (posts += 1), timer, 500);
  return {
    probe,
    posts: () => posts,
    fire: () => {
      const all = [...timers.values()];
      timers.clear();
      for (const cb of all) {
        cb();
      }
    },
    pending: () => timers.size,
  };
}

test('a question probes the page once and resolves with its answer', async () => {
  const h = harness();
  const asked = h.probe.ask();
  assert.equal(h.posts(), 1);
  h.probe.deliver(REPORT);
  assert.deepEqual(await asked, REPORT);
  assert.equal(h.pending(), 0, 'the timeout is cleared by the answer');
});

test('a page that does not answer in time gives no report', async () => {
  const h = harness();
  const asked = h.probe.ask();
  h.fire();
  assert.equal(await asked, undefined);
});

test('two questions in flight share one probe and one answer', async () => {
  const h = harness();
  const a = h.probe.ask();
  const b = h.probe.ask();
  assert.equal(h.posts(), 1);
  h.probe.deliver(REPORT);
  assert.deepEqual(await a, REPORT);
  assert.deepEqual(await b, REPORT);
});

test('an answer nobody asked for is dropped, and the next question probes afresh', async () => {
  const h = harness();
  h.probe.deliver(REPORT);
  const asked = h.probe.ask();
  assert.equal(h.posts(), 1, 'the next question still probes the page');
  h.fire();
  assert.equal(await asked, undefined, 'the stale answer was not kept');
});

test('an answer after the timeout settles nothing and the next question probes again', async () => {
  const h = harness();
  const first = h.probe.ask();
  h.fire();
  assert.equal(await first, undefined);
  h.probe.deliver(REPORT);
  const second = h.probe.ask();
  assert.equal(h.posts(), 2);
  h.probe.deliver({ ...REPORT, ethereum: 'airnox' });
  assert.equal((await second)?.ethereum, 'airnox');
});
