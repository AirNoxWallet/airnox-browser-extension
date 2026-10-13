import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTouchReporter } from '../src/inpage/activity';
import { InjectedGlobals } from '../src/inpage/held_globals';
import { installEvmProvider } from '../src/inpage/provider';
import { installTonConnect } from '../src/inpage/tonconnect_inpage';
import { installTronShim } from '../src/inpage/tron_inpage';
import { Transport } from '../src/inpage/transport';

// Another wallet's inpage script may run after ours on the same page. Our legacy
// globals must not break it: each is a configurable getter it can redefine, with
// a setter that hands the global to a wallet that assigns it, while EIP-6963
// stays the conflict-free discovery path.

const idleTransport: Transport = {
  send: () => Promise.resolve(undefined),
  onEvent: () => undefined,
};

function fakeWindow(): Record<string, unknown> {
  return {
    addEventListener: () => undefined,
    dispatchEvent: () => true,
  };
}

function installAll(w: object): void {
  const prior = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = w;
  try {
    const report = createTouchReporter(() => undefined);
    installEvmProvider(idleTransport, report, new InjectedGlobals(w));
    installTonConnect(idleTransport, report, new InjectedGlobals(w));
    installTronShim(idleTransport, report, new InjectedGlobals(w));
  } finally {
    (globalThis as { window?: unknown }).window = prior;
  }
}

const GLOBALS = ['ethereum', 'airnox', 'tronWeb', 'tronLink', 'tron'];

for (const key of GLOBALS) {
  test(`window.${key} is a configurable getter whose setter gives it away`, () => {
    const w = fakeWindow();
    installAll(w);
    const d = Object.getOwnPropertyDescriptor(w, key);
    assert.ok(d, `${key} is installed`);
    assert.equal(d.configurable, true);
    assert.equal(typeof d.get, 'function');
    assert.equal(typeof d.set, 'function');
  });

  test(`a wallet that assigns window.${key} after ours, in strict code, gets it`, () => {
    'use strict';
    const w = fakeWindow();
    installAll(w);
    const theirs = { theirs: true };
    assert.doesNotThrow(() => {
      w[key] = theirs;
    });
    assert.equal(w[key], theirs);
  });

  test(`a wallet that loads after ours can take window.${key}`, () => {
    const w = fakeWindow();
    installAll(w);
    const theirs = { theirs: true };
    assert.doesNotThrow(() =>
      Object.defineProperty(w, key, {
        value: theirs,
        writable: true,
        configurable: true,
      })
    );
    assert.equal(w[key], theirs);
  });
}

test('a global another wallet defined first is left alone', () => {
  const w = fakeWindow();
  const theirs = { theirs: true };
  for (const key of GLOBALS) {
    w[key] = theirs;
  }
  installAll(w);
  for (const key of GLOBALS) {
    assert.equal(w[key], theirs, key);
  }
});
