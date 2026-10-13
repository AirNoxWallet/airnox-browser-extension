// Install the EIP-1193 provider (window.ethereum + the EIP-6963 announcement)
// onto the shared inpage transport. The single inpage entry (inpage.ts) builds
// the one transport and calls this; the testable routing / caching / event logic
// lives in evm_provider.ts, the postMessage wiring in transport.ts.

import { v4 as uuidv4 } from 'uuid';
import { AIRNOX_ICON_DATA_URI, AIRNOX_NAME, AIRNOX_RDNS } from './brand';
import { TouchReporter } from './activity';
import { AirNoxEvmProvider } from './evm_provider';
import { InjectedGlobals } from './held_globals';
import { Transport } from './transport';

// ── EIP-6963 multi-wallet discovery ──────────────────────────────────────────
function announceProvider(
  provider: AirNoxEvmProvider,
  onTouch: TouchReporter
): void {
  const info = {
    // uuid.v4 (not crypto.randomUUID) — this runs in the page's MAIN world,
    // including http:// pages where crypto.randomUUID is undefined (secure-context
    // gated); randomUUID would throw at announce time and break EIP-6963 discovery.
    uuid: uuidv4(),
    name: AIRNOX_NAME,
    // EIP-6963 requires a non-empty data-URI icon — some discovery UIs drop a
    // provider without one.
    icon: AIRNOX_ICON_DATA_URI,
    rdns: AIRNOX_RDNS,
  };
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({ info, provider }),
      })
    );
  // A dApp asking who is here is the modern discovery path, and the clearest
  // "this tab wants web3" there is — the unsolicited announce below is ours, not
  // the page's, so only the request counts as a touch.
  window.addEventListener('eip6963:requestProvider', () => {
    onTouch();
    announce();
  });
  announce();
}

export function installEvmProvider(
  transport: Transport,
  onTouch: TouchReporter,
  globals: InjectedGlobals
): void {
  const provider = new AirNoxEvmProvider(transport);
  // Legacy injection for dApps that read window.ethereum directly, alongside the
  // EIP-6963 announcement (the modern, conflict-free path). Defined only when no
  // other wallet or the browser defined it first, and given up to one that
  // redefines it later (held_globals.ts). The getter, not a value: `if
  // (window.ethereum)` is how a legacy dApp asks whether a wallet is installed,
  // and that read is the earliest signal that this tab wants web3 (activity.ts).
  globals.define('ethereum', provider, onTouch);
  announceProvider(provider, onTouch);
}
