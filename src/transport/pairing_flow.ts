// One pairing of this extension with the desktop app by a one-time code, from
// the pairing page's side. Two frames, both answered by the desktop:
//
//   begin   sys_pair_begin {epk, nc, origin?} -> {epk, ns}. The desktop opens
//           its code dialog once it answered (after its unlock window when
//           the wallet is locked).
//   submit  the person types the code; the check character is verified HERE,
//           so a typo costs nothing. Then sys_pair_finish {mac: our
//           confirmation} -> {mac: the desktop's}, answered only once the
//           desktop recorded the pairing. The desktop's confirmation is
//           verified before the derived secret is kept.
//
// One finish per begin, as the desktop allows one confirmation per code:
// whatever the finish's answer, the attempt is spent and "Try again" begins
// anew with a fresh ephemeral key (and, on the desktop, a fresh code). A
// refused code also closes the socket on the desktop's side; the next frame
// opens a new one.
//
// The transcript binds the instance id the frames carried, the port of the
// socket they went out on (both from the relay, never guessed here) and the
// DESKTOP's protocol version, read off the begin answer's envelope `v`.
//
// A desktop confirmation that does not verify is not a typo (the check
// character rules those out): something that is not the desktop the person
// reads the code from answered, so it is reported as a possible interception
// and nothing is kept.
//
// The derived secret is a non-extractable HMAC key from the first byte to the
// store (pair_handshake.ts); the code and the ephemeral key are dropped with
// the attempt. Nothing here logs.

import { PairRelayAnswer } from '../protocol/bridge';
import {
  ErrorCode,
  PairMethod,
  ProtocolVersion,
  SYS_PAIR_BEGIN,
  SYS_PAIR_FINISH,
  parseProtocolVersion,
} from '../protocol/envelope';
import { CodeVerdict, parseCode } from './pair_code';
import { fromBase64, toBase64 } from './wire_base64';
import {
  PAIR_PUBLIC_KEY_BYTES,
  PairEphemeral,
  derivePairKeys,
  generatePairEphemeral,
  isPairFramable,
  pairConfirmation,
  pairTranscriptHash,
  verifyPairConfirmation,
} from './pair_handshake';

const NONCE_BYTES = 16;
const MAC_BYTES = 32;
// The desktop refuses a longer origin hint; it is a label only, so an
// over-long one is left out rather than failing the pairing.
const ORIGIN_HINT_MAX_BYTES = 256;

export interface PairingDeps {
  // Send one pairing frame through the service worker. Rejects when the frame
  // never reached the desktop or no answer came back.
  relay(
    method: PairMethod,
    params: Record<string, string>
  ): Promise<PairRelayAnswer>;
  // Keep the derived secret for the instance id it was derived for.
  saveKey(iid: string, key: CryptoKey): Promise<void>;
  // Injected by the known-answer tests; generated otherwise.
  ephemeral?(): Promise<PairEphemeral>;
  nonce?(): Uint8Array;
}

// Why a pairing stopped. From the desktop's error codes:
//   malformed (1100)      a frame the desktop could not take, or a key it refused
//   busy (1101)           another pairing (or the connect prompt) is open there
//   cooldown (1002)       a pairing was just refused; a few seconds must pass
//   locked (1001)         the wallet is locked (or locked before the pairing
//                         was recorded)
//   unlock-skipped (4001) the person skipped the unlock window
//   unsupported (4200)    this desktop cannot pair by code
//   incompatible (1103)   the protocol versions are incompatible
//   refused (4100)        the code did not match, it expired, or the desktop
//                         has no attempt for this instance; its message says
//   desktop-error         anything else the desktop answered
// And from this side:
//   unreachable           the frame did not reach the desktop, or no answer came
//   bad-answer            an answer that is not the wire's shape, or a desktop
//                         key of small order
//   interception          the desktop's confirmation did not verify
//   connection-changed    the finish went out on another socket or instance
//   not-saved             paired, but the secret could not be stored
//   no-attempt            a code with no attempt to finish (begin first)
export const PAIRING_FAILURES = [
  'malformed',
  'busy',
  'cooldown',
  'locked',
  'unlock-skipped',
  'unsupported',
  'incompatible',
  'refused',
  'desktop-error',
  'unreachable',
  'bad-answer',
  'interception',
  'connection-changed',
  'not-saved',
  'no-attempt',
] as const;
export type PairingFailure = (typeof PAIRING_FAILURES)[number];

export type PairingOutcome =
  | { kind: 'enter-code' }
  | { kind: 'bad-code'; reason: Exclude<CodeVerdict, 'ok'> }
  | { kind: 'paired' }
  | { kind: 'failed'; failure: PairingFailure; message?: string };

// What a begin leaves for the finish.
interface Attempt {
  iid: string;
  port: number;
  version: ProtocolVersion;
  own: PairEphemeral;
  clientNonce: Uint8Array;
  serverPublic: Uint8Array;
  serverNonce: Uint8Array;
}

const BEGIN_FAILURES: Partial<Record<number, PairingFailure>> = {
  [ErrorCode.MalformedRequest]: 'malformed',
  [ErrorCode.RequestPending]: 'busy',
  [ErrorCode.NotPaired]: 'cooldown',
  [ErrorCode.WalletLocked]: 'locked',
  [ErrorCode.UserRejected]: 'unlock-skipped',
  [ErrorCode.UnsupportedMethod]: 'unsupported',
  [ErrorCode.VersionIncompatible]: 'incompatible',
};

