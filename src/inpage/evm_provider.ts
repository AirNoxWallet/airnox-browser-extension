// The EIP-1193 logic (`window.ethereum.request` + events). It holds NO keys: the
// desktop signs + enforces permissions. Four methods whose answer this provider
// already caches are served LOCALLY (see request() for why each one); everything
// else — connect, sign, tx, and the node reads the desktop relays from its own
// allowlist — round-trips through the injected Transport. Decoupled from the
// postMessage wiring for testability.

import { EVM_MAINNET_CHAIN_URN } from '../protocol/chains';
import { toWireParams } from '../protocol/evm_wire_params';
import { ErrorCode, Namespace } from '../protocol/envelope';
import { Emitter } from './emitter';
import { isUnauthorized, rpcError } from './rpc_error';
import { Transport } from './transport';

// The default EVM chain the extension bootstraps with. The wire chain (mhda URN)
// is the SSOT `EVM_MAINNET_CHAIN_URN` from the chain registry; `chainIdHex` is
// the EIP-1193 value `eth_chainId` returns for it. Both are updated on a
// successful wallet_switchEthereumChain. The desktop ships the real chain
// set — the extension hardcodes only this bootstrap default.
export const DEFAULT_CHAIN_ID_HEX = '0x1';

export interface RequestArguments {
  readonly method: string;
  readonly params?: unknown[] | object;
}

// Legacy (pre-EIP-1193) JSON-RPC shapes for the deprecated send / sendAsync.
export interface LegacyRpcRequest {
  readonly method: string;
  readonly params?: unknown[];
  readonly id?: string | number;
  readonly jsonrpc?: string;
}
export interface LegacyRpcResponse {
  readonly id?: string | number;
  readonly jsonrpc: string;
  readonly result: unknown;
}
export type LegacyCallback = (
  error: Error | null,
  response: LegacyRpcResponse | null
) => void;

function sameAccounts(a: readonly string[], b: readonly string[]): boolean {
  return (
    a.length === b.length &&
    a.every((v, i) => v.toLowerCase() === b[i].toLowerCase())
  );
}

// The chainId a wallet_switchEthereumChain request carries: EIP-3326 params are
// `[{ chainId: "0x.." }]`. Returns the raw string or null for any other shape.
function requestedChainId(params: unknown): string | null {
  if (
    Array.isArray(params) &&
    params.length > 0 &&
    typeof params[0] === 'object' &&
    params[0] !== null
  ) {
    const cid = (params[0] as { chainId?: unknown }).chainId;
    if (typeof cid === 'string') {
      return cid;
    }
  }
  return null;
}

// Canonicalise a 0x-hex chainId to lowercase, no leading zeros ("0x089" → "0x89")
// — the form eth_chainId returns. null for a malformed value (the desktop has
// already validated it, so this is defensive). BigInt avoids the 2^53 precision
// loss parseInt would hit on a large chain id.
function normaliseChainId(s: string | null): string | null {
  if (!s) {
    return null;
  }
  try {
    return '0x' + BigInt(s.toLowerCase()).toString(16);
  } catch {
    return null;
  }
}

export class AirNoxEvmProvider extends Emitter {
  readonly isAirNoxWallet = true;
  // dApps key off this flag for legacy detection; we are not MetaMask.
  readonly isMetaMask = false;

  private connectedAccounts: string[] = [];

  // The active wire chain (mhda URN) + its EIP-1193 chainId. Mutable: a
  // successful wallet_switchEthereumChain adopts the desktop-resolved chain-key
  // (the SSOT URN — never reconstructed here) and updates the chainId.
  private chainUrn: string;
  private chainIdHex: string;

  constructor(
    private readonly transport: Transport,
    chainUrn: string = EVM_MAINNET_CHAIN_URN,
    chainIdHex: string = DEFAULT_CHAIN_ID_HEX
  ) {
    super();
    this.chainUrn = chainUrn;
    this.chainIdHex = chainIdHex;
    // Unsolicited desktop pushes (accountsChanged / chainChanged) flow in through
    // the transport.
    this.transport.onEvent((ns, event, data, chain) =>
      this.handleEvent(ns, event, data, chain)
    );
  }

