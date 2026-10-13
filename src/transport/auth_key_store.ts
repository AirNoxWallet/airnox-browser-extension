// Where the pairing secret lives between sessions: IndexedDB, as the
// non-extractable HMAC CryptoKey the pairing derived (pair_handshake.ts).
// IndexedDB stores a CryptoKey by structured clone and gives back a key with
// the same flags, so the secret's bytes are never readable by this extension's
// own code, before or after the store: the key can sign and verify, nothing
// else. storage.local / storage.session would need the raw bytes, so they never
// hold it.
//
// The database is the extension origin's, shared by its pages and its service
// worker: the pairing page writes the key, the worker reads it to answer the
// desktop's socket handshake. One record per instance id. A key that is gone
// (the browser evicted the database, the extension was reinstalled) means
// pairing again with a new code; there is no other way back.
//
// A thin browser shell: nothing here is unit-tested, it holds no logic.

const DB_NAME = 'airnox-auth';
const DB_VERSION = 1;
const STORE = 'pairing-keys';

const open = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    req.onblocked = () => reject(new Error('indexedDB open blocked'));
  });

const run = async <T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> => {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      // Resolve on the transaction's completion, not the request's success: a
      // write is durable only once its transaction committed.
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error('indexedDB failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexedDB aborted'));
    });
  } finally {
    db.close();
  }
};

// Keep `key` as the pairing secret of `iid`, replacing any earlier one (a
// pairing again after a key was lost on the desktop's side).
export const saveAuthKey = async (
  iid: string,
  key: CryptoKey
): Promise<void> => {
  if (key.extractable) {
    throw new TypeError('auth key store: only a non-extractable key is kept');
  }
  await run('readwrite', (s) => s.put(key, iid));
};

// The pairing secret of `iid`, or undefined when this instance is not paired.
// Rejects when the database cannot be read, and when the record is not a key:
// the caller must not read either as "not paired".
export const loadAuthKey = async (
  iid: string
): Promise<CryptoKey | undefined> => {
  const got: unknown = await run('readonly', (s) => s.get(iid));
  if (got === undefined) {
    return undefined;
  }
  if (!(got instanceof CryptoKey)) {
    throw new TypeError('auth key store: the stored record is not a key');
  }
  return got;
};
