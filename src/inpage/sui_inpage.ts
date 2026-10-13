// Install the Sui Wallet-Standard adapter (via wallet-standard:register-wallet)
// onto the shared inpage transport. The single inpage entry (inpage.ts) builds
// the one transport and calls this; the testable Wallet object / connect /
// shaping / sign logic lives in sui_wallet.ts, the postMessage wiring in
// transport.ts.
//
// The shared transport holds a SET of event handlers (one per provider), so every
// provider hears every desktop push and filters by namespace and — since Sui and
// Solana share the wstd namespace — by chain URN, while responses resolve by
// request id, so the providers never cross.

import { AirNoxSuiWallet } from './sui_wallet';
import { TouchReporter } from './activity';
import { registerWallet } from './wallet_standard';
import { Transport } from './transport';

export function installSuiWallet(
  transport: Transport,
  onTouch: TouchReporter
): void {
  // Register at document_start. Wallet-Standard discovery is event-driven (the
  // wallet dispatches register-wallet + answers app-ready), so the wallet must be
  // constructed + registered synchronously before the dApp's wallet-adapter
  // initialises.
  registerWallet(new AirNoxSuiWallet(transport), onTouch);
}