  // ── Legacy provider properties (MetaMask-era dApps) ───────────────────────
  //
  // Older dApps read these straight off window.ethereum instead of asking
  // eth_chainId / eth_accounts — testnet.soniclabs.com reads `chainId` and shows
  // "Wrong network" on a provider without it. They are GETTERS over the same
  // cached state the local reads in request() answer from, so they cannot
  // disagree with eth_chainId / net_version / eth_coinbase, and every path that
  // changes that state (a connect, a pushed or 4100-forced accountsChanged, a
  // pushed chainChanged, a switch) updates them before it emits — a dApp
  // listener reading them inside the event already sees the new value. No
  // setter: a page assigning one changes neither the property nor the wire
  // chain (ignored in sloppy mode, a TypeError in strict mode).
  //
  // MetaMask's chainId is null until its first chain is known; this provider
  // bootstraps on a known chain (DEFAULT_CHAIN_ID_HEX) and never leaves one, so
  // it is always a string here.

  // The active EIP-1193 chainId, canonical 0x-hex — what eth_chainId returns.
  get chainId(): string {
    return this.chainIdHex;
  }

  // The active chain id in decimal — what net_version returns. BigInt keeps a
  // chain id above 2^53 exact.
  get networkVersion(): string {
    return String(BigInt(this.chainIdHex));
  }

  // The selected account in lowercase, as MetaMask's is, or null when nothing is
  // connected. The accounts the events and eth_accounts carry keep the
  // desktop's casing; only this legacy view is lowercased.
  get selectedAddress(): string | null {
    return this.connectedAccounts[0]?.toLowerCase() ?? null;
  }

  // An event the desktop pushed for this dApp. Both accountsChanged and
  // chainChanged update the cached state and re-emit, deduped — the desktop only
  // pushes on a real change, but a no-op push must not surface a spurious event.
  private handleEvent(
    ns: Namespace,
    event: string,
    data: unknown,
    chain?: string
  ): void {
    if (ns !== 'evm') {
      return; // a push for another chain's provider on the shared window
    }
    if (event === 'accountsChanged') {
      // The desktop tags the push with the chain whose grant changed, and the
      // cached set is the ACTIVE chain's: a push about another EVM chain says
      // nothing about it. A switch's answer is adopted before the push that
      // follows it is read (one ordered path, microtasks first), so the target's
      // set the desktop pushes after a switch applies. An empty or missing chain
      // (a push not tied to one, a pre-chain desktop) is not a mismatch.
      if (chain && chain !== this.chainUrn) {
        return;
      }
      const accounts = Array.isArray(data)
        ? data.filter((a): a is string => typeof a === 'string')
        : [];
      if (sameAccounts(this.connectedAccounts, accounts)) {
        return;
      }
      this.connectedAccounts = accounts;
      this.emit('accountsChanged', [...accounts]);
      return;
    }
    if (event === 'chainChanged') {
      // A desktop-pushed active-chain change. The desktop sends it when its
      // active chain for this origin moves, including ahead of a connect reply
      // that granted the dApp on another chain than the one it asked from, so
      // the accounts that reply carries are adopted on the new chain. Contract:
      // `data` is the new EIP-1193 chainId (0x-hex, the dApp-facing payload) and
      // `chain` is the new chain-key URN (the wallet's SSOT chain identity,
      // adopted as the wire chain for later requests). BOTH are required — the
      // extension never derives one from the other, and a chainId-only update
      // would leave the wire chain stale. Deduped + malformed-ignored: only a
      // real change surfaces an event.
      const next = normaliseChainId(typeof data === 'string' ? data : null);
      if (!next || typeof chain !== 'string' || chain.length === 0) {
        return;
      }
      if (next === this.chainIdHex) {
        return; // a no-op push must not surface a spurious event
      }
      this.chainUrn = chain;
      this.chainIdHex = next;
      this.emit('chainChanged', this.chainIdHex);
      return;
    }
  }

