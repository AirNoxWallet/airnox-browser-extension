// Collapse concurrent calls to one async factory into a SINGLE in-flight call,
// so every caller receives the same result.
//
// The bug this exists to prevent: the obvious cache
//
//   let cached: T | null = null;
//   async function get() { if (cached === null) { cached = await make(); } return cached; }
//
// checks the guard BEFORE an await and assigns AFTER it, so two callers that
// arrive in the same tick both see `null` and both run `make()`. When `make()`
// mints a fresh identity or opens a socket, the extension ends up with two of
// them and the last write wins — the classic double-checked-lock mistake in
// async clothing. Caching the PROMISE instead closes the window, because the
// assignment happens synchronously, before anything can interleave.
//
// A rejection is not cached: a transient failure must not poison every later
// call for the lifetime of the context. A resolved value IS cached until
// reset(), which is what an install-scoped identity or a live connection wants.
//
// Scope note: the cache lives in this closure, so it serialises callers within
// ONE JS context (the service worker), not across contexts (SW vs popup).
// Callers that need a value stable across contexts must persist it, and be the
// only context that creates it.

// Both members are declared `this: void`: they are arrow properties closing over
// the cache, never methods that read `this`, so a caller may detach them
// (`const getIid = flight.get`) without the usual unbound-method hazard. The
// annotation is what lets the type system agree.
export interface SingleFlight<T> {
  // Start the factory, or join the call already running / already finished.
  get(this: void): Promise<T>;
  // Forget the cached value so the next get() builds a fresh one. Used when the
  // inputs change (a new transport port makes the current client obsolete).
  reset(this: void): void;
}

export function singleFlight<T>(factory: () => Promise<T>): SingleFlight<T> {
  let inFlight: Promise<T> | null = null;
  // Arrow properties, so a caller may detach `flight.get` and pass it as a
  // plain function without losing the closure.
  return {
    get: (): Promise<T> => {
      if (inFlight === null) {
        inFlight = factory().catch((e: unknown) => {
          inFlight = null;
          throw e;
        });
      }
      return inFlight;
    },
    reset: (): void => {
      inFlight = null;
    },
  };
}
