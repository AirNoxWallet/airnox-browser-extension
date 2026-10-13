// Install the TON Connect bridge (window.airnox.tonconnect) onto the shared
// inpage transport. The single inpage entry (inpage.ts) builds the one transport
// and calls this; the testable routing / mapping / event logic lives in
// tonconnect_bridge.ts, the postMessage wiring in transport.ts.
//
// The shared transport holds a SET of event handlers (one per provider), so every
// provider hears every desktop push and filters by namespace — this bridge
// handles only the `tonconnect` ns — while responses resolve by request id, so
// the providers never cross.

import { TouchReporter } from './activity';
import { InjectedGlobals } from './held_globals';
import { AirNoxTonConnectBridge } from './tonconnect_bridge';
import { Transport } from './transport';

// The dApp-discovery key: @tonconnect/sdk reads window[jsBridgeKey].tonconnect.
// Shares the brand stem with the EVM identity (EIP-6963 rdns 'app.airnox')
// and matches the repo name.
const JS_BRIDGE_KEY = 'airnox' as const;

export function installTonConnect(
  transport: Transport,
  onTouch: TouchReporter,
  globals: InjectedGlobals
): void {
  const bridge = new AirNoxTonConnectBridge(transport);
  // Install at document_start. The SDK reads the property on demand (there is no
  // announce event: TON Connect discovery is pure property presence), so the
  // bridge must be present synchronously before the dApp's SDK initialises. A
  // getter, not a value: the property read IS the discovery, so it is the only
  // touch this bridge can report before a request (activity.ts).
  globals.define(JS_BRIDGE_KEY, { tonconnect: bridge }, onTouch);
}
