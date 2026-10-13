// The v2 wire protocol the extension speaks to the desktop signer over the
// loopback WebSocket. This mirrors the desktop wallet's protocol definitions —
// the field names + the version + the namespaces + the error codes must match
// byte-for-byte. The desktop strictly validates every frame (no fallbacks), so
// the extension must produce exactly this shape.

// The semantic protocol version: wallet.major.minor (currently "2.3.1"). Mirrors the
// desktop wallet's protocol version.
//   * wallet — AirNox Wallet product line (2); a different line is incompatible.
//   * major  — bumped on a BREAKING change; a different major is incompatible.
//   * minor  — a capability BITMASK (each bit an optional, backward-compatible
//              feature). NEVER affects compatibility; only the common feature set
//              (minor_a & minor_b).
export interface ProtocolVersion {
  wallet: number;
  major: number;
  minor: number;
}

// major 3 (was 2): every socket must authenticate. Before sys_auth_finish has
// verified, the desktop serves only sys_ping, the pairing frames and the
// handshake; anything else is refused (4100) and binds nothing. A browser with
// no pairing key, or one the desktop holds no secret for (paired before
// secrets existed, or reset in its settings), pairs again once by code, on
// that same socket.
// major 2 (was 1): mhda 1.1 changed the chain-key grammar to
// `nt:<network>:ci:<chain_id>` — a BREAKING wire change (every chain-scoped
// frame's `chain` field, and `Event.chain`, changed meaning).
// The two sides ship each major in lockstep, so a stale peer is refused with
// VersionIncompatible (1103) and the correct update-side prompt, not
// misleading connect/permission errors.
// Minor capability bits. CAP_HELD_SESSIONS: the extension resumes the desktop's
// held dApp sessions with sys_resume on every new socket.
export const CAP_HELD_SESSIONS = 1;

export const WEB3_PROTOCOL_VERSION: ProtocolVersion = {
  wallet: 2,
  major: 3,
  minor: CAP_HELD_SESSIONS,
};

// Same wallet line + same major → compatible (minor never gates).
export const isVersionCompatible = (
  a: ProtocolVersion,
  b: ProtocolVersion
): boolean => a.wallet === b.wallet && a.major === b.major;

// Lexicographic (wallet, major) order — minor is ignored (it does not order
// compatibility). Decides which side the user is asked to update.
export const isVersionOlder = (
  a: ProtocolVersion,
  b: ProtocolVersion
): boolean =>
  a.wallet < b.wallet || (a.wallet === b.wallet && a.major < b.major);

// Render "wallet.major.minor" for prompts / logs.
export const formatVersion = (v: ProtocolVersion): string =>
  `${v.wallet}.${v.major}.${v.minor}`;

// Parse a wire version object → ProtocolVersion, or null if it is not three
// integers (minor non-negative). Strict: no coercion, no partial objects.
export const parseProtocolVersion = (raw: unknown): ProtocolVersion | null => {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const { wallet, major, minor } = raw as Record<string, unknown>;
  if (
    typeof wallet === 'number' &&
    Number.isInteger(wallet) &&
    typeof major === 'number' &&
    Number.isInteger(major) &&
    typeof minor === 'number' &&
    Number.isInteger(minor) &&
    minor >= 0
  ) {
    return { wallet, major, minor };
  }
  return null;
};

// The compatibility verdict between THIS extension and the desktop it reached.
// On a major mismatch it names which side the user must update: the extension is
// OLDER → update the extension; NEWER → update the desktop app.
export type VersionVerdict =
  | { compatible: true; desktop: ProtocolVersion }
  | {
      compatible: false;
      updateSide: 'extension' | 'desktop';
      desktop: ProtocolVersion;
    };

export const checkVersion = (desktop: ProtocolVersion): VersionVerdict => {
  if (isVersionCompatible(WEB3_PROTOCOL_VERSION, desktop)) {
    return { compatible: true, desktop };
  }
  const updateSide = isVersionOlder(WEB3_PROTOCOL_VERSION, desktop)
    ? 'extension'
    : 'desktop';
  return { compatible: false, updateSide, desktop };
};

