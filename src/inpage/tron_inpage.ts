// Install the TRON shim (window.tronLink / window.tron / window.tronWeb) onto the
// shared inpage transport. The single inpage entry (inpage.ts) builds the one
// transport and calls this; the testable request routing / connect /
// defaultAddress logic lives in tron_provider.ts, the postMessage wiring in
// transport.ts.
//
// The shared transport holds a SET of event handlers (one per provider), so every
// provider hears every desktop push and filters by namespace — this shim handles
// only the `tron` ns — while responses resolve by request id, so the providers
// never cross.

import { TouchReporter } from './activity';
import { InjectedGlobals } from './held_globals';
import {
  AirNoxTronProvider,
  TronRequestArguments,
  TronTransaction,
} from './tron_provider';
import { Transport } from './transport';

type Listener = (...args: unknown[]) => void;

// Install at document_start, before the dApp's TronWeb / wallet adapter
// initialises. Each global is defined only if absent (another wallet that
// injected first keeps it) and can be redefined by a wallet whose script runs
// after ours (held_globals.ts). A getter, not a value: a TRON dApp discovers the
// wallet by reading the global (`if (window.tronWeb)`), so the read is this
// tab's "I want web3" signal (activity.ts).
export function installTronShim(
  transport: Transport,
  onTouch: TouchReporter,
  globals: InjectedGlobals
): void {
  const provider = new AirNoxTronProvider(transport);

  // window.tronWeb — the TronWeb-shaped shim. `ready` + `defaultAddress` are live
  // getters (a dApp reads them as properties); `trx` carries the signing +
  // broadcast methods dApps call. `.request` is the tron_requestAccounts proxy
  // TronLink adds to the injected tronWeb.
  const tronWeb = {
    get ready(): boolean {
      return provider.ready;
    },
    get defaultAddress() {
      return provider.defaultAddress();
    },
    trx: {
      signMessageV2(message: string | Uint8Array): Promise<string> {
        return provider.signMessageV2(message);
      },
      sign(transaction: TronTransaction): Promise<TronTransaction> {
        return provider.sign(transaction);
      },
      sendRawTransaction(signedTransaction: TronTransaction): Promise<unknown> {
        return provider.sendRawTransaction(signedTransaction);
      },
    },
    request(args: TronRequestArguments): Promise<unknown> {
      return provider.request(args);
    },
  };

  // window.tronLink — TronLink's connector object: the request entrypoint + the
  // tronWeb handle dApps reach through.
  const tronLink = {
    get ready(): boolean {
      return provider.ready;
    },
    request(args: TronRequestArguments): Promise<unknown> {
      return provider.request(args);
    },
    tronWeb,
  };

  // window.tron — the newer TIP-1193 provider (request + event subscription).
  // Delegates on/removeListener to the provider's emitter so a dApp can subscribe
  // to accountsChanged / connect.
  const tron = {
    request(args: TronRequestArguments): Promise<unknown> {
      return provider.request(args);
    },
    on(event: string, listener: Listener): void {
      provider.on(event, listener);
    },
    removeListener(event: string, listener: Listener): void {
      provider.removeListener(event, listener);
    },
  };

  globals.define('tronWeb', tronWeb, onTouch);
  globals.define('tronLink', tronLink, onTouch);
  globals.define('tron', tron, onTouch);
}
