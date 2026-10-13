import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONTENT_TO_PAGE, PAGE_TO_CONTENT } from '../src/protocol/bridge';

// The main-world entry answers the content script's probe for who holds each
// provider global. Loaded for real against a stand-in window, like the content
// script's own test: only require() re-runs a module's top level.

type Listener = (event: { source: unknown; data: unknown }) => void;

function loadInpage(preset: (w: Record<string, unknown>) => void = () => {}): {
  w: Record<string, unknown>;
  posted: unknown[];
  probe(source?: unknown): void;
} {
  const listeners: Listener[] = [];
  const posted: unknown[] = [];
  const w: Record<string, unknown> = {
    addEventListener: (type: string, cb: Listener) => {
      if (type === 'message') {
        listeners.push(cb);
      }
    },
    dispatchEvent: () => true,
    postMessage: (m: unknown) => {
      posted.push(m);
    },
  };
  preset(w);
  const g = globalThis as Record<string, unknown>;
  const prior = g.window;
  g.window = w;
  const entry = require.resolve('../src/inpage/inpage');
  delete require.cache[entry];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(entry);
  } finally {
    delete require.cache[entry];
    g.window = prior;
  }
  return {
    w,
    posted,
    probe: (source: unknown = w) => {
      // The listener reads the global `window` when it runs, as in a page.
      const before = g.window;
      g.window = w;
      try {
        for (const cb of listeners) {
          cb({ source, data: { channel: CONTENT_TO_PAGE, probe: 'holders' } });
        }
      } finally {
        g.window = before;
      }
    },
  };
}

const holdersOf = (posted: unknown[]): unknown[] =>
  posted.filter((m) => (m as { holders?: unknown }).holders !== undefined);

test('a probe is answered with AirNox holding every global it installed, and no touch', () => {
  const page = loadInpage();
  page.probe();
  assert.deepEqual(page.posted, [
    {
      channel: PAGE_TO_CONTENT,
      holders: {
        ethereum: 'airnox',
        tronWeb: 'airnox',
        tronLink: 'airnox',
        tron: 'airnox',
        airnox: 'airnox',
      },
    },
  ]);
});

test('a wallet that injected first is reported, and one that replaced ours later too', () => {
  const page = loadInpage((w) => {
    w.ethereum = { isBraveWallet: true };
  });
  Object.defineProperty(page.w, 'tronWeb', {
    value: { isTronLink: true },
    writable: true,
    configurable: true,
  });
  page.probe();
  const [answer] = holdersOf(page.posted) as { holders: unknown }[];
  assert.deepEqual(answer.holders, {
    ethereum: 'other',
    tronWeb: 'other',
    tronLink: 'airnox',
    tron: 'airnox',
    airnox: 'airnox',
  });
});

test('a probe from another window is not answered', () => {
  const page = loadInpage();
  page.probe({});
  assert.deepEqual(holdersOf(page.posted), []);
});
