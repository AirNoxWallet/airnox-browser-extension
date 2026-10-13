// Which TABS have reached for web3 — the registry behind the per-tab toolbar
// badge. Pure (no browser.*), so the bookkeeping is unit-tested; background.ts
// owns the listeners that feed it and badge.ts paints what it holds.
//
// A tab enters the set when its page touches an injected provider (a global
// read, an EIP-6963 request, a Wallet-Standard handshake — see
// inpage/activity.ts) or sends an RPC, and leaves it when the tab navigates to a
// fresh document or closes. Only these tabs ever show wallet state; on every
// other tab the wallet must look inactive, which is simply no badge at all.
//
// The set is per-worker memory and the MV3 worker is evicted constantly, so it
// is NOT the durable copy — the browser's own per-tab badges are (see badge.ts).
// `adopt` is how a restarted worker takes those back.
export class Web3Tabs {
  private readonly marked = new Set<number>();

  // Record a tab as wanting web3. True iff this is news — the caller paints only
  // on a transition, so a chatty page does not repaint on every touch.
  mark(tabId: number): boolean {
    if (this.marked.has(tabId)) {
      return false;
    }
    this.marked.add(tabId);
    return true;
  }

  // Drop a tab (navigated away / closed). True iff it was marked.
  forget(tabId: number): boolean {
    return this.marked.delete(tabId);
  }

  has(tabId: number): boolean {
    return this.marked.has(tabId);
  }

  // Take back tabs a previous worker marked, read off their badges. MERGES: a
  // tab this worker has already marked stays marked even if the read missed it.
  adopt(tabIds: Iterable<number>): void {
    for (const id of tabIds) {
      this.marked.add(id);
    }
  }

  all(): number[] {
    return [...this.marked];
  }

  get size(): number {
    return this.marked.size;
  }
}
