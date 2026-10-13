// Shared "the desktop must return a string" guards for the inpage providers. A
// value the extension hands to a dApp (a signature, a serialized transaction, …)
// that comes back non-string from the desktop is an internal contract breach —
// fail loud with Internal rather than coerce it into a silently-wrong value.
// Used by the EVM-family (Tron) and the Wallet-Standard (Solana / Sui) providers.

import { ErrorCode } from '../protocol/envelope';
import { rpcError } from './rpc_error';

// Assert a bare desktop result is a string. `what` names the value in the error
// (e.g. "signature", "transaction"); it defaults to "result".
export function expectString(
  value: unknown,
  method: string,
  what = 'result'
): string {
  if (typeof value !== 'string') {
    throw rpcError(
      ErrorCode.Internal,
      `${method}: the wallet returned a non-string ${what}`
    );
  }
  return value;
}

// Assert a named field of an object result is a string (the Wallet-Standard sign
// replies are `{ bytes, signature, … }`). A non-object result or a non-string
// field is a contract breach.
export function expectStringField(
  result: unknown,
  field: string,
  method: string
): string {
  if (typeof result !== 'object' || result === null) {
    throw rpcError(
      ErrorCode.Internal,
      `${method}: the wallet returned a non-object result`
    );
  }
  return expectString(
    (result as Record<string, unknown>)[field],
    method,
    `'${field}'`
  );
}
