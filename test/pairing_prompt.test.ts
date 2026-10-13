import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAIRING_PROMPT_COOLDOWN_MS,
  PairingPromptGate,
  PromptRecord,
  readPromptRecord,
} from '../src/background/pairing_prompt';

const A = 'https://a.app';
const B = 'https://b.app';

// A gate over an in-memory record and a clock the test moves.
function gateAt(start = 1_000_000) {
  const state = { now: start, record: {} as PromptRecord, saves: 0 };
  const gate = new PairingPromptGate(
    {
      load: () => Promise.resolve(state.record),
      save: (r) => {
        state.record = r;
        state.saves += 1;
        return Promise.resolve();
      },
    },
    () => state.now
  );
  return { gate, state };
}

test('a dApp that connects again and again opens the window once per cooldown', async () => {
  const { gate, state } = gateAt();
  const opened: boolean[] = [];
  // One connect every ten seconds for the whole cooldown.
  for (let t = 0; t < PAIRING_PROMPT_COOLDOWN_MS; t += 10_000) {
    opened.push(await gate.admit(A));
    state.now += 10_000;
  }
  assert.equal(opened.filter(Boolean).length, 1);
  assert.equal(opened[0], true);
  // The cooldown has passed: the next connect may open it again.
  assert.equal(await gate.admit(A), true);
});

test('the cooldown is per origin', async () => {
  const { gate } = gateAt();
  assert.equal(await gate.admit(A), true);
  assert.equal(await gate.admit(B), true);
  assert.equal(await gate.admit(A), false);
  assert.equal(await gate.admit(B), false);
});

test('the window holds the origin for exactly the cooldown', async () => {
  const { gate, state } = gateAt();
  assert.equal(await gate.admit(A), true);
  state.now += PAIRING_PROMPT_COOLDOWN_MS - 1;
  assert.equal(await gate.admit(A), false);
  state.now += 1;
  assert.equal(await gate.admit(A), true);
});

test('closing the window unpaired starts the cooldown again from the close', async () => {
  const { gate, state } = gateAt();
  assert.equal(await gate.admit(A), true);
  state.now += PAIRING_PROMPT_COOLDOWN_MS - 1_000;
  await gate.declined(A);
  state.now += 2_000; // past the first cooldown, inside the new one
  assert.equal(await gate.admit(A), false);
  state.now += PAIRING_PROMPT_COOLDOWN_MS;
  assert.equal(await gate.admit(A), true);
});

test('a completed pairing lets every origin open the window again', async () => {
  const { gate } = gateAt();
  assert.equal(await gate.admit(A), true);
  await gate.declined(B);
  await gate.cleared();
  assert.equal(await gate.admit(A), true);
  assert.equal(await gate.admit(B), true);
});

test('connects in the same tick open one window', async () => {
  const { gate } = gateAt();
  const got = await Promise.all(Array.from({ length: 8 }, () => gate.admit(A)));
  assert.equal(got.filter(Boolean).length, 1);
});

test('a record that cannot be read or written opens nothing, and the gate keeps working after', async () => {
  let fail = true;
  let record: PromptRecord = {};
  const gate = new PairingPromptGate(
    {
      load: () =>
        fail ? Promise.reject(new Error('storage')) : Promise.resolve(record),
      save: (r) => {
        if (fail) {
          return Promise.reject(new Error('storage'));
        }
        record = r;
        return Promise.resolve();
      },
    },
    () => 5_000
  );
  assert.equal(await gate.admit(A), false);
  await gate.declined(A);
  await gate.cleared();
  fail = false;
  assert.equal(await gate.admit(A), true);
  assert.equal(await gate.admit(A), false);
});

test('entries whose cooldown passed, or stamped in the future, are dropped from what is saved', async () => {
  const { gate, state } = gateAt(10 * PAIRING_PROMPT_COOLDOWN_MS);
  state.record = {
    [A]: state.now - PAIRING_PROMPT_COOLDOWN_MS, // passed
    [B]: state.now + 60_000, // a clock moved back
    'https://c.app': state.now - 1_000, // live
  };
  assert.equal(await gate.admit(B), true);
  assert.deepEqual(Object.keys(state.record).sort(), [B, 'https://c.app']);
  assert.equal(await gate.admit('https://c.app'), false);
});

test('a stored record is read only for its finite times', () => {
  assert.deepEqual(readPromptRecord(undefined), {});
  assert.deepEqual(readPromptRecord('x'), {});
  assert.deepEqual(readPromptRecord([1, 2]), {});
  assert.deepEqual(
    readPromptRecord({ [A]: 5, [B]: 'soon', c: NaN, d: Infinity, e: null }),
    { [A]: 5 }
  );
});
