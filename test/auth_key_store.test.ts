import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importAuthKey } from '../src/transport/auth_handshake';
import { loadAuthKey } from '../src/transport/auth_key_store';

// A stand-in for the browser's IndexedDB, as far as the key store reaches into
// it: an open that succeeds or fails, one object store, and a read whose
// transaction completes or errors. Callbacks fire after the caller set them.
type Fake = { openFails?: boolean; txFails?: boolean; stored?: unknown };

function installIndexedDb(fake: Fake): () => void {
  const later = (f: () => void) => setTimeout(f, 0);
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => undefined,
    close: () => undefined,
    transaction: () => {
      const tx: Record<string, unknown> = {
        error: null,
        objectStore: () => ({
          get: () => {
            const req = { result: fake.stored };
            later(() => {
              const done = tx[fake.txFails ? 'onerror' : 'oncomplete'];
              (done as () => void)();
            });
            return req;
          },
        }),
      };
      return tx;
    },
  };
  const g = globalThis as unknown as { indexedDB?: unknown };
  const saved = g.indexedDB;
  g.indexedDB = {
    open: () => {
      const req: Record<string, unknown> = { result: db, error: null };
      later(() => {
        const done = req[fake.openFails ? 'onerror' : 'onsuccess'];
        (done as () => void)();
      });
      return req;
    },
  };
  return () => {
    g.indexedDB = saved;
  };
}

async function withIndexedDb(fake: Fake, body: () => Promise<void>) {
  const restore = installIndexedDb(fake);
  try {
    await body();
  } finally {
    restore();
  }
}

test('a browser that never paired: no key, not an error', async () => {
  await withIndexedDb({ stored: undefined }, async () => {
    assert.equal(await loadAuthKey('iid'), undefined);
  });
});

test('a stored pairing key is read back', async () => {
  const key = await importAuthKey(new Uint8Array(32).fill(7));
  await withIndexedDb({ stored: key }, async () => {
    assert.equal(await loadAuthKey('iid'), key);
  });
});

test('a record that is not a key is an error, never "not paired"', async () => {
  await withIndexedDb({ stored: { raw: 'bytes' } }, async () => {
    await assert.rejects(loadAuthKey('iid'), /not a key/);
  });
});

test('a database that cannot be opened or read is an error, never "not paired"', async () => {
  await withIndexedDb({ openFails: true }, async () => {
    await assert.rejects(loadAuthKey('iid'));
  });
  await withIndexedDb({ txFails: true, stored: undefined }, async () => {
    await assert.rejects(loadAuthKey('iid'));
  });
});
