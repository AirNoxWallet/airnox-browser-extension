// The page-side transport seam. The EIP-1193 provider depends only on this
// interface, so its method routing / caching / event logic is unit-testable
// with a mock — the postMessage wiring (the untestable, browser-only half)
// lives in PostMessageTransport.

import {
  CONTENT_TO_PAGE,
  PAGE_TO_CONTENT,
  PageEvent,
  RpcDisconnect,
  RpcRequest,
  RpcResult,
} from '../protocol/bridge';
import { v4 as uuidv4 } from 'uuid';
import { ErrorCode, Namespace } from '../protocol/envelope';
import { friendlyErrorMessage, ProviderRpcError, rpcError } from './rpc_error';

// Handler for an unsolicited event the desktop pushed (accountsChanged, …). The
// namespace is carried through so a provider can ignore events for OTHER chains:
// all five providers share ONE transport (the single inpage entry builds it and
// wires each provider to it), so every registered handler hears every push and
// must filter by `ns` (the EVM, TRON, TON Connect and Wallet-Standard providers
// would otherwise all react to each other's events). `chain` (the mhda chain-key
// URN) further separates Solana from Sui — both serve the `wstd` ns, so ns alone
// cannot route between them — and keeps a push about another EVM or TRON chain
// off the accounts of the one a provider is on. Absent from a pre-chain desktop
// (and empty on a push tied to no chain), so a provider treats a missing chain as
// "no further filter".
export type EventHandler = (
  ns: Namespace,
  event: string,
  data: unknown,
  chain?: string
) => void;

export interface Transport {
  // Round-trip one request to the desktop; resolves with the result or rejects
  // with a ProviderRpcError carrying the wire error code.
  send(
    ns: Namespace,
    method: string,
    params: unknown,
    chain?: string
  ): Promise<unknown>;

  // Register a handler for unsolicited events from the desktop. Every registered
  // handler receives every push (the five providers share one transport), so
  // each handler filters by `ns` (+ chain) for its own events.
  onEvent(handler: EventHandler): void;
}

// The production transport: a window.postMessage round-trip to the content
// script (→ SW → desktop), resolved by a fresh request id. Owns the pending map
// + the single response/disconnect listener.
//
// TRUST MODEL (accepted limitation — read before "hardening" this listener).
// This runs in the page's MAIN world, so it shares globals + the postMessage
// surface with the dApp's own scripts. Inbound CONTENT_TO_PAGE messages are
// accepted on `event.source === window` + the public channel tag only — there is
// deliberately NO per-injection secret/nonce, because a MAIN-world script cannot
// hold one: every content↔inpage channel (window.postMessage, the DOM, a
// transferred MessageChannel port) is observable by the page, so any "secret"
// would be page-readable and the check would be security theater.
// Consequently a malicious PAGE can forge provider events (accountsChanged /
// chainChanged / disconnect) or a response into ITS OWN dApp. This is
// PAGE-CONFINED and not a wallet compromise: the desktop never sees these forged
// frames; the security boundary is the ISOLATED-world content script, which
// stamps the unforgeable origin (content.ts) and round-trips every grant/sign to
// the desktop, where permissions are enforced server-side. This is the same
// threat model every MAIN-world-injected wallet (MetaMask included) accepts.
export class PostMessageTransport implements Transport {
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: ProviderRpcError) => void }
  >();
  private readonly eventHandlers = new Set<EventHandler>();

  constructor() {
    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window) {
        return;
      }
      const data = event.data as
        | Partial<RpcResult & RpcDisconnect & PageEvent>
        | undefined;
      if (!data || data.channel !== CONTENT_TO_PAGE) {
        return;
      }
      if (data.disconnect === true) {
        // NB: this is a TRANSIENT content↔SW port drop (MV3 evicts the service
        // worker on idle; it reconnects lazily on the next send). It is NOT a
        // genuine "wallet is gone" disconnect, so it deliberately does NOT raise
        // the EIP-1193 `disconnect` event — doing so would spam the dApp on every
        // idle eviction. A real disconnect (the desktop WS dropped + reconnect
        // failed) needs a distinct wallet-gone signal from the SW; that + the
        // provider's `disconnect` emit are deferred until a dApp needs them.
        this.rejectAll();
        return;
      }
      if (typeof data.event === 'string') {
        // A well-formed push always carries its namespace; drop one that does not
        // rather than dispatch it with an undefined ns (fail closed — no provider
        // should act on an unattributable event).
        if (typeof data.ns === 'string') {
          for (const handler of this.eventHandlers) {
            handler(data.ns, data.event, data.data, data.chain);
          }
        }
        return;
      }
      if (typeof data.id === 'string') {
        this.resolve(data as RpcResult);
      }
    });
  }

  onEvent(handler: EventHandler): void {
    this.eventHandlers.add(handler);
  }

  send(
    ns: Namespace,
    method: string,
    params: unknown,
    chain?: string
  ): Promise<unknown> {
    // uuid.v4 (not crypto.randomUUID) — this runs in the page's MAIN world, which
    // includes insecure (http://) origins where crypto.randomUUID is undefined
    // (it is gated to secure contexts), so randomUUID would throw on every send.
    // The id only needs uniqueness for response correlation, not crypto strength;
    // uuid.v4 uses crypto.getRandomValues (available everywhere) under the hood.
    const id = uuidv4();
    const message: RpcRequest = {
      channel: PAGE_TO_CONTENT,
      id,
      ns,
      method,
      params,
      chain,
    };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      window.postMessage(message, '*');
    });
  }

  private resolve(msg: RpcResult): void {
    const slot = this.pending.get(msg.id);
    if (!slot) {
      return;
    }
    this.pending.delete(msg.id);
    if (msg.ok) {
      slot.resolve(msg.result);
    } else {
      const e = msg.error;
      const code = e?.code ?? ErrorCode.Internal;
      // Surface a human-actionable message for the wallet-side codes the desktop
      // sends tersely (NotPaired → guide the user to the desktop pairing prompt);
      // every other code keeps the desktop's own message. Uniform across every
      // provider (EVM / TON / TRON / Solana / Sui) since they all reject here.
      slot.reject(
        rpcError(
          code,
          friendlyErrorMessage(code, e?.message ?? 'request failed'),
          e?.data
        )
      );
    }
  }

  // The content↔SW port dropped — fail every in-flight request so no promise
  // leaks (the page can retry; the SW reconnects the transport lazily).
  private rejectAll(): void {
    for (const slot of this.pending.values()) {
      slot.reject(
        rpcError(ErrorCode.Disconnected, 'AirNox extension disconnected')
      );
    }
    this.pending.clear();
  }
}