// The dApp-facing message for a protocol incompatibility — names the side to
// update so the failure is actionable, not just "disconnected".
export function versionErrorMessage(verdict: VersionVerdict): string {
  if (verdict.compatible) {
    return '';
  }
  const desktop = formatVersion(verdict.desktop);
  return verdict.updateSide === 'extension'
    ? `The AirNox extension is out of date for this desktop (desktop ${desktop}). Update the extension.`
    : `AirNox Wallet desktop is out of date for this extension (desktop ${desktop}). Update the desktop app.`;
}

// The loopback transport endpoint. The desktop server binds 127.0.0.1 only and
// listens on /rpc; the `iid` query param IS the handshake (a persisted UUIDv4,
// exactly 36 chars) and must equal every frame's `iid`. The port is the user's
// configured web3 port (default 8114).
export const DEFAULT_WS_PORT = 8114 as const;
export const wsUrl = (iid: string, port: number = DEFAULT_WS_PORT): string =>
  `ws://127.0.0.1:${port}/rpc?iid=${iid}`;

// The loopback ports the AUTO transport mode probes, in order. MUST stay in sync
// with the desktop's own list — the SW
// sys_ping-probes each and uses the first that answers as a v2 AirNox server. The
// desktop binds the first of these it can; we scan the same list to find it.
export const WEB3_AUTO_PORTS = [8114, 8274, 18114, 48114] as const;

// Read the desktop's reported version from a sys_ping `result`, or null if the
// reply does not carry a valid version object — i.e. it is NOT an AirNox server.
export const readDesktopVersion = (result: unknown): ProtocolVersion | null => {
  if (typeof result !== 'object' || result === null) {
    return null;
  }
  return parseProtocolVersion(
    (result as Record<string, unknown>).protocol_version
  );
};

// The desktop SESSION a sys_ping `result` names (`desktop_session`): 32 lowercase hex minted once per
// desktop dispatcher, so a different value means the desktop restarted. Absent or malformed reads as unknown (an
// older desktop) — and an unknown session must make a caller forget nothing.
export const readDesktopSession = (result: unknown): string | undefined => {
  if (typeof result !== 'object' || result === null) {
    return undefined;
  }
  const session = (result as Record<string, unknown>).desktop_session;
  return typeof session === 'string' && DESKTOP_SESSION_RE.test(session)
    ? session
    : undefined;
};
const DESKTOP_SESSION_RE = /^[0-9a-f]{32}$/;

// A sys_resume `result`: the secret the NEXT socket resumes with (32 bytes,
// lowercase hex) and whether this one kept the sessions the instance held.
// undefined for anything else (an older desktop answers UnsupportedMethod).
export type ResumeResult = { resume: string; restored: boolean };
export const readResumeResult = (result: unknown): ResumeResult | undefined => {
  if (typeof result !== 'object' || result === null) {
    return undefined;
  }
  const r = result as Record<string, unknown>;
  return typeof r.resume === 'string' &&
    RESUME_SECRET_RE.test(r.resume) &&
    typeof r.restored === 'boolean'
    ? { resume: r.resume, restored: r.restored }
    : undefined;
};
const RESUME_SECRET_RE = /^[0-9a-f]{64}$/;

// Does a sys_ping `result` identify an AirNox Wallet desktop (ANY version)? The AUTO-mode
// probe uses this to reject a non-AirNox listener squatting on a candidate port (a
// WS open alone proves only "something listens here"). A version-incompatible
// AirNox server still answers true here — it IS AirNox; the major-compatibility
// check (isVersionCompatible) is a separate decision so the user is told to
// update rather than left scanning.
export const isAirNoxSysPingResult = (result: unknown): boolean =>
  readDesktopVersion(result) !== null;

