// The extension-internal message shapes between the extension's own realms:
//   inpage provider (main world)  <-- window.postMessage -->  content (isolated)
//   content (isolated)            <-- runtime port        -->  background SW
//   popup document                <-- runtime message     -->  background SW
//
// These are distinct from the v2 wire envelope (src/protocol/envelope.ts): the
// page cannot be trusted with the wire `iid`/`rid`, so it speaks this minimal
// shape and the SW assembles the real wire frame (adding the persisted iid + a
// fresh rid). The content script is the only layer that knows the page's real
// `origin`, which it stamps on the way through.

import { isDappNamespace, isResponse } from './envelope';
import type {
  Namespace,
  PairMethod,
  Response,
  VersionVerdict,
  WalletStatus,
  WireError,
} from './envelope';

// A `window.postMessage` from the page is tagged so the content script can tell
// our traffic apart from the page's own messages.
export const PAGE_TO_CONTENT = 'airnox:page->content' as const;
export const CONTENT_TO_PAGE = 'airnox:content->page' as const;

// The page asks the content/SW to perform an RPC. `id` correlates the eventual
// result; `origin` is filled by the content script (never trusted from the page).
export interface RpcRequest {
  channel: typeof PAGE_TO_CONTENT;
  id: string;
  ns: Namespace;
  method: string;
  params?: unknown;
  chain?: string;
}

// Caps on the page-chosen strings a request carries. Our providers send a
// 36-char uuid id and method names of a few dozen characters; the caps only
// bound what a hostile page can push through the relay.
export const MAX_REQUEST_ID_LENGTH = 128;
export const MAX_METHOD_LENGTH = 128;

// Why an RPC request frame from the page may not be relayed, or undefined if it
// may. Checked at BOTH seams: the content script, then the SW again. Every field
// the SW copies into the wire frame is checked here, because a frame the desktop
// cannot parse is answered without a request id — an answer that cannot be
// attributed, and so settles nothing, leaving the page waiting.
//
// The caller has already established that `id` is a string: a frame without one
// cannot be answered at all and is dropped, not refused. `params` is left to the
// desktop, which validates it per method.
export function requestFieldsProblem(frame: {
  readonly id: string;
  readonly ns?: unknown;
  readonly method?: unknown;
  readonly chain?: unknown;
}): string | undefined {
  if (frame.id.length > MAX_REQUEST_ID_LENGTH) {
    return 'malformed request id';
  }
  // A page may address only the dApp namespaces — never `sys` (the
  // extension<->desktop control plane) or an unknown value.
  if (!isDappNamespace(frame.ns)) {
    return 'unsupported namespace';
  }
  if (
    typeof frame.method !== 'string' ||
    frame.method.length === 0 ||
    frame.method.length > MAX_METHOD_LENGTH
  ) {
    return 'malformed method';
  }
  // Absent, or a string; the desktop checks the string against its canonical
  // chain keys. `null` is not absent: it would reach the wire as JSON null.
  if (frame.chain !== undefined && typeof frame.chain !== 'string') {
    return 'malformed chain';
  }
  return undefined;
}

// The page reached for a wallet provider WITHOUT (yet) making a request: it read
// an injected global (window.ethereum / tronWeb / tronLink / tron /
// airnox), asked for EIP-6963 providers, or announced a Wallet-Standard
// app. It carries no id and expects no reply — it exists so the toolbar can show
// wallet state on the tabs that actually want web3, and stay blank on the rest
// (see background/web3_tabs.ts). A page can trivially forge one, and that is
// harmless: reading window.ethereum would produce a genuine one anyway, and the
// frame grants nothing — it only paints this tab's own badge.
export interface PageTouch {
  channel: typeof PAGE_TO_CONTENT;
  touch: true;
}

// The result handed back to the page (success xor error).
export interface RpcResult {
  channel: typeof CONTENT_TO_PAGE;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: WireError;
}

// Broadcast to the page when the content↔SW port drops (the SW was evicted or
// the desktop transport went away). The provider rejects every in-flight request
// rather than leaving its promises pending forever.
export interface RpcDisconnect {
  channel: typeof CONTENT_TO_PAGE;
  disconnect: true;
}

// An unsolicited event the provider emits to the page (accountsChanged). The
// SW pushed it (the desktop pushed it to the SW); it answers no request.
export interface PageEvent {
  channel: typeof CONTENT_TO_PAGE;
  ns: Namespace;
  chain?: string; // mhda chain-key URN the push is about (see envelope.ts Event)
  event: string;
  data?: unknown;
}

export type ContentToPage = RpcResult | RpcDisconnect | PageEvent;

// content <-> SW port frames (over a long-lived chrome.runtime.Port). The
// content forwards the page request with the stamped origin; the SW answers.
export interface PortRequest {
  kind: 'rpc';
  id: string;
  ns: Namespace;
  origin: string;
  method: string;
  params?: unknown;
  chain?: string;
}

export interface PortResult {
  kind: 'rpc-result';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: WireError;
}

