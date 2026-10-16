import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PairingWindow,
  PairingWindowRecord,
  readPairingWindowRecord,
} from '../src/background/pairing_window';

const A = 'https://a.app';

// The browser's windows as the worker sees them: ids it created, which of them
// are still open, and every create / focus it was asked for.
function browserWindows() {
  const state = {
    nextId: 10,
    open: new Set<number>(),
    creates: [] as (string | undefined)[],
    focuses: [] as number[],
    failCreate: false,
  };
  const ops = {
    focus: (id: number) => {
      state.focuses.push(id);
      return Promise.resolve(state.open.has(id));
    },
    create: (origin: string | undefined) => {
      if (state.failCreate) {
        return Promise.reject(new Error('no window'));
      }
      state.creates.push(origin);
      const id = state.nextId++;
      state.open.add(id);
      return Promise.resolve(id);
    },
  };
  return { state, ops };
}

// storage.session: it outlives the worker, so a worker restart is a new
// PairingWindow over the same store.
function sessionStore() {
  const held: { value: unknown } = { value: undefined };
  return {
    held,
    store: {
      load: () => Promise.resolve(held.value),
      save: (r: PairingWindowRecord | undefined) => {
        held.value = r === undefined ? undefined : { ...r };
        return Promise.resolve();
      },
    },
  };
}

test('a second open focuses the pairing window instead of opening another', async () => {
  const { state, ops } = browserWindows();
  const { store } = sessionStore();
  const win = new PairingWindow(store, ops);
  await win.open(A);
  await win.open(A);
  assert.deepEqual(state.creates, [A]);
  assert.deepEqual(state.focuses, [10]);
});

test('the toolbar Pair focuses the window a dApp opened, keeping its dApp', async () => {
  const { state, ops } = browserWindows();
  const { store, held } = sessionStore();
  const win = new PairingWindow(store, ops);
  await win.open(A); // a dApp's connect
  await win.open(undefined); // the toolbar popup's Pair
  assert.deepEqual(state.creates, [A]);
  assert.deepEqual(state.focuses, [10]);
  assert.deepEqual(held.value, { id: 10, origin: A, paired: false });
});

test('a window opened from the toolbar names no dApp', async () => {
  const { state, ops } = browserWindows();
  const { store, held } = sessionStore();
  await new PairingWindow(store, ops).open(undefined);
  assert.deepEqual(state.creates, [undefined]);
  assert.deepEqual(held.value, { id: 10, paired: false });
});

test('the open window is still focused, not duplicated, after a worker restart', async () => {
  const { state, ops } = browserWindows();
  const { store } = sessionStore();
  await new PairingWindow(store, ops).open(A);
  // The worker is evicted; a new one starts with nothing in memory.
  const restarted = new PairingWindow(store, ops);
  await restarted.open(undefined);
  assert.deepEqual(state.creates, [A]);
  assert.deepEqual(state.focuses, [10]);
});

test('a window that is gone is replaced by a new one', async () => {
  const { state, ops } = browserWindows();
  const { store, held } = sessionStore();
  const win = new PairingWindow(store, ops);
  await win.open(A);
  state.open.delete(10); // closed while no worker was there to hear it
  await win.open(undefined);
  assert.deepEqual(state.creates, [A, undefined]);
  assert.deepEqual(held.value, { id: 11, paired: false });
});

test('opens in the same tick open one window', async () => {
  const { state, ops } = browserWindows();
  const { store } = sessionStore();
  const win = new PairingWindow(store, ops);
  await Promise.all([win.open(A), win.open(undefined), win.open(A)]);
  assert.deepEqual(state.creates, [A]);
});

test('closing the window reports its dApp and whether it paired, also after a restart', async () => {
  const { ops } = browserWindows();
  const { store, held } = sessionStore();
  const win = new PairingWindow(store, ops);
  await win.open(A);
  assert.equal(await win.removed(99), undefined, 'not the pairing window');
  assert.deepEqual(held.value, { id: 10, origin: A, paired: false });

  const restarted = new PairingWindow(store, ops);
  assert.deepEqual(await restarted.removed(10), {
    id: 10,
    origin: A,
    paired: false,
  });
  assert.equal(held.value, undefined);
  assert.equal(await restarted.removed(10), undefined, 'reported once');
});

test('a completed pairing is kept with the window, so its close is no decline', async () => {
  const { ops } = browserWindows();
  const { store } = sessionStore();
  await new PairingWindow(store, ops).open(A);
  await new PairingWindow(store, ops).paired();
  const closed = await new PairingWindow(store, ops).removed(10);
  assert.equal(closed?.paired, true);
});

test('a failed create opens nothing and the next open tries again', async () => {
  const { state, ops } = browserWindows();
  const { store, held } = sessionStore();
  const win = new PairingWindow(store, ops);
  state.failCreate = true;
  await assert.rejects(win.open(A));
  assert.equal(held.value, undefined);
  state.failCreate = false;
  await win.open(A);
  assert.deepEqual(state.creates, [A]);
});

test('a record read back from storage is untrusted in shape', () => {
  assert.deepEqual(readPairingWindowRecord({ id: 3, paired: false }), {
    id: 3,
    paired: false,
  });
  assert.deepEqual(
    readPairingWindowRecord({ id: 3, origin: A, paired: true }),
    {
      id: 3,
      origin: A,
      paired: true,
    }
  );
  for (const junk of [
    undefined,
    null,
    7,
    'x',
    [],
    {},
    { id: '3', paired: false },
    { id: 1.5, paired: false },
    { id: Number.NaN, paired: false },
    { id: 3 },
    { id: 3, paired: 'yes' },
    { id: 3, origin: 4, paired: false },
  ]) {
    assert.equal(
      readPairingWindowRecord(junk),
      undefined,
      JSON.stringify(junk)
    );
  }
});