// The wallet's lock state, as the desktop reports it in a sys_ping `result`
// (`wallet_status`). The desktop is the authority; an absent or unrecognised
// value means "unknown", never a guess — a caller must not claim "ready to sign"
// without an explicit 'unlocked'.
export type WalletStatus = 'locked' | 'unlocked';

// The five namespaces the desktop dispatcher recognises.
export type Namespace = 'sys' | 'evm' | 'wstd' | 'tonconnect' | 'tron';

// The namespaces a web page is allowed to address. `sys` is deliberately
// excluded: it is the extension<->desktop control plane (pairing-exempt methods
// like sys_ping), so letting a page reach it would be an unauthenticated
// wallet-status / version / install oracle. This is the SSOT allowlist — the
// content script gates on it at the page->SW seam and the SW re-checks it as
// defense-in-depth. A page frame outside this set is refused (fail closed).
export const DAPP_NAMESPACES = ['evm', 'wstd', 'tonconnect', 'tron'] as const;
export type DappNamespace = (typeof DAPP_NAMESPACES)[number];

// Narrow an untrusted (page-supplied) value to a namespace a page may address.
export function isDappNamespace(ns: unknown): ns is DappNamespace {
  return (
    typeof ns === 'string' &&
    (DAPP_NAMESPACES as readonly string[]).includes(ns)
  );
}

// The two frames that pair this extension with the desktop by a one-time code,
// named as the desktop names them. Both are
// `sys` frames with an empty origin, answered before any pairing exists:
//   * sys_pair_begin  {epk, nc, origin?} -> {epk, ns}: the X25519 public keys
//     (32 bytes) and nonces (16 bytes) of each side; `origin` is a label hint of
//     at most 256 bytes. The desktop shows the code after it answered.
//   * sys_pair_finish {mac} -> {mac}: the extension's key confirmation, then
//     the desktop's, sent only once the desktop recorded the pairing.
// Every byte string is standard base64 with padding.
export const SYS_PAIR_BEGIN = 'sys_pair_begin' as const;
export const SYS_PAIR_FINISH = 'sys_pair_finish' as const;
export type PairMethod = typeof SYS_PAIR_BEGIN | typeof SYS_PAIR_FINISH;

// The two frames that authenticate one socket with the secret a pairing by code
// left on both sides, named as the desktop names them. Both are `sys` frames with an empty origin:
//   * sys_auth_begin  {nc, origin?} -> {ns, mac}: each side's 16-byte nonce and
//     the desktop's proof; `origin` names the dApp whose request waits on the
//     handshake (the desktop then raises its unlock window when locked).
//   * sys_auth_finish {mac} -> {authenticated: true}: the extension's proof.
// The order on a socket: the handshake, then sys_resume, then the dApp frames.
// Every byte string is standard base64 with padding.
export const SYS_AUTH_BEGIN = 'sys_auth_begin' as const;
export const SYS_AUTH_FINISH = 'sys_auth_finish' as const;
export type AuthMethod = typeof SYS_AUTH_BEGIN | typeof SYS_AUTH_FINISH;

// The first protocol major whose sockets must authenticate (the same major on
// the desktop). Keyed on the major, never on whether a secret
// exists: before it, a socket that never begins a handshake is served as
// before; from it, nothing but sys_ping and the pairing and handshake frames is
// served on a socket that has not authenticated.
export const AUTH_REQUIRED_FROM_MAJOR = 3;

export const isAuthRequiredAt = (v: ProtocolVersion): boolean =>
  v.major >= AUTH_REQUIRED_FROM_MAJOR;

