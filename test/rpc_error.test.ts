import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode } from '../src/protocol/envelope';
import {
  friendlyErrorMessage,
  isUnauthorized,
  rpcError,
} from '../src/inpage/rpc_error';

test('friendlyErrorMessage rewrites NotPaired into an actionable message', () => {
  const msg = friendlyErrorMessage(
    ErrorCode.NotPaired,
    'extension instance is not paired' // the desktop's terse wire message
  );
  // It guides the user to the desktop pairing prompt, not the raw wire string.
  assert.notEqual(msg, 'extension instance is not paired');
  assert.match(msg, /pairing/i);
  assert.match(msg, /desktop/i);
});

test('friendlyErrorMessage humanises WalletLocked into an unlock prompt', () => {
  const msg = friendlyErrorMessage(ErrorCode.WalletLocked, 'wallet is locked');
  // The TON path reports locked / unpaired / version all as UNKNOWN_ERROR (0),
  // so the message is the dApp's only disambiguator — it must be actionable.
  assert.notEqual(msg, 'wallet is locked');
  assert.match(msg, /unlock/i);
  assert.match(msg, /desktop/i);
});

test('friendlyErrorMessage humanises VersionIncompatible into an update prompt', () => {
  const msg = friendlyErrorMessage(
    ErrorCode.VersionIncompatible,
    'protocol version mismatch'
  );
  assert.notEqual(msg, 'protocol version mismatch');
  assert.match(msg, /version/i);
  assert.match(msg, /update/i);
});

test('friendlyErrorMessage keeps the desktop message for non-specialised codes', () => {
  // Internal / a transport code we do not rewrite → verbatim.
  assert.equal(friendlyErrorMessage(ErrorCode.Internal, 'boom'), 'boom');
  assert.equal(
    friendlyErrorMessage(ErrorCode.AddressNotEligible, 'not eligible'),
    'not eligible'
  );
  // An unknown numeric code falls through to the fallback too.
  assert.equal(friendlyErrorMessage(9999, 'request failed'), 'request failed');
});

test('isUnauthorized recognises only the 4100 refusal', () => {
  const withCode = (code: unknown): Error =>
    Object.assign(new Error('x'), { code });
  assert.equal(isUnauthorized(withCode(ErrorCode.Unauthorized)), true);
  assert.equal(isUnauthorized(rpcError(ErrorCode.Unauthorized, 'x')), true);
  for (const code of [
    ErrorCode.UserRejected,
    ErrorCode.Disconnected,
    ErrorCode.WalletLocked,
    ErrorCode.NotPaired,
    ErrorCode.Internal,
    '4100', // a string is not the wire code
    undefined,
  ]) {
    assert.equal(isUnauthorized(withCode(code)), false, String(code));
  }
  assert.equal(isUnauthorized(new Error('no code')), false);
  assert.equal(isUnauthorized(null), false);
  assert.equal(isUnauthorized(undefined), false);
  assert.equal(isUnauthorized('4100'), false);
});