// content -> SW on port connect: names the page's real origin (stamped by the
// content script in the isolated world, never trusted from the page) so the SW
// can route unsolicited events (accountsChanged) to the right page. The SW binds
// the port only when this is the origin the browser attests for the port's
// sender, and refuses every request whose origin is not the bound one.
export interface PortHello {
  kind: 'hello';
  origin: string;
}

// content -> SW: this page reached for a provider (see PageTouch). Origin-stamped
// like every other page frame, though the SW needs only the sender's tab.
export interface PortTouch {
  kind: 'touch';
  origin: string;
}

// SW -> content: an unsolicited event for this page that the desktop pushed.
export interface PortEvent {
  kind: 'event';
  ns: Namespace;
  chain?: string; // mhda chain-key URN the push is about (see envelope.ts Event)
  event: string;
  data?: unknown;
}

export type PortFrame =
  | PortRequest
  | PortResult
  | PortHello
  | PortTouch
  | PortEvent;

// SW -> content, as a one-shot runtime message to each web3 TAB (tabs.sendMessage), not over the port: the desktop
// the extension was talking to is gone and a new desktop session answers, so every account a page cached is
// forgotten. Not the port, because an evicted worker's ports stay dead until their
// page next sends — exactly the idle pages that hold stale accounts.
export const FORGET_ACCOUNTS_MESSAGE = 'airnox:forget-accounts' as const;

// What the content script hands its page for FORGET_ACCOUNTS_MESSAGE: per namespace, the push each provider already
// handles as "the desktop holds no accounts for you" — so no provider needs a second path for it.
export const NO_ACCOUNTS_EVENTS: readonly PortEvent[] = [
  // EIP-1193: the desktop's push of an empty set; the provider clears and emits
  // accountsChanged([]) only if it held any.
  { kind: 'event', ns: 'evm', event: 'accountsChanged', data: [] },
  // TRON: the same shape as EVM's.
  { kind: 'event', ns: 'tron', event: 'accountsChanged', data: [] },
  // Wallet Standard (Solana and Sui share `wstd`): a desktop revoke; with no chain
  // it reaches both adapters, and an empty one no-ops.
  { kind: 'event', ns: 'wstd', event: 'disconnect' },
  // TON Connect: the desktop's disconnect, fanned out to every listen() subscriber.
  { kind: 'event', ns: 'tonconnect', event: 'disconnect' },
];

// popup <-> background SW. The popup is a separate document that reaches the SW
// with one-shot runtime messages, not over the content port. These two message
// types are its entire vocabulary (the pairing page's relay is further down).
// The shapes live here, beside the other cross-realm contracts, so neither side
// owns the other: the SW must not import the popup's view code to answer it.

// The popup asks the SW for the current connection state.
export const STATUS_MESSAGE = 'airnox:status' as const;

// The popup tells the SW the user changed the transport mode / port, so the SW
// drops its cached client and rebuilds it from the new settings on the next
// request.
export const SETTINGS_CHANGED_MESSAGE =
  'airnox:transport-settings-changed' as const;

// The SW's reply to STATUS_MESSAGE: a fresh sys_ping result, the pairing handle,
// the port actually in use, and the version-compatibility verdict.
export interface StatusReply {
  connected: boolean; // desktop WS reachable
  status?: WalletStatus; // 'unlocked' | 'locked' (only when connected)
  iid: string; // the persisted instance id (pairing handle, NOT an account)
  port: number | null; // the loopback port actually connected on (null = offline)
  version?: VersionVerdict; // protocol-compatibility verdict (when a version is known)
}

// ── pairing page <-> background SW ───────────────────────────────────────────
// The pairing page (an extension page in its own small window, never inside a
// web page) pairs this extension with the desktop by a one-time code. It holds
// the attempt (the ephemeral key, the nonces, the code) itself, so the attempt
// outlives a worker eviction while the person types; the SW only carries its
// two frames over the socket it owns, and refuses anything else.

export const PAIR_RELAY_MESSAGE = 'airnox:pair-relay' as const;

// The page tells the SW a pairing completed and its key is stored, so the
// socket authenticates with it (WsClient.afterPairing).
export const PAIRED_MESSAGE = 'airnox:paired' as const;

// The pairing page, in the extension's package, and the window it opens in. The
// popup's Pairing row opens it, and so does the SW when a dApp's request finds
// no pairing the desktop accepts; then it carries that dApp's origin, a label
// hint the page passes on to the desktop's code dialog.
export const PAIRING_PAGE = 'src/popup/pairing.html';
export const PAIRING_WINDOW = {
  type: 'popup',
  width: 400,
  height: 360,
} as const;

export const pairingPagePath = (origin?: string): string =>
  origin === undefined || origin === ''
    ? PAIRING_PAGE
    : `${PAIRING_PAGE}?${new URLSearchParams({ origin }).toString()}`;

