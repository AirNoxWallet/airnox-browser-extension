// Posting SW -> content over a runtime port, made safe against a port whose page
// disconnected while a request was in flight. Kept in its own module (no browser
// side effects) so it is unit-tested — background.ts itself is not importable in
// a test because it wires listeners at module load.

import { PortEvent, PortResult } from '../protocol/bridge';

// The frames the SW sends to a content port: a request result or a pushed event.
export type OutboundFrame = PortResult | PortEvent;

// The one Port capability postToPort needs. `browser.Runtime.Port` satisfies it
// structurally; narrowing it here keeps the helper testable with a plain stub.
export interface PortPoster {
  postMessage(frame: OutboundFrame): void;
}

// Post a frame to a content port, tolerating a port that disconnected while the
// request was in flight. When the tab/page is gone, chrome throws "Attempting to
// use a disconnected port object" and there is nothing to deliver. A disconnected
// port is the ONLY expected failure — every frame the SW builds is serializable —
// so swallowing it here stops a lost tab from becoming an unhandled rejection:
// handleRpc runs as `void handleRpc(...)`, and its catch block also writes the
// port, so an unguarded throw on the reply path escapes as a rejection.
export function postToPort(port: PortPoster, frame: OutboundFrame): void {
  try {
    port.postMessage(frame);
  } catch {
    // The port's page is gone; drop the frame.
  }
}
