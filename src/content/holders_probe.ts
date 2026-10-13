// The content script's half of "who holds the page's provider globals?" (see
// HolderReport in src/protocol/bridge.ts). Kept free of window / browser so it
// is unit-tested; content.ts posts the probe and feeds the page's answers in.

import { HolderReport } from '../protocol/bridge';

// How long the popup's question waits for the page. The main world answers in
// the next task; a page too busy to answer this quickly gets no notice.
export const HOLDERS_TIMEOUT_MS = 500;

export interface ProbeTimer {
  set(cb: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export class HoldersProbe {
  // The question in flight: every ask() made while it waits shares its probe and
  // its answer, so the page is never probed twice for one popup.
  private pending:
    | {
        readonly answer: Promise<HolderReport | undefined>;
        readonly settle: (report: HolderReport | undefined) => void;
      }
    | undefined;

  constructor(
    private readonly postProbe: () => void,
    private readonly timer: ProbeTimer,
    private readonly timeoutMs = HOLDERS_TIMEOUT_MS
  ) {}

  // Probe the page and resolve with its answer, or with undefined once the wait
  // is over. Always settles.
  ask(): Promise<HolderReport | undefined> {
    if (this.pending) {
      return this.pending.answer;
    }
    let resolve!: (report: HolderReport | undefined) => void;
    const answer = new Promise<HolderReport | undefined>((r) => (resolve = r));
    const handle = this.timer.set(() => settle(undefined), this.timeoutMs);
    const settle = (report: HolderReport | undefined): void => {
      if (this.pending?.answer !== answer) {
        return;
      }
      this.pending = undefined;
      this.timer.clear(handle);
      resolve(report);
    };
    this.pending = { answer, settle };
    this.postProbe();
    return answer;
  }

  // The page's answer. One that arrives with no question waiting is dropped, not
  // kept for the next one: the next question is about the page as it is then.
  deliver(report: HolderReport): void {
    this.pending?.settle(report);
  }
}
