import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTouchReporter } from '../src/inpage/activity';
import { InjectedGlobals } from '../src/inpage/held_globals';
import { PROVIDER_GLOBALS } from '../src/protocol/bridge';

// Who holds each provider global, read off its property descriptor. The fake
// window is a plain object: the registry takes its target, it does not reach for
// the real window.

function setup(w: Record<string, unknown> = {}): {
  w: Record<string, unknown>;
  globals: InjectedGlobals;
  touches: () => number;
} {
  let touches = 0;
  const report = createTouchReporter(() => (touches += 1));
  const globals = new InjectedGlobals(w);
  for (const key of PROVIDER_GLOBALS) {
    globals.define(key, { ours: key }, report);
  }
  return { w, globals, touches: () => touches };
}

test('every global we installed reports AirNox as its holder', () => {
  const { globals } = setup();
  for (const key of PROVIDER_GLOBALS) {
    assert.equal(globals.holder(key), 'airnox', key);
  }
});

test('a global another wallet held before us is left alone and reported', () => {
  const theirs = { isMetaMask: true };
  const w: Record<string, unknown> = { ethereum: theirs, tronWeb: theirs };
  const { globals } = setup(w);
  assert.equal(w.ethereum, theirs);
  assert.equal(w.tronWeb, theirs);
  assert.equal(globals.holder('ethereum'), 'other');
  assert.equal(globals.holder('tronWeb'), 'other');
  assert.equal(globals.holder('tronLink'), 'airnox');
});

test('a locked global the browser holds is left alone, without a throw', () => {
  // A built-in wallet may define its provider non-configurable and non-writable.
  const brave = { isBraveWallet: true };
  const w: Record<string, unknown> = {};
  Object.defineProperty(w, 'ethereum', {
    value: brave,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  const { globals } = setup(w);
  assert.equal(w.ethereum, brave);
  assert.equal(globals.holder('ethereum'), 'other');
});

test('a wallet that redefines ours after us is reported, data or accessor', () => {
  const { w, globals } = setup();
  Object.defineProperty(w, 'ethereum', {
    value: { isRabby: true },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(w, 'tron', {
    get: () => ({ isTronLink: true }),
    configurable: true,
  });
  assert.equal(globals.holder('ethereum'), 'other');
  assert.equal(globals.holder('tron'), 'other');
  assert.equal(globals.holder('tronWeb'), 'airnox');
});

test('an inherited global, such as an element with that id, is no wallet\u2019s', () => {
  // The DOM's named access makes an element with id="ethereum" readable as
  // window.ethereum through the prototype chain. Every wallet installs its
  // provider on the window itself, so only an own property counts.
  const proto = { ethereum: { tagName: 'DIV' } };
  const w = Object.create(proto) as Record<string, unknown>;
  const { globals } = setup(w);
  assert.equal(globals.holder('ethereum'), 'airnox');
});

test('a global that exists with nothing usable in it is still left alone', () => {
  // A wallet may put a placeholder (`window.tronWeb = false` until the site is
  // authorised) before our script runs. Only a wallet or the browser can have
  // put it there, so it is theirs.
  const w: Record<string, unknown> = { tronWeb: false };
  const { globals } = setup(w);
  assert.equal(w.tronWeb, false);
  assert.equal(globals.holder('tronWeb'), 'none', 'nothing a dApp can use');
  assert.equal(globals.holder('tronLink'), 'airnox');
});

test('a wallet that assigns after us, in strict code, takes the global without a throw', () => {
  'use strict';
  const { w, globals, touches } = setup();
  const theirs = { isMetaMask: true };
  assert.doesNotThrow(() => {
    w.ethereum = theirs;
  });
  assert.equal(w.ethereum, theirs);
  const d = Object.getOwnPropertyDescriptor(w, 'ethereum');
  assert.deepEqual(d, {
    value: theirs,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  assert.equal(globals.holder('ethereum'), 'other');
  assert.equal(touches(), 0, 'giving the global away is not a page touch');
  // ...and it stays theirs: a second assignment is an ordinary write.
  const again = { isMetaMask: true, again: true };
  w.ethereum = again;
  assert.equal(w.ethereum, again);
});

test('a page that plants descriptor keys on Object.prototype changes neither the report nor the setter', () => {
  const { w, globals } = setup();
  Object.defineProperty(w, 'tron', {
    value: { isTronLink: true },
    writable: true,
    configurable: true,
  });
  // A data property holding nothing must not read as an accessor once
  // Object.prototype has a `get`.
  Object.defineProperty(w, 'airnox', {
    value: undefined,
    writable: true,
    configurable: true,
  });
  const proto = Object.prototype as Record<string, unknown>;
  const theirs = { isMetaMask: true };
  try {
    proto.get = () => undefined;
    proto.value = { planted: true };
    assert.equal(globals.holder('tron'), 'other');
    assert.equal(globals.holder('ethereum'), 'airnox');
    assert.equal(globals.holder('airnox'), 'none');
    // The setter still gives the global away, to exactly what was assigned.
    assert.doesNotThrow(() => {
      w.tronWeb = theirs;
    });
  } finally {
    delete proto.get;
    delete proto.value;
  }
  assert.equal(w.tronWeb, theirs);
  assert.equal(globals.holder('tronWeb'), 'other');
});

test('a removed or emptied global is held by nobody', () => {
  const { w, globals } = setup();
  delete w.ethereum;
  Object.defineProperty(w, 'airnox', {
    value: undefined,
    writable: true,
    configurable: true,
  });
  assert.equal(globals.holder('ethereum'), 'none');
  assert.equal(globals.holder('airnox'), 'none');
});

test('an install and a report call no getter, foreign or ours, and report no touch', () => {
  let foreignReads = 0;
  const w: Record<string, unknown> = {};
  Object.defineProperty(w, 'ethereum', {
    get: () => {
      foreignReads += 1;
      return { isMetaMask: true };
    },
    configurable: true,
  });
  const { globals, touches } = setup(w);
  assert.equal(foreignReads, 0, 'the install called no foreign getter');
  const report = globals.report();
  assert.equal(foreignReads, 0, 'the report called no foreign getter');
  assert.equal(touches(), 0, 'reading the descriptors is not a page touch');
  assert.deepEqual(report, {
    ethereum: 'other',
    tronWeb: 'airnox',
    tronLink: 'airnox',
    tron: 'airnox',
    airnox: 'airnox',
  });
});

test('a report and the setter survive a page that patches Object later', () => {
  const { w, globals } = setup();
  Object.defineProperty(w, 'ethereum', {
    value: { isOther: true },
    writable: true,
    configurable: true,
  });
  const real = Object.getOwnPropertyDescriptor;
  const realDefine = Object.defineProperty;
  try {
    Object.getOwnPropertyDescriptor = () => undefined;
    Object.defineProperty = <T>(o: T): T => o;
    assert.equal(globals.holder('ethereum'), 'other');
    assert.equal(globals.holder('tron'), 'airnox');
    // Our setter still gives the global away.
    w.tron = { isTronLink: true };
  } finally {
    Object.getOwnPropertyDescriptor = real;
    Object.defineProperty = realDefine;
  }
  assert.equal(globals.holder('tron'), 'other');
});

test('a report names exactly the provider globals', () => {
  const { globals } = setup();
  assert.deepEqual(
    Object.keys(globals.report()).sort(),
    [...PROVIDER_GLOBALS].sort()
  );
});
