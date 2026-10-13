import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTENT_TO_PAGE,
  PAGE_HOLDERS_MESSAGE,
  PAGE_TO_CONTENT,
} from '../src/protocol/bridge';

// The isolated-world content script runs on every http(s) page. It must stay
// inert until the page reaches for a provider: no runtime port (which wakes the
// background worker) and no DOM changes on a page that never touches web3. The
// main-world providers come from their own manifest entry, not from a <script>
// tag this script would add.

type Listener = (event: { source: unknown; data: unknown }) => void;

interface Harness {
  connects: number;
  posted: unknown[];
  toPage: unknown[];
  domWrites: number;
  pageMessage(data: unknown): void;
  runtimeMessage(msg: unknown): unknown;
  fireTimers(): void;
}

function loadContentScript(): Harness {
  const h: Harness = {
    connects: 0,
    posted: [],
    toPage: [],
    domWrites: 0,
    pageMessage: () => undefined,
    runtimeMessage: () => undefined,
    fireTimers: () => undefined,
  };
  const listeners: Listener[] = [];
  const runtimeListeners: ((msg: unknown) => unknown)[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const win = {
    location: { origin: 'https://dapp.example' },
    postMessage: (m: unknown) => {
      h.toPage.push(m);
    },
    setTimeout: (cb: () => void) => {
      nextTimer += 1;
      timers.set(nextTimer, cb);
      return nextTimer;
    },
    clearTimeout: (handle: number) => {
      timers.delete(handle);
    },
    addEventListener: (type: string, cb: Listener) => {
      if (type === 'message') {
        listeners.push(cb);
      }
    },
  };
  const node = {
    appendChild: () => {
      h.domWrites += 1;
    },
  };
  const doc = {
    head: node,
    documentElement: node,
    createElement: () => {
      h.domWrites += 1;
      return { remove: () => undefined };
    },
  };
  const port = {
    postMessage: (m: unknown) => {
      h.posted.push(m);
    },
    onMessage: { addListener: () => undefined },
    onDisconnect: { addListener: () => undefined },
  };
  const fakeBrowser = {
    runtime: {
      connect: () => {
        h.connects += 1;
        return port;
      },
      getURL: (p: string) =>
        `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${p}`,
      onMessage: {
        addListener: (cb: (msg: unknown) => unknown) => {
          runtimeListeners.push(cb);
        },
      },
    },
  };
  const g = globalThis as Record<string, unknown>;
  g.window = win;
  g.document = doc;
  const polyfill = require.resolve('webextension-polyfill');
  require.cache[polyfill] = {
    id: polyfill,
    filename: polyfill,
    loaded: true,
    exports: fakeBrowser,
  } as unknown as NodeModule;
  const content = require.resolve('../src/content/content');
  delete require.cache[content];
  try {
    // A fresh load per case, under the swapped-in polyfill: only require() can
    // re-run a module's top level against a patched module cache.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require(content);
  } finally {
    delete require.cache[polyfill];
    delete require.cache[content];
  }
  h.pageMessage = (data: unknown) => {
    for (const cb of listeners) {
      cb({ source: win, data });
    }
  };
  h.runtimeMessage = (msg: unknown) => {
    let reply: unknown = undefined;
    for (const cb of runtimeListeners) {
      reply = cb(msg) ?? reply;
    }
    return reply;
  };
  h.fireTimers = () => {
    const all = [...timers.values()];
    timers.clear();
    for (const cb of all) {
      cb();
    }
  };
  return h;
}

test('loading on a page opens no port and adds nothing to the DOM', () => {
  const h = loadContentScript();
  assert.equal(h.connects, 0, 'no runtime port before the page asks');
  assert.equal(h.domWrites, 0, 'no injected <script> element');
  assert.deepEqual(h.posted, []);
});

test('the first touch opens the port, which says hello before the touch', () => {
  const h = loadContentScript();
  h.pageMessage({ channel: PAGE_TO_CONTENT, touch: true });
  assert.equal(h.connects, 1);
  assert.deepEqual(h.posted, [
    { kind: 'hello', origin: 'https://dapp.example' },
    { kind: 'touch', origin: 'https://dapp.example' },
  ]);
  h.pageMessage({ channel: PAGE_TO_CONTENT, touch: true });
  assert.equal(h.connects, 1, 'one port per page while it lives');
});

test('a message that is not ours opens no port', () => {
  const h = loadContentScript();
  h.pageMessage({ channel: 'someone-else', touch: true });
  h.pageMessage('a string');
  assert.equal(h.connects, 0);
});

const HOLDERS = {
  ethereum: 'other',
  tronWeb: 'airnox',
  tronLink: 'airnox',
  tron: 'airnox',
  airnox: 'airnox',
};

test('the popup\u2019s holder question probes the page and returns its answer, with no port', async () => {
  const h = loadContentScript();
  const reply = h.runtimeMessage({ type: PAGE_HOLDERS_MESSAGE });
  assert.ok(reply instanceof Promise, 'the question is answered');
  assert.deepEqual(h.toPage, [{ channel: CONTENT_TO_PAGE, probe: 'holders' }]);
  h.pageMessage({ channel: PAGE_TO_CONTENT, holders: HOLDERS });
  assert.deepEqual(await reply, { holders: HOLDERS });
  assert.equal(h.connects, 0, 'asking who holds the globals wakes no worker');
});

test('a page that does not answer the holder probe gives an empty reply', async () => {
  const h = loadContentScript();
  const reply = h.runtimeMessage({ type: PAGE_HOLDERS_MESSAGE });
  h.pageMessage({ channel: PAGE_TO_CONTENT, holders: { ethereum: 'other' } });
  h.fireTimers();
  assert.deepEqual(await reply, {});
});

test('a holder answer nobody asked for opens no port and is not kept', async () => {
  const h = loadContentScript();
  h.pageMessage({ channel: PAGE_TO_CONTENT, holders: HOLDERS });
  assert.equal(h.connects, 0);
  const reply = h.runtimeMessage({ type: PAGE_HOLDERS_MESSAGE });
  h.fireTimers();
  assert.deepEqual(await reply, {});
});
