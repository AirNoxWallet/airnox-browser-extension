// A RECONNECTABLE runtime port to the background service worker.
//
// MV3 evicts the service worker after ~30s of inactivity, which disconnects the
// content↔SW port. A page loaded before the eviction would otherwise hold a dead
// port forever: posting into a disconnected port is silently dropped (it does NOT
// wake the worker), so the dApp's next request hangs and pushed events stop
// arriving. That is the "connects once, then stops working" failure.
//
// PortRelay reconnects LAZILY on the next send: re-establishing the port wakes the
// worker and re-registers this page's origin via `hello`, while still letting the
// worker idle out when the page is quiet (eager reconnect would defeat MV3's idle
// eviction and pin the worker alive forever).
//
// In-flight requests are NOT replayed — re-sending a sign request could
// double-sign. On disconnect the caller is notified (via `onDisconnect`) so the
// page can reject its in-flight promises; the dApp's own retry reconnects through
// `send()`.

import type { PortFrame, PortHello } from '../protocol/bridge';

// The subset of `chrome.runtime.Port` PortRelay needs. Abstracted so the relay is
// unit-testable with a fake port (the real one comes from webextension-polyfill).
export interface PortLike {
  postMessage(message: unknown): void;
  onMessage: { addListener(cb: (frame: PortFrame) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

export class PortRelay {
  private port: PortLike | null = null;

  constructor(
    private readonly connectFn: () => PortLike,
    private readonly onFrame: (frame: PortFrame) => void,
    private readonly onDisconnect: () => void,
    private readonly hello: () => PortHello
  ) {}

  // Establish (or re-establish) the port + register the origin. Returns null when
  // the extension context is gone (the extension was reloaded / updated) — the
  // orphaned content script can do nothing until the page reloads a fresh one.
  private connect(): PortLike | null {
    try {
      const p = this.connectFn();
      p.onMessage.addListener(this.onFrame);
      p.onDisconnect.addListener(() => {
        this.port = null; // reconnect lazily on the next send
        this.onDisconnect();
      });
      p.postMessage(this.hello());
      return p;
    } catch {
      // connectFn / the initial hello threw (extension context gone, or the port
      // closed during setup) — no live port. Wrap the whole setup so connect()
      // never throws.
      return null;
    }
  }

  // A live port, reconnecting if the previous one disconnected. Null only when the
  // extension context is invalidated.
  ensure(): PortLike | null {
    if (this.port === null) {
      this.port = this.connect();
    }
    return this.port;
  }

  // Forward a frame, (re)connecting first. Returns false iff no live port could be
  // established — the caller should fail the request fast, never drop it silently.
  send(message: unknown): boolean {
    const p = this.ensure();
    if (p === null) {
      return false;
    }
    try {
      p.postMessage(message);
    } catch {
      // The port closed between ensure() and here (no intervening onDisconnect);
      // drop it so the next send reconnects, and let the caller fail this request.
      this.port = null;
      return false;
    }
    return true;
  }
}