  async request(args: RequestArguments): Promise<unknown> {
    if (!args || typeof args.method !== 'string') {
      throw rpcError(ErrorCode.MalformedRequest, 'request requires a method');
    }
    const { method, params } = args;

    // Answered locally from cached state — NOT for want of a desktop read path
    // (the desktop relays an allowlist of non-mutating eth_* / net_* /
    // web3_* reads to the user's node), but because these four are answers this
    // provider already owns. eth_accounts / eth_coinbase are permission state,
    // deliberately outside that allowlist, and eth_accounts must NOT prompt: it
    // reflects the already-granted set (empty before connect, and again once the
    // desktop refuses this origin with 4100 — see roundTrip). eth_chainId /
    // net_version must agree with the `chain` URN stamped on every outgoing
    // request, so the cached value is the one that cannot disagree mid-switch.
    // Kept in lockstep with syncRead() so every call form (request / send /
    // sendAsync) agrees.
    switch (method) {
      case 'eth_chainId':
        return this.chainIdHex;
      case 'net_version':
        // BigInt (not parseInt) so a chain id above 2^53 keeps full precision —
        // the same reason normaliseChainId uses BigInt.
        return String(BigInt(this.chainIdHex));
      case 'eth_accounts':
        return [...this.connectedAccounts];
      case 'eth_coinbase':
        return this.connectedAccounts[0] ?? null;
      default:
        break;
    }

    const result = await this.roundTrip(method, params);
    if (method === 'eth_requestAccounts') {
      this.absorbAccounts(result);
    } else if (method === 'wallet_switchEthereumChain') {
      // The await above already threw on a failure (4902 / user-rejected), so we
      // only reach here on success. The desktop returns the RESOLVED chain-key
      // (the SSOT mhda URN); adopt it + the new chainId, emit chainChanged, and
      // return the EIP-3326-mandated null to the dApp.
      this.adoptSwitchedChain(result, params);
      return null;
    }
    return result;
  }

  // One desktop round-trip on the active chain.
  //
  // The dApp speaks EIP-1193's positional arguments; the desktop reads named
  // keys off an object for the methods it confirms. toWireParams is that
  // translation, and it is a no-op for every method whose wire shape is
  // positional (EIP-3326 / EIP-3085) — see src/protocol/evm_wire_params.ts.
  //
  // A 4100 answer means the desktop no longer grants this origin the accounts
  // cached here (see isUnauthorized): forget them, THEN let the refusal reach
  // the dApp unchanged — so a dApp whose error handler re-reads eth_accounts
  // already sees the truth. Any address-level 4100 clears the whole set, not one
  // address: the desktop's refusal does not say which part of the cache is
  // stale, and an empty set is the one answer that cannot claim a grant the
  // desktop denies; a still-granted origin gets its accounts back from the next
  // eth_requestAccounts. Nothing else clears: a 4900 is also what a transient
  // port drop or an idle worker eviction looks like from here, and says nothing
  // about the grant.
  private async roundTrip(method: string, params: unknown): Promise<unknown> {
    try {
      return await this.transport.send(
        'evm',
        method,
        toWireParams(method, params),
        this.chainUrn
      );
    } catch (e) {
      if (isUnauthorized(e)) {
        this.forgetAccounts();
      }
      throw e;
    }
  }

  // Drop the cached accounts and say so with the standard EIP-1193
  // accountsChanged([]) — the same event a desktop push of an empty set raises —
  // but only when there was something to forget, so a page that never connected
  // hears nothing.
  private forgetAccounts(): void {
    if (this.connectedAccounts.length === 0) {
      return;
    }
    this.connectedAccounts = [];
    this.emit('accountsChanged', []);
  }

  // ── Legacy EIP-1193 aliases (older dApps / connectors) ────────────────────

  // Legacy: ethereum.enable() === request({ method: 'eth_requestAccounts' }).
  enable(): Promise<unknown> {
    return this.request({ method: 'eth_requestAccounts' });
  }

  // Legacy async RPC: sendAsync(payload, callback). Routes the payload through
  // request() and calls back node-style (error, { id, jsonrpc, result }). A
  // throw inside the callback must not surface here.
  sendAsync(payload: LegacyRpcRequest, callback: LegacyCallback): void {
    if (!payload || typeof payload.method !== 'string') {
      throw rpcError(
        ErrorCode.MalformedRequest,
        'sendAsync requires a payload with a method'
      );
    }
    this.request({ method: payload.method, params: payload.params })
      .then((result) => {
        try {
          callback(null, {
            id: payload.id,
            jsonrpc: payload.jsonrpc ?? '2.0',
            result,
          });
        } catch {
          // a dApp callback throwing is its problem, not ours
        }
      })
      .catch((error: Error) => {
        try {
          callback(error, null);
        } catch {
          // ditto
        }
      });
  }

