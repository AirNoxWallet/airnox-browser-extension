// The one pairing window. Two paths open the pairing page: a dApp's connect that
// finds no pairing (it names the dApp), and the Pair in the toolbar popup's
// Pairing row (it names none). Both come here, so there is never a second
// window: a second window's Pair would ask the desktop for a code while the
// first attempt's code is still shown there, and the desktop answers that with
// RequestPending, which reads to the person as if something were wrong with
// this browser. An open window is focused instead, keeping the dApp it names
// and the attempt it holds; the desktop's code dialog may have opened behind
// the browser, and the window is where the person types that code.
//
// The window outlives the worker that opened it (an MV3 worker is evicted after
// about 30 s idle), so the record of it lives in storage.session rather than in
// worker memory: a restarted worker still focuses it, and still knows, when it
// closes, which dApp it named and whether it paired. storage.session is cleared
// when the browser or the extension restarts, which closes the window too, and
// window ids are not reused within a browser session, so a record never names
// another window. (runtime.getContexts could find the page instead, but it
// cannot say whether the window paired, so the record would be needed anyway.)
//
// Pure: the worker passes the storage and the windows API in, so it is
// unit-tested.

// The open pairing window: its browser window id, the dApp whose connect opened
// it (none when the toolbar did), and whether a pairing completed in it.
export interface PairingWindowRecord {
  id: number;
  origin?: string;
  paired: boolean;
}

export interface PairingWindowStore {
  load(): Promise<unknown>;
  save(record: PairingWindowRecord | undefined): Promise<void>;
}

export interface PairingWindowOps {
  // Bring the window to the front; false when there is no such window.
  focus(id: number): Promise<boolean>;
  // Open the pairing page in a new window, naming `origin`; its id.
  create(origin: string | undefined): Promise<number>;
}

// A record read back from storage is untrusted in shape: anything that is not
// exactly a record reads as no window, and the next open creates one.
export const readPairingWindowRecord = (
  raw: unknown
): PairingWindowRecord | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const { id, origin, paired } = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(id) || typeof paired !== 'boolean') {
    return undefined;
  }
  if (origin !== undefined && typeof origin !== 'string') {
    return undefined;
  }
  return origin === undefined
    ? { id: id as number, paired }
    : { id: id as number, origin, paired };
};

export class PairingWindow {
  // One step at a time: two opens in the same tick must not both find no
  // window before either recorded the one it created.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: PairingWindowStore,
    private readonly ops: PairingWindowOps
  ) {}

  // Focus the open pairing window, or open one naming `origin`. An open
  // window keeps the dApp it names: the attempt in it is that one's.
  open(origin: string | undefined): Promise<void> {
    return this.serial(async () => {
      const open = readPairingWindowRecord(await this.store.load());
      if (open !== undefined && (await this.ops.focus(open.id))) {
        return;
      }
      // Gone (closed while no worker heard it) or never opened. A create that
      // fails records nothing, so the next open tries again.
      const id = await this.ops.create(origin);
      await this.store.save(
        origin === undefined
          ? { id, paired: false }
          : { id, origin, paired: false }
      );
    });
  }

  // A pairing completed in the open window: its close is not a decline.
  paired(): Promise<void> {
    return this.serial(async () => {
      const open = readPairingWindowRecord(await this.store.load());
      if (open !== undefined) {
        await this.store.save({ ...open, paired: true });
      }
    });
  }

  // A browser window closed. When it was the pairing window, its record, once;
  // otherwise undefined.
  removed(windowId: number): Promise<PairingWindowRecord | undefined> {
    return this.serial(async () => {
      const open = readPairingWindowRecord(await this.store.load());
      if (open === undefined || open.id !== windowId) {
        return undefined;
      }
      await this.store.save(undefined);
      return open;
    });
  }

  // A failed step rejects for its caller only; the next step still runs.
  private serial<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