const FINISH_FAILURES: Partial<Record<number, PairingFailure>> = {
  [ErrorCode.MalformedRequest]: 'malformed',
  [ErrorCode.Unauthorized]: 'refused',
  [ErrorCode.WalletLocked]: 'locked',
  [ErrorCode.UnsupportedMethod]: 'unsupported',
  [ErrorCode.VersionIncompatible]: 'incompatible',
};

const failed = (failure: PairingFailure, message?: string): PairingOutcome =>
  message === undefined
    ? { kind: 'failed', failure }
    : { kind: 'failed', failure, message };

const errorOutcome = (
  answer: PairRelayAnswer,
  table: Partial<Record<number, PairingFailure>>
): PairingOutcome => {
  const err = answer.response.error;
  const code = typeof err?.code === 'number' ? err.code : undefined;
  const message = typeof err?.message === 'string' ? err.message : undefined;
  return failed(
    (code !== undefined ? table[code] : undefined) ?? 'desktop-error',
    message
  );
};

const resultField = (answer: PairRelayAnswer, key: string): unknown => {
  const r = answer.response.result;
  return typeof r === 'object' && r !== null
    ? (r as Record<string, unknown>)[key]
    : undefined;
};

export class PairingFlow {
  private attempt: Attempt | undefined;

  constructor(private readonly deps: PairingDeps) {}

  // Start (or start over): a fresh ephemeral key and nonce, sys_pair_begin, and
  // the desktop's half of the exchange kept for submit(). `origin` names the
  // dApp whose connect asked for the pairing, a label hint for the desktop's
  // dialog. Never rejects.
  async begin(origin?: string): Promise<PairingOutcome> {
    this.attempt = undefined;
    const own = await (this.deps.ephemeral ?? generatePairEphemeral)();
    const clientNonce =
      this.deps.nonce?.() ??
      crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const params: Record<string, string> = {
      epk: toBase64(own.publicKey),
      nc: toBase64(clientNonce),
    };
    if (
      origin !== undefined &&
      new TextEncoder().encode(origin).length <= ORIGIN_HINT_MAX_BYTES
    ) {
      params.origin = origin;
    }
    let answer: PairRelayAnswer;
    try {
      answer = await this.deps.relay(SYS_PAIR_BEGIN, params);
    } catch {
      return failed('unreachable');
    }
    if (!answer.response.ok) {
      return errorOutcome(answer, BEGIN_FAILURES);
    }
    const serverPublic = fromBase64(
      resultField(answer, 'epk'),
      PAIR_PUBLIC_KEY_BYTES
    );
    const serverNonce = fromBase64(resultField(answer, 'ns'), NONCE_BYTES);
    const version = parseProtocolVersion(answer.response.v);
    if (!serverPublic || !serverNonce || version === null) {
      return failed('bad-answer');
    }
    const attempt: Attempt = {
      iid: answer.iid,
      port: answer.port,
      version,
      own,
      clientNonce,
      serverPublic,
      serverNonce,
    };
    // An instance id, port or version that cannot be framed cannot be the
    // desktop's: refuse it now rather than after the person typed the code.
    if (!isPairFramable(this.exchangeOf(attempt))) {
      return failed('bad-answer');
    }
    this.attempt = attempt;
    return { kind: 'enter-code' };
  }

  // The person's code. A refused code (character, length, check) leaves the
  // attempt as it was; anything that reaches the desktop spends it. Never
  // rejects.
  async submit(typed: string): Promise<PairingOutcome> {
    const attempt = this.attempt;
    if (attempt === undefined) {
      return failed('no-attempt');
    }
    const parsed = await parseCode(typed);
    if (parsed.verdict !== 'ok') {
      return { kind: 'bad-code', reason: parsed.verdict };
    }
    this.attempt = undefined;
    const th = await pairTranscriptHash(this.exchangeOf(attempt));
    const keys = await derivePairKeys(
      attempt.own.privateKey,
      attempt.serverPublic,
      parsed.code,
      th
    );
    if (keys === null) {
      return failed('bad-answer');
    }
    const mac = await pairConfirmation(keys.confirm, 'client', th);
    let answer: PairRelayAnswer;
    try {
      answer = await this.deps.relay(SYS_PAIR_FINISH, { mac: toBase64(mac) });
    } catch {
      return failed('unreachable');
    }
    if (answer.iid !== attempt.iid || answer.port !== attempt.port) {
      return failed('connection-changed');
    }
    if (!answer.response.ok) {
      return errorOutcome(answer, FINISH_FAILURES);
    }
    const srv = fromBase64(resultField(answer, 'mac'), MAC_BYTES);
    if (!srv) {
      return failed('bad-answer');
    }
    if (!(await verifyPairConfirmation(keys.confirm, 'server', th, srv))) {
      return failed('interception');
    }
    try {
      await this.deps.saveKey(attempt.iid, keys.secret);
    } catch {
      return failed('not-saved');
    }
    return { kind: 'paired' };
  }

  private exchangeOf(a: Attempt) {
    return {
      bind: {
        iid: a.iid,
        clientNonce: a.clientNonce,
        serverNonce: a.serverNonce,
        port: a.port,
        version: a.version,
      },
      clientPublic: a.own.publicKey,
      serverPublic: a.serverPublic,
    };
  }
}