// Error codes, as the desktop defines them. EIP-1193-aligned 4xxx, the
// wallet's own 1xxx range, and EIP-1474's -32003 "Transaction rejected".
export enum ErrorCode {
  UserRejected = 4001,
  Unauthorized = 4100,
  UnsupportedMethod = 4200,
  Disconnected = 4900,
  UnrecognizedChain = 4902,
  WalletLocked = 1001,
  NotPaired = 1002,
  AddressNotEligible = 1003,
  MalformedRequest = 1100,
  RequestPending = 1101,
  Internal = 1102,
  VersionIncompatible = 1103,
  // The wallet's transaction filter refused the request, not the person, who
  // approved it, so never 4001. The message carries no
  // reason. A new value, not a new field: no protocol version bump.
  TransactionRejected = -32003,
}

// A request frame (extension → desktop). `origin` is the page's real origin (the
// content script reads it — a page cannot forge it). `chain` is the mhda chain-key
// URN (e.g. "nt:evm:ci:1"); required by connect/sign/tx methods. It is opaque to
// US — only chains.ts builds one — but NOT to the desktop, which
// requires the canonical key byte-for-byte at its dispatch door and refuses
// anything else with MalformedRequest (1100) before any prompt is raised.
export interface Request {
  v: ProtocolVersion;
  iid: string;
  rid: string;
  ns: Namespace;
  origin: string;
  chain?: string;
  method: string;
  params?: unknown;
}

// An error payload inside a failure response.
export interface WireError {
  code: number;
  message: string;
  data?: unknown;
}

// A response frame (desktop → extension), correlated to a request by `rid`.
export interface Response {
  v: ProtocolVersion;
  iid: string;
  rid: string;
  ok: boolean;
  result?: unknown;
  error?: WireError;
}

// An unsolicited event frame (desktop → extension), e.g. accountsChanged. It
// carries no `rid` (it answers no request). `origin` names the target dApp so
// the SW can route the event to the right page (one instance multiplexes many
// origins).
export interface Event {
  v: ProtocolVersion;
  iid: string;
  ns: Namespace;
  origin?: string;
  // The mhda chain-key URN this event serves. Each injected provider drops a push
  // about a chain it is not on (Solana and Sui both serve `wstd`, so this alone
  // routes between them); absent/empty (a pre-chain desktop, a push tied to no
  // chain) → fall back to ns.
  chain?: string;
  event: string;
  data?: unknown;
}

// The guards on what arrives from the desktop socket. Normally only the desktop
// writes these frames, but anything that listens on a loopback port can, so a
// frame passes only when every field the extension reads has the type it reads
// it as; anything else is dropped. Key presence is not enough: `ok: "false"` is
// truthy, and a non-string `origin` or `chain` would be compared and forwarded
// as if it were one.
const NAMESPACES: readonly Namespace[] = ['sys', ...DAPP_NAMESPACES];

const isNamespace = (ns: unknown): ns is Namespace =>
  typeof ns === 'string' && (NAMESPACES as readonly string[]).includes(ns);

const isOptionalString = (v: unknown): boolean =>
  v === undefined || typeof v === 'string';

export const isResponse = (m: unknown): m is Response => {
  if (typeof m !== 'object' || m === null) {
    return false;
  }
  const r = m as Record<string, unknown>;
  return typeof r.rid === 'string' && typeof r.ok === 'boolean';
};

export const isEvent = (m: unknown): m is Event => {
  if (typeof m !== 'object' || m === null || 'rid' in m) {
    return false;
  }
  const e = m as Record<string, unknown>;
  return (
    typeof e.event === 'string' &&
    isNamespace(e.ns) &&
    isOptionalString(e.origin) &&
    isOptionalString(e.chain)
  );
};

// Build a request frame. `rid` is per-request; the caller supplies the persisted
// `iid` and a fresh `rid`.
export const makeRequest = (
  iid: string,
  rid: string,
  ns: Namespace,
  origin: string,
  method: string,
  params?: unknown,
  chain?: string
): Request => ({
  v: WEB3_PROTOCOL_VERSION,
  iid,
  rid,
  ns,
  origin,
  ...(chain !== undefined ? { chain } : {}),
  method,
  ...(params !== undefined ? { params } : {}),
});