  // Legacy send(), three historical forms:
  //   send(method, params)    → Promise (MetaMask's later signature)
  //   send(payload, callback) → sendAsync
  //   send(payload)           → a SYNCHRONOUS response, answered only for the
  //                             few locally-cached read methods (MetaMask-
  //                             compatible); any other method throws (a
  //                             synchronous round-trip is impossible).
  send(method: string, params?: unknown[]): Promise<unknown>;
  send(payload: LegacyRpcRequest, callback: LegacyCallback): void;
  send(payload: LegacyRpcRequest): LegacyRpcResponse;
  send(
    methodOrPayload: string | LegacyRpcRequest,
    paramsOrCallback?: unknown[] | LegacyCallback
  ): Promise<unknown> | LegacyRpcResponse | void {
    if (typeof methodOrPayload === 'string') {
      return this.request({
        method: methodOrPayload,
        params: paramsOrCallback,
      });
    }
    if (typeof paramsOrCallback === 'function') {
      this.sendAsync(methodOrPayload, paramsOrCallback);
      return;
    }
    // Synchronous send(payload). `typeof null === 'object'` lands here too — the
    // guard rejects it (and any payload without a method) as MalformedRequest
    // rather than dereferencing it, matching request()'s defensive contract.
    if (!methodOrPayload || typeof methodOrPayload.method !== 'string') {
      throw rpcError(
        ErrorCode.MalformedRequest,
        'send requires a method string or a payload with a method'
      );
    }
    return {
      id: methodOrPayload.id,
      jsonrpc: methodOrPayload.jsonrpc ?? '2.0',
      result: this.syncRead(methodOrPayload.method),
    };
  }

  // The values the deprecated synchronous send(payload) can answer locally
  // (no round-trip). Anything else throws — a synchronous RPC is unsupported.
  private syncRead(method: string): unknown {
    switch (method) {
      case 'eth_accounts':
        return [...this.connectedAccounts];
      case 'eth_coinbase':
        return this.connectedAccounts[0] ?? null;
      case 'eth_chainId':
        return this.chainIdHex;
      case 'net_version':
        // BigInt (not parseInt) so a chain id above 2^53 keeps full precision —
        // the same reason normaliseChainId uses BigInt.
        return String(BigInt(this.chainIdHex));
      default:
        throw rpcError(
          ErrorCode.UnsupportedMethod,
          `synchronous send is unsupported for ${method}; use request(...)`
        );
    }
  }

  // Adopt the chain a successful wallet_switchEthereumChain resolved to. The wire
  // result is the desktop's chain-key URN (the wallet is the SSOT for chain
  // identity — the extension never builds a URN from a chainId). The dApp-facing
  // chainId is the (desktop-validated) requested id, normalised to canonical
  // lowercase 0x-hex.
  //
  // ALL-OR-NOTHING: the wire chain (chainUrn) and the EIP-1193 chainId
  // (chainIdHex) must move together. Adopting one but not the other would leave
  // eth_chainId and the wire `chain` field disagreeing, so every later request
  // would target one chain while the dApp believes it is on the other. The
  // desktop already validated and performed the switch, so a non-string key or
  // an unparseable requested chainId here is a contract breach — fail loud
  // rather than half-switch (mirrors the expectString guards on other paths).
  private adoptSwitchedChain(chainKey: unknown, params: unknown): void {
    const chainId = normaliseChainId(requestedChainId(params));
    if (typeof chainKey !== 'string' || chainKey.length === 0 || !chainId) {
      throw rpcError(
        ErrorCode.Internal,
        'wallet_switchEthereumChain succeeded but the wallet returned a malformed chain result'
      );
    }
    this.chainUrn = chainKey;
    this.chainIdHex = chainId;
    this.emit('chainChanged', this.chainIdHex);
  }

  // Cache the granted accounts from an eth_requestAccounts result and fire the
  // EIP-1193 events: `connect` once on the first connection, `accountsChanged`
  // whenever the set changes.
  private absorbAccounts(result: unknown): void {
    const accounts = Array.isArray(result)
      ? result.filter((a): a is string => typeof a === 'string')
      : [];
    const wasConnected = this.connectedAccounts.length > 0;
    const changed = !sameAccounts(this.connectedAccounts, accounts);
    this.connectedAccounts = accounts;
    if (!wasConnected && accounts.length > 0) {
      this.emit('connect', { chainId: this.chainIdHex });
    }
    if (changed) {
      this.emit('accountsChanged', [...accounts]);
    }
  }
}
