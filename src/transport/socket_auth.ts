// The socket handshake, from the extension's side: one run of sys_auth_begin /
// sys_auth_finish on a freshly opened socket, with the key a pairing by code
// left in this browser (auth_handshake.ts holds the transcript and the MACs).
//
//   begin   sys_auth_begin {nc, origin?} -> {ns, mac}: the desktop's nonce and
//           its proof over the transcript, tag "srv". The proof is checked
//           HERE, before anything of ours goes out: a proof that does not
//           verify means something other than the paired desktop answered on
//           the port we dialled, so the extension's proof is never sent to it.
//   finish  sys_auth_finish {mac} -> {authenticated: true}: our proof, tag
//           "cli".
//
// The transcript binds the instance id of the socket, the port it was dialled
// on (the caller's, never read off an answer) and the DESKTOP's protocol
// version, read off the begin answer's envelope `v`.
//
// Three ways it ends:
//   authenticated  both proofs verified; the caller may now bind the socket.
//   refused        the desktop declined before any proof was spent (locked, the
//                  person skipped the unlock window, it holds no secret for this
//                  instance, an incompatible version...). The socket stays open
//                  and unbound, so a pairing or a later begin can run on it.
//   failed         the socket is no good for this pairing: the desktop's proof
//                  did not verify (a possible interception), the desktop refused
//                  ours, or an answer was not the wire's shape. The caller
//                  closes the socket and binds nothing.
//
// Pure: the caller injects the round trip on its socket. Nothing here logs.

import {
  ErrorCode,
  Response,
  SYS_AUTH_BEGIN,
  SYS_AUTH_FINISH,
  AuthMethod,
  WireError,
  parseProtocolVersion,
} from '../protocol/envelope';
import {
  AUTH_MAC_BYTES,
  AuthExchange,
  computeMac,
  isFramable,
  verifyMac,
} from './auth_handshake';
import { fromBase64, toBase64 } from './wire_base64';

const NONCE_BYTES = 16;
// The desktop refuses a longer origin (a string of at most 256 characters); the
// extension counts UTF-8 bytes, which is never fewer.
const ORIGIN_MAX_BYTES = 256;

export interface HandshakeDeps {
  // One frame on the socket being authenticated, answered by its rid. Rejects
  // when the socket closed or no answer came in time.
  request(
    method: AuthMethod,
    params: Record<string, string>
  ): Promise<Response>;
  // The pairing key of this instance (auth_key_store.ts).
  key: CryptoKey;
  // The instance id the socket presented, and the port it was dialled on.
  iid: string;
  port: number;
  // The dApp whose request waits on this handshake; absent when the extension
  // authenticates a socket on its own.
  origin?: string;
  // Injected by the tests; random otherwise.
  nonce?(): Uint8Array;
}

export type HandshakeFailure = 'interception' | 'proof-refused' | 'bad-answer';

// Why the desktop declined: locked (1001), not-paired (1002: it holds no secret
// for this instance), unlock-skipped (4001), desktop-error (1102: it knows no
// port), unsupported (4200: it cannot authenticate sockets), incompatible
// (1103).
export type RefusalReason =
  | 'locked'
  | 'not-paired'
  | 'unlock-skipped'
  | 'desktop-error'
  | 'unsupported'
  | 'incompatible';

export type HandshakeOutcome =
  | { kind: 'authenticated' }
  | { kind: 'refused'; reason: RefusalReason; error: WireError }
  | { kind: 'failed'; failure: HandshakeFailure; error?: WireError };

// The begin refusals that leave the socket usable: the desktop's handshake
// never started. Any other refusal (a malformed frame, a socket that already
// began or bound) means the two sides disagree about this socket.
const BEGIN_REFUSALS: Partial<Record<number, RefusalReason>> = {
  [ErrorCode.WalletLocked]: 'locked',
  [ErrorCode.NotPaired]: 'not-paired',
  [ErrorCode.UserRejected]: 'unlock-skipped',
  [ErrorCode.Internal]: 'desktop-error',
  [ErrorCode.UnsupportedMethod]: 'unsupported',
  [ErrorCode.VersionIncompatible]: 'incompatible',
};

// The finish refusals that leave the socket usable: the wallet locked, or the
// instance was unpaired, while our proof was on its way. The desktop's nonce is
// spent; a later begin starts over on the same socket.
const FINISH_REFUSALS: Partial<Record<number, RefusalReason>> = {
  [ErrorCode.WalletLocked]: 'locked',
  [ErrorCode.NotPaired]: 'not-paired',
};

// The finish failure the desktop names: our proof did not verify (it closes the
// socket). Anything else it refuses there is a frame it could not take.
const FINISH_FAILURES: Partial<Record<number, HandshakeFailure>> = {
  [ErrorCode.Unauthorized]: 'proof-refused',
};

const errorOf = (r: Response): WireError => ({
  code: typeof r.error?.code === 'number' ? r.error.code : ErrorCode.Internal,
  message: typeof r.error?.message === 'string' ? r.error.message : '',
});

const resultField = (r: Response, key: string): unknown =>
  typeof r.result === 'object' && r.result !== null
    ? (r.result as Record<string, unknown>)[key]
    : undefined;

// Run one handshake. Resolves with its outcome; rejects only when a round trip
// did (the socket closed, or no answer came in time).
export async function authenticate(
  deps: HandshakeDeps
): Promise<HandshakeOutcome> {
  const clientNonce =
    deps.nonce?.() ?? crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const params: Record<string, string> = { nc: toBase64(clientNonce) };
  if (
    deps.origin !== undefined &&
    deps.origin !== '' &&
    new TextEncoder().encode(deps.origin).length <= ORIGIN_MAX_BYTES
  ) {
    params.origin = deps.origin;
  }
  const begun = await deps.request(SYS_AUTH_BEGIN, params);
  if (!begun.ok) {
    const error = errorOf(begun);
    const reason = BEGIN_REFUSALS[error.code];
    return reason !== undefined
      ? { kind: 'refused', reason, error }
      : { kind: 'failed', failure: 'bad-answer', error };
  }
  const serverNonce = fromBase64(resultField(begun, 'ns'), NONCE_BYTES);
  const serverMac = fromBase64(resultField(begun, 'mac'), AUTH_MAC_BYTES);
  const version = parseProtocolVersion(begun.v);
  if (!serverNonce || !serverMac || version === null) {
    return { kind: 'failed', failure: 'bad-answer' };
  }
  const ex: AuthExchange = {
    iid: deps.iid,
    clientNonce,
    serverNonce,
    port: deps.port,
    version,
  };
  if (!isFramable(ex)) {
    return { kind: 'failed', failure: 'bad-answer' };
  }
  if (!(await verifyMac(deps.key, 'server', ex, serverMac))) {
    return { kind: 'failed', failure: 'interception' };
  }
  const mac = await computeMac(deps.key, 'client', ex);
  const finished = await deps.request(SYS_AUTH_FINISH, {
    mac: toBase64(mac),
  });
  if (!finished.ok) {
    const error = errorOf(finished);
    const reason = FINISH_REFUSALS[error.code];
    if (reason !== undefined) {
      return { kind: 'refused', reason, error };
    }
    return {
      kind: 'failed',
      failure: FINISH_FAILURES[error.code] ?? 'bad-answer',
      error,
    };
  }
  if (resultField(finished, 'authenticated') !== true) {
    return { kind: 'failed', failure: 'bad-answer' };
  }
  return { kind: 'authenticated' };
}
