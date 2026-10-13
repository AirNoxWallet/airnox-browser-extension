// When a dApp's connect may open the pairing window. The window asks the person
// to pair with the desktop app; a dApp that connects again and again (on every
// page load, on a timer, after each refusal) must not put it in front of them
// again and again. So the window opens for an origin at most once per cooldown:
// a connect from that origin inside it opens nothing and is refused as not
// paired. The person closing the window without pairing starts the cooldown
// again from that moment; a completed pairing lifts it for every origin.
//
// The window itself asks the desktop for nothing until the person presses Pair
// in it, so even an admitted connect raises nothing on the desktop by itself.
//
// Pure: the worker keeps the record through `load` / `save` (storage.session,
// so a worker eviction does not reset it), and the clock is injected.

export const PAIRING_PROMPT_COOLDOWN_MS = 5 * 60_000;

// origin -> when its window last opened or was closed unpaired (ms epoch).
export type PromptRecord = Record<string, number>;

export interface PromptStore {
  load(): Promise<PromptRecord>;
  save(record: PromptRecord): Promise<void>;
}

// A record read back from storage is untrusted in shape: anything that is not
// a finite time is dropped.
export const readPromptRecord = (raw: unknown): PromptRecord => {
  const out: PromptRecord = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return out;
  }
  for (const [origin, at] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof at === 'number' && Number.isFinite(at)) {
      out[origin] = at;
    }
  }
  return out;
};

export class PairingPromptGate {
  // One decision at a time: two connects in the same tick must not both read
  // the record before either wrote it.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: PromptStore,
    private readonly now: () => number = Date.now,
    private readonly cooldownMs: number = PAIRING_PROMPT_COOLDOWN_MS
  ) {}

  // Whether a connect from `origin` may open the pairing window now; when it
  // may, the opening is recorded. A record that cannot be read or written
  // opens nothing: a missed window costs the person a click in the popup, a
  // window that cannot be held back costs them a window per request.
  admit(origin: string): Promise<boolean> {
    return this.serial(async () => {
      const at = this.now();
      const record = this.live(await this.store.load(), at);
      if (record[origin] !== undefined) {
        return false;
      }
      record[origin] = at;
      await this.store.save(record);
      return true;
    }, false);
  }

  // The person closed the window for `origin` without pairing: no connect
  // from it opens the window again for a cooldown from now.
  declined(origin: string): Promise<void> {
    return this.serial(async () => {
      const at = this.now();
      const record = this.live(await this.store.load(), at);
      record[origin] = at;
      await this.store.save(record);
    }, undefined);
  }

  // A pairing completed: the next connect from any origin may open the window
  // (the desktop may drop the pairing again later).
  cleared(): Promise<void> {
    return this.serial(() => this.store.save({}), undefined);
  }

  // The record without the entries whose cooldown has passed (and without any
  // stamped in the future: a clock moved back must not hold an origin longer).
  private live(record: PromptRecord, at: number): PromptRecord {
    const out: PromptRecord = {};
    for (const [origin, when] of Object.entries(readPromptRecord(record))) {
      if (when <= at && at - when < this.cooldownMs) {
        out[origin] = when;
      }
    }
    return out;
  }

  private serial<T>(op: () => Promise<T>, onError: T): Promise<T> {
    const run = this.queue.then(op).catch(() => onError);
    this.queue = run;
    return run;
  }
}
