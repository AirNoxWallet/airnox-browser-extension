// Keeps the MV3 service worker alive while a dApp request is outstanding.
//
// MV3 evicts the worker after ~30s of inactivity. A sign / connect request can
// sit for minutes awaiting the user's confirmation on the desktop, during which
// there is NO WebSocket traffic — so the worker can be evicted mid-confirm,
// dropping the request. SwKeepalive runs a periodic `tick` (a WS sys_ping) while
// ≥1 dApp request is in flight; that WS activity resets Chrome's worker idle
// timer (Chrome 116+). It stops when the last request settles, so the worker
// idles out normally when the page is quiet — keepalive runs ONLY during the
// vulnerable window.
//
// Reference-counted: concurrent requests keep it running until ALL settle. The
// timer functions are injected so the gate is unit-testable without a real clock.

export type IntervalId = ReturnType<typeof setInterval>;

export class SwKeepalive {
  private active = 0;
  private timer: IntervalId | null = null;

  constructor(
    private readonly tick: () => void,
    private readonly intervalMs: number,
    private readonly setIntervalFn: (
      cb: () => void,
      ms: number
    ) => IntervalId = (cb, ms) => setInterval(cb, ms),
    private readonly clearIntervalFn: (id: IntervalId) => void = (id) =>
      clearInterval(id)
  ) {}

  // A dApp request started — keep the worker alive (start the ticker on 0 → 1).
  begin(): void {
    this.active += 1;
    if (this.active === 1 && this.timer === null) {
      this.timer = this.setIntervalFn(this.tick, this.intervalMs);
    }
  }

  // A dApp request settled — release (stop the ticker when the LAST one ends).
  end(): void {
    if (this.active > 0) {
      this.active -= 1;
    }
    if (this.active === 0 && this.timer !== null) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
  }

  get running(): boolean {
    return this.timer !== null;
  }
}
