// An EIP-1193 ProviderRpcError: a plain Error carrying the numeric `code` (and
// optional `data`) dApps inspect. Shared by the provider (local validation) and
// the transport (surfacing the desktop's wire error verbatim).

import { ErrorCode } from '../protocol/envelope';

export interface ProviderRpcError extends Error {
  code: number;
  data?: unknown;
}

export function rpcError(
  code: number,
  message: string,
  data?: unknown
): ProviderRpcError {
  const err = new Error(message) as ProviderRpcError;
  err.code = code;
  if (data !== undefined) {
    err.data = data;
  }
  return err;
}

// Is this rejection the desktop refusing to act for this origin on the chain it
// was asked on (Unauthorized, 4100)? The desktop answers 4100 from its grant
// gates alone — the origin is not connected on the chain, or the address is not
// among its granted-and-eligible accounts — so it is the page's one signal that
// accounts a provider cached at connect are no longer the desktop's answer (a
// device wallet's grants live for the desktop's session only, so a desktop
// restart ends them while a tab stays open). Every other code — a disconnect, a
// user rejection, a locked or unpaired wallet — says nothing about the grant.
export function isUnauthorized(e: unknown): boolean {
  return (
    (e as Partial<ProviderRpcError> | null | undefined)?.code ===
    ErrorCode.Unauthorized
  );
}

// Turn a wire error into a human-actionable message for the dApp (and, through
// it, the user). The desktop sends a terse internal string for some wallet-side
// codes a dApp surfaces verbatim, so we specialise the wallet-state codes whose
// remedy is a specific user action in the desktop app. This matters most on the
// TON Connect path: its error enum has no code for locked / unpaired / version
// states, so the bridge reports them all as UNKNOWN_ERROR (0) and the message is
// the dApp's ONLY disambiguator (the EVM path also keeps the distinct 1xxx code).
// Codes we do not specialise keep the desktop's own `fallback` message. Pure (no
// I/O) so the transport that applies it stays trivial wiring and this stays
// unit-testable.
export function friendlyErrorMessage(code: number, fallback: string): string {
  // A wire code is any number; the enum names only the ones specialised here.
  /* eslint-disable @typescript-eslint/no-unsafe-enum-comparison */
  switch (code) {
    case ErrorCode.NotPaired:
      return (
        'This browser is not paired with AirNox Wallet. Pair it in the AirNox ' +
        "pairing window or from the Pairing row of the AirNox extension's " +
        'popup, type the code the AirNox Wallet desktop app shows, then try ' +
        'again.'
      );
    case ErrorCode.WalletLocked:
      return (
        'AirNox Wallet is locked. Unlock the AirNox Wallet desktop app, then try ' +
        'again.'
      );
    case ErrorCode.VersionIncompatible:
      return (
        'The AirNox extension and the AirNox Wallet desktop app are on ' +
        'incompatible versions. Update both to the latest version, then try again.'
      );
    default:
      return fallback;
  }
  /* eslint-enable @typescript-eslint/no-unsafe-enum-comparison */
}