// What the page asks the SW to send: sys_pair_begin or sys_pair_finish, with
// the frame's params (string fields only).
export interface PairRelayMessage {
  type: typeof PAIR_RELAY_MESSAGE;
  method: PairMethod;
  params: Record<string, string>;
}

// The desktop's answer, with the instance id the frame carried and the loopback
// port of the socket it went out on: both are bound into the pairing
// transcript, so they come from the socket, not from the page's guess.
export interface PairRelayAnswer {
  iid: string;
  port: number;
  response: Response;
}

// The SW's reply: the answer, or why the frame never reached the desktop (a
// refused message, a desktop that cannot be reached, a dropped socket).
export type PairRelayReply =
  | { delivered: true; answer: PairRelayAnswer }
  | { delivered: false; message: string };

const isPort = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 0xffff;

// The page's read of a relay reply. It crossed a realm boundary, so its type is
// a claim: the answer is returned only when every field it carries has the type
// it is read as. Throws an Error, with the SW's reason when it gave one, for an
// undelivered frame or anything malformed.
export const parsePairRelayReply = (raw: unknown): PairRelayAnswer => {
  const r = raw as Record<string, unknown> | null | undefined;
  if (typeof r === 'object' && r !== null && r.delivered === true) {
    const a = r.answer as Record<string, unknown> | null | undefined;
    if (
      typeof a === 'object' &&
      a !== null &&
      typeof a.iid === 'string' &&
      isPort(a.port) &&
      isResponse(a.response)
    ) {
      return { iid: a.iid, port: a.port, response: a.response };
    }
  }
  if (
    typeof r === 'object' &&
    r !== null &&
    r.delivered === false &&
    typeof r.message === 'string'
  ) {
    throw new Error(r.message);
  }
  throw new Error('malformed reply from the extension service worker');
};

// ── who holds the page's provider globals ────────────────────────────────────
// Another wallet, or a wallet built into the browser, may hold a global we would
// otherwise install: it injected first (we then never define it), or it
// redefined ours after we did. We never take one back. The popup instead tells
// the user, for the active tab, that another web3 wallet controls that page.
//
// Only the main world can see who holds a global, so the question goes popup ->
// content (a runtime message to the tab's top frame) -> page (a probe) and the
// answer comes back the same way. It is asked only when the popup opens: no page
// wakes the service worker or posts anything just because another wallet is
// installed.
//
// The answer comes from the page's own world, so a page can forge it. That is
// harmless and page-confined: the page could equally hold window.ethereum itself,
// and the answer only decides whether the popup shows a notice about that page.

// The globals we install (see src/inpage). window.solana / window.phantom are not
// among them: Solana and Sui are served through the Wallet Standard only, where
// every wallet registers side by side and nobody can take anyone's place.
export const PROVIDER_GLOBALS = [
  'ethereum',
  'tronWeb',
  'tronLink',
  'tron',
  'airnox',
] as const;
export type ProviderGlobal = (typeof PROVIDER_GLOBALS)[number];

// 'airnox': our provider is there; 'other': something else holds it (a wallet,
// the browser, or the page); 'none': nothing usable is there.
export type GlobalHolder = 'airnox' | 'other' | 'none';
const GLOBAL_HOLDERS: readonly GlobalHolder[] = ['airnox', 'other', 'none'];

export type HolderReport = Readonly<Record<ProviderGlobal, GlobalHolder>>;

// A holder report from the page, or undefined unless it names exactly the globals
// above, each with a known holder. It crossed from a page-controlled world, so
// its declared type is a claim (fail closed).
export function parseHolderReport(data: unknown): HolderReport | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return undefined;
  }
  const keys = Object.keys(data);
  if (keys.length !== PROVIDER_GLOBALS.length) {
    return undefined;
  }
  const out = {} as Record<ProviderGlobal, GlobalHolder>;
  for (const key of PROVIDER_GLOBALS) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) {
      return undefined;
    }
    const holder: unknown = (data as Record<string, unknown>)[key];
    if (!GLOBAL_HOLDERS.includes(holder as GlobalHolder)) {
      return undefined;
    }
    out[key] = holder as GlobalHolder;
  }
  return out;
}

// content -> page: report who holds each provider global now.
export interface HolderProbe {
  channel: typeof CONTENT_TO_PAGE;
  probe: 'holders';
}

export function isHolderProbe(data: unknown): boolean {
  const frame = data as Partial<HolderProbe> | null | undefined;
  return (
    typeof frame === 'object' &&
    frame !== null &&
    frame.channel === CONTENT_TO_PAGE &&
    frame.probe === 'holders'
  );
}

// page -> content: the answer to a HolderProbe.
export interface PageHolders {
  channel: typeof PAGE_TO_CONTENT;
  holders: HolderReport;
}

// popup -> content, a one-shot runtime message to the active tab's top frame.
export const PAGE_HOLDERS_MESSAGE = 'airnox:page-holders' as const;

// content -> popup: the page's answer, absent when the page did not answer in
// time (the popup then shows nothing about it).
export interface PageHoldersReply {
  holders?: HolderReport;
}
