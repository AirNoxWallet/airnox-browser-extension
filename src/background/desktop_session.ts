// Which desktop SESSION the extension last saw, and whether the one a heartbeat now reports means the desktop
// restarted.
//
// A device wallet's dApp grant lives only as long as its desktop session (the desktop saves nothing about a device
// wallet), so a desktop that restarted holds no grant for an account a page cached — and the page would read
// "connected" until its next signature met 4100. The SW therefore forgets every cached account when the session
// changes. Pure: the SW persists the last session through `load` / `save` (storage.session, which outlives a worker
// eviction), so this is unit-tested without a browser.
export class DesktopSessionWatch {
  // One observation at a time: the handshake of a new socket and the heartbeat can
  // report the same new session together, and the second must read what the first
  // saved, or every page is told twice.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly load: () => Promise<string | undefined>,
    private readonly save: (session: string) => Promise<void>
  ) {}

  // True iff `current` replaces a session seen before — the desktop restarted. An
  // unknown session (an older desktop names none) changes nothing; the first one
  // ever seen is remembered without being a restart: a fresh browser has no stale
  // page state to clear.
  observe(current: string | undefined): Promise<boolean> {
    const run = this.queue.then(async () => {
      if (current === undefined) {
        return false;
      }
      const previous = await this.load();
      if (previous === current) {
        return false;
      }
      await this.save(current);
      return previous !== undefined;
    });
    // A failed observation reports its error to its caller and does not wedge the
    // ones queued behind it.
    this.queue = run.catch(() => undefined);
    return run;
  }
}
