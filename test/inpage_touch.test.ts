import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTouchReporter } from '../src/inpage/activity';
import { InjectedGlobals } from '../src/inpage/held_globals';
import { installEvmProvider } from '../src/inpage/provider';
import { installTonConnect } from '../src/inpage/tonconnect_inpage';
import { installTronShim } from '../src/inpage/tron_inpage';
import { Transport } from '../src/inpage/transport';

// The providers never round-trip in these tests — only the window surface they
// install is under test.
const idleTransport: Transport = {
  send: () => Promise.resolve(undefined),
  onEvent: () => undefined,
};

// A stand-in for the page's window: enough of it that an installer can define a
// global and announce itself. A FRESH one per test — each installer skips a
// global that is already present, so a reused object would keep the first one.
function fakeWindow(): Record<string, unknown> & {
  listeners: Map<string, EventListener>;
  dispatched: Event[];
} {
  const listeners = new Map<string, EventListener>();
  const dispatched: Event[] = [];
  return {
    listeners,
    dispatched,
    addEventListener: (type: string, cb: EventListener) =>
      listeners.set(type, cb),
    dispatchEvent: (e: Event) => {
      dispatched.push(e);
      return true;
    },
  };
}

function withWindow<T>(w: object, body: () => T): T {
  const prior = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = w;
  try {
    return body();
  } finally {
    (globalThis as { window?: unknown }).window = prior;
  }
}

test('reading window.ethereum is what marks the tab — installing it is not', () => {
  const w = fakeWindow();
  let touches = 0;
  const report = createTouchReporter(() => (touches += 1));
  withWindow(w, () => {
    installEvmProvider(idleTransport, report, new InjectedGlobals(w));
    // document_start: the provider is in place and has announced itself, but the
    // page has not asked for anything. The toolbar must stay blank here.
    assert.equal(touches, 0);

    const provider = (w as { ethereum?: unknown }).ethereum;
    assert.ok(provider, 'the read returns the provider, exactly as before');
    assert.equal(touches, 1);
    // The same object every time, and only the first read is reported.
    assert.equal((w as { ethereum?: unknown }).ethereum, provider);
    assert.equal(touches, 1);
  });
});

test('an EIP-6963 discovery request marks the tab', () => {
  const w = fakeWindow();
  let touches = 0;
  withWindow(w, () => {
    installEvmProvider(
      idleTransport,
      createTouchReporter(() => (touches += 1)),
      new InjectedGlobals(w)
    );
    const announced = w.dispatched.length; // our unsolicited announce
    assert.equal(touches, 0);

    const onRequest = w.listeners.get('eip6963:requestProvider');
    assert.ok(onRequest, 'the wallet listens for the discovery request');
    onRequest(new Event('eip6963:requestProvider'));
    assert.equal(touches, 1);
    // …and still answers it, which is the whole point of the listener.
    assert.equal(w.dispatched.length, announced + 1);
  });
});

test('reading any TRON global marks the tab, and still yields the shim', () => {
  for (const key of ['tronWeb', 'tronLink', 'tron']) {
    const w = fakeWindow();
    let touches = 0;
    withWindow(w, () => {
      installTronShim(
        idleTransport,
        createTouchReporter(() => (touches += 1)),
        new InjectedGlobals(w)
      );
      assert.equal(touches, 0, `${key}: install alone must not mark the tab`);
      const shim = (w as Record<string, unknown>)[key];
      assert.ok(shim, `${key} is installed`);
      assert.equal(touches, 1, `${key}: the read marks the tab`);
    });
  }
});

test('reading the TON Connect bridge marks the tab', () => {
  const w = fakeWindow();
  let touches = 0;
  withWindow(w, () => {
    installTonConnect(
      idleTransport,
      createTouchReporter(() => (touches += 1)),
      new InjectedGlobals(w)
    );
    assert.equal(touches, 0);
    // TON Connect discovery IS the property read — there is no announce event,
    // so this is the only signal the bridge can ever give before a request.
    const bridge = (w as { airnox?: { tonconnect?: unknown } }).airnox;
    assert.ok(bridge?.tonconnect);
    assert.equal(touches, 1);
  });
});

test('the touch is reported once per document, across ALL five providers', () => {
  const w = fakeWindow();
  let touches = 0;
  const report = createTouchReporter(() => (touches += 1));
  withWindow(w, () => {
    installEvmProvider(idleTransport, report, new InjectedGlobals(w));
    installTonConnect(idleTransport, report, new InjectedGlobals(w));
    installTronShim(idleTransport, report, new InjectedGlobals(w));
    void (w as { ethereum?: unknown }).ethereum;
    void (w as { airnox?: unknown }).airnox;
    void (w as { tronWeb?: unknown }).tronWeb;
    void (w as { tron?: unknown }).tron;
    assert.equal(touches, 1);
  });
});
