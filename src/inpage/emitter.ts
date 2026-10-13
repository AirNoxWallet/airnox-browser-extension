// A tiny event emitter for the EIP-1193 provider's events (connect / disconnect
// / accountsChanged / chainChanged / message). Avoids pulling node's `events`
// shim into the main-world bundle.

type Listener = (...args: unknown[]) => void;

// A once()-wrapper carries the original listener so removeListener / off can
// find and drop it before it fires (standard EventEmitter semantics).
interface OnceWrapper extends Listener {
  __airnoxOriginal?: Listener;
}

export class Emitter {
  private listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  // EIP-1193 / EventEmitter: a one-shot listener that removes itself after the
  // first emit. Removable via removeListener / off with the ORIGINAL listener
  // reference (the dApp never sees the wrapper).
  once(event: string, listener: Listener): this {
    const wrapper: OnceWrapper = (...args: unknown[]) => {
      this.removeListener(event, wrapper);
      listener(...args);
    };
    wrapper.__airnoxOriginal = listener;
    return this.on(event, wrapper);
  }

  removeListener(event: string, listener: Listener): this {
    const set = this.listeners.get(event);
    if (!set) {
      return this;
    }
    for (const l of [...set]) {
      // Direct match, OR a once()-wrapper whose original is this listener.
      if (l === listener || (l as OnceWrapper).__airnoxOriginal === listener) {
        set.delete(l);
      }
    }
    return this;
  }

  // EIP-1193 / EventEmitter alias for removeListener. Many dApp libraries call
  // provider.off(...) — its absence threw a TypeError and broke them.
  off(event: string, listener: Listener): this {
    return this.removeListener(event, listener);
  }

  emit(event: string, ...args: unknown[]): boolean {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) {
      return false;
    }
    for (const listener of [...set]) {
      try {
        listener(...args);
      } catch {
        // A listener throwing must not break the emit loop or other listeners.
      }
    }
    return true;
  }
}
