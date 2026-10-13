// The Wallet-Standard adapter for Solana. It holds NO keys: the desktop derives
// + signs + enforces permissions. Every feature round-trips through the injected
// Transport on the `wstd` namespace; accountsChanged pushes arrive via the same
// Transport.onEvent channel. Decoupled from the postMessage wiring + the window
// registration for testability — mirror of AirNoxTonConnectBridge / AirNoxEvmProvider.
//
// The account's `features` list advertises only what the wallet can actually do.
// The Solana sign surface is complete: signMessage, signTransaction (sign-only,
// the dApp broadcasts) and signAndSendTransaction (the wallet broadcasts).
//
// TWO CLUSTERS, ONE IN USE. The wallet serves mainnet and devnet (SOLANA_CLUSTERS).
// The desktop grants a dApp per (origin, chain) and Wallet Standard's connect names
// no chain, so a connection starts on mainnet and moves when a request names the
// other cluster: a connect on that cluster first (the desktop asks the person unless
// it already granted it), then the request; later requests that name no cluster go
// to the one in use. A refused switch sends nothing and stays where it was.

import { base58Decode } from './base58';
import {
  SOLANA_DEVNET_CHAIN_URN,
  SOLANA_MAINNET_CHAIN_URN,
} from '../protocol/chains';
import { base64Decode, base64Encode, bytesToHex0x } from './encoding';
import { Emitter } from './emitter';
import { expectString } from './expect_string';
import { isUnauthorized } from './rpc_error';
import { Namespace } from '../protocol/envelope';
import { Transport } from './transport';
import {
  AIRNOX_ICON_DATA_URI,
  AIRNOX_NAME,
  StandardEventsChange,
  Wallet,
  WalletAccount,
  sameAccounts,
} from './wallet_standard';

// Re-export the shared Wallet-Standard types so existing importers (tests,
// solana_inpage) keep resolving them from here.
export type { Wallet, WalletAccount } from './wallet_standard';

// The features an account is usable with (the Wallet-Standard account `features`
// list) — the full Solana sign surface.
const ACCOUNT_FEATURES: readonly string[] = [
  'solana:signMessage',
  'solana:signTransaction',
  'solana:signAndSendTransaction',
];

// The transaction versions the wallet can sign. The host's v0_tx parser accepts
// a legacy or a v0 (version 0) message (single-signer, MVP gate); anything newer
// is rejected at sign time.
const SUPPORTED_TX_VERSIONS: readonly ('legacy' | 0)[] = ['legacy', 0];

// The wire chain (mhda URN) the desktop dispatcher expects is the SSOT
// `SOLANA_MAINNET_CHAIN_URN` from the chain registry. `SOLANA_STD_CHAIN` is the
// Wallet-Standard chain identifier the dApp sees — a different namespace (CAIP-2
// style), NOT an mhda URN, so it stays local to the adapter.
export const SOLANA_STD_CHAIN = 'solana:mainnet';

// The clusters this wallet serves, in the order it advertises them: the
// Wallet-Standard chain a dApp names, and the desktop's chain key for it. The first
// is where a connection starts.
export const SOLANA_CLUSTERS: ReadonlyMap<string, string> = new Map([
  [SOLANA_STD_CHAIN, SOLANA_MAINNET_CHAIN_URN],
  ['solana:devnet', SOLANA_DEVNET_CHAIN_URN],
]);

// solana:signMessage I/O (Wallet-Standard). signMessage takes a BATCH of inputs
// and returns one output per input.
export interface SolanaSignMessageInput {
  readonly account: WalletAccount;
  readonly message: Uint8Array;
}
export interface SolanaSignMessageOutput {
  readonly signedMessage: Uint8Array;
  readonly signature: Uint8Array;
}

// solana:signTransaction I/O — sign a serialized transaction (the dApp
// broadcasts). signedTransaction is the re-serialized signed wire.
export interface SolanaSignTransactionInput {
  readonly account: WalletAccount;
  readonly transaction: Uint8Array;
  readonly chain?: string;
}
export interface SolanaSignTransactionOutput {
  readonly signedTransaction: Uint8Array;
}

// solana:signAndSendTransaction I/O — sign AND broadcast (the wallet sends). The
// signature is the broadcast transaction signature. `chain` is REQUIRED here per
// the Wallet-Standard spec (unlike signTransaction's optional `chain`).
export interface SolanaSignAndSendTransactionInput {
  readonly account: WalletAccount;
  readonly transaction: Uint8Array;
  readonly chain: string;
  readonly options?: {
    readonly preflightCommitment?: string;
    readonly skipPreflight?: boolean;
    readonly maxRetries?: number;
    readonly minContextSlot?: number;
  };
}
export interface SolanaSignAndSendTransactionOutput {
  readonly signature: Uint8Array;
}

// Whitelist the Wallet-Standard send options for the wire: only the four
// defined fields, only when present (undefined entries are dropped, never
// serialized as null). Returns null when nothing survives — the caller then
// omits params.options entirely, keeping the wire byte-identical to the
// pre-options era for dApps that pass none.
export function sendOptionsFrom(
  options: SolanaSignAndSendTransactionInput['options']
): Record<string, unknown> | null {
  if (options === undefined || options === null) {
    return null;
  }
  const out: Record<string, unknown> = {};
  if (options.preflightCommitment !== undefined) {
    out.preflightCommitment = options.preflightCommitment;
  }
  if (options.skipPreflight !== undefined) {
    out.skipPreflight = options.skipPreflight;
  }
  if (options.maxRetries !== undefined) {
    out.maxRetries = options.maxRetries;
  }
  if (options.minContextSlot !== undefined) {
    out.minContextSlot = options.minContextSlot;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export class AirNoxSolanaWallet implements Wallet {
  readonly version = '1.0.0' as const;
  readonly name = AIRNOX_NAME;
  readonly icon = AIRNOX_ICON_DATA_URI;
  readonly chains: readonly string[];

  private accounts_: WalletAccount[] = [];
  private readonly emitter = new Emitter();
  private readonly features_: Record<string, unknown>;

  // The cluster in use: its Wallet-Standard chain and the desktop's chain key.
  private stdChain: string = SOLANA_STD_CHAIN;
  private chainUrn: string = SOLANA_MAINNET_CHAIN_URN;

  constructor(private readonly transport: Transport) {
    this.chains = [...SOLANA_CLUSTERS.keys()];
    // Built once so the dApp sees stable feature references across reads.
    this.features_ = {
      'standard:connect': {
        version: '1.0.0',
        connect: (input?: { silent?: boolean }) => this.connect_(input),
      },
      'standard:disconnect': {
        version: '1.0.0',
        disconnect: () => this.disconnect_(),
      },
      'standard:events': {
        version: '1.0.0',
        on: (event: string, listener: (...args: unknown[]) => void) => {
          this.emitter.on(event, listener);
          return () => {
            this.emitter.removeListener(event, listener);
          };
        },
      },
      'solana:signMessage': {
        version: '1.0.0',
        signMessage: (...inputs: SolanaSignMessageInput[]) =>
          this.signMessage_(inputs),
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: SUPPORTED_TX_VERSIONS,
        signTransaction: (...inputs: SolanaSignTransactionInput[]) =>
          this.signTransaction_(inputs),
      },
      'solana:signAndSendTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: SUPPORTED_TX_VERSIONS,
        signAndSendTransaction: (
          ...inputs: SolanaSignAndSendTransactionInput[]
        ) => this.signAndSendTransaction_(inputs),
      },
    };
    // Desktop pushes (accountsChanged) update the cached accounts + emit 'change'.
    this.transport.onEvent((ns, event, data, chain) =>
      this.handleEvent(ns, event, data, chain)
    );
  }

  get accounts(): readonly WalletAccount[] {
    return this.accounts_;
  }

  get features(): Record<string, unknown> {
    return this.features_;
  }

  // standard:connect. A non-silent connect round-trips (the desktop prompts if
  // not already granted); a silent connect returns the cached set WITHOUT a
  // round-trip (so an auto-reconnect never prompts) — empty before a non-silent
  // connect this session (a cross-page silent reconnect needs desktop support,
  // not built yet).
  private async connect_(input?: {
    silent?: boolean;
  }): Promise<{ accounts: readonly WalletAccount[] }> {
    if (input?.silent) {
      return { accounts: this.accounts_ };
    }
    const result = await this.roundTrip('standard:connect', {});
    this.setAccounts(this.shapeAccounts(result));
    return { accounts: this.accounts_ };
  }

  // Move to the cluster a request names, before the request: a connect there, and
  // its accounts adopted, only when the connect succeeds. On the cluster already in
  // use, or with no cluster named, nothing happens. An unsupported cluster has been
  // refused by assertChain_ before this runs.
  private async useCluster_(chain?: string): Promise<void> {
    if (chain === undefined || chain === this.stdChain) {
      return;
    }
    const urn = SOLANA_CLUSTERS.get(chain) as string;
    const result = await this.transport.send(
      'wstd',
      'standard:connect',
      {},
      urn
    );
    this.stdChain = chain;
    this.chainUrn = urn;
    this.setAccounts(this.shapeAccounts(result));
  }

  // standard:disconnect (dApp-initiated): clear the local accounts + emit 'change'.
  // This only forgets the session locally — the desktop grant persists until the
  // user revokes it in the wallet UI, which then pushes a `wstd disconnect`
  // (handled in handleEvent). Both paths converge on setAccounts([]). (Synchronous
  // work wrapped in a resolved Promise to satisfy the feature's () => Promise<void>
  // shape.)
  private disconnect_(): Promise<void> {
    this.setAccounts([]);
    return Promise.resolve();
  }

  // Shape the desktop's granted-address array into WalletAccount objects. For
  // Solana the address IS the base58 of the 32-byte ed25519 pubkey, so publicKey
  // = base58Decode(address). A non-string / malformed entry is skipped (never
  // surfaced) rather than throwing the whole connect.
  private shapeAccounts(result: unknown): WalletAccount[] {
    if (!Array.isArray(result)) {
      return [];
    }
    const out: WalletAccount[] = [];
    for (const a of result) {
      if (typeof a !== 'string' || a.length === 0) {
        continue;
      }
      let publicKey: Uint8Array;
      try {
        publicKey = base58Decode(a);
      } catch {
        continue;
      }
      out.push({
        address: a,
        publicKey,
        chains: [this.stdChain],
        features: ACCOUNT_FEATURES,
      });
    }
    return out;
  }

  // solana:signMessage. Signs each input's message with its account, in order
  // (each round-trips → the desktop prompts per signature). The message rides the
  // wire as 0x-hex; the desktop returns the 64-byte ed25519 signature as base64,
  // which is decoded back to bytes. signedMessage echoes the input (the wallet
  // signs the raw message verbatim — no prefix). A rejected / failed signature
  // rejects the whole batch (Wallet-Standard has no partial-success shape).
  private async signMessage_(
    inputs: SolanaSignMessageInput[]
  ): Promise<SolanaSignMessageOutput[]> {
    const outputs: SolanaSignMessageOutput[] = [];
    for (const input of inputs) {
      const sig = await this.roundTrip('solana:signMessage', {
        address: input.account.address,
        message: bytesToHex0x(input.message),
      });
      // The host contract is a base64 string; a non-string is a contract breach.
      outputs.push({
        signedMessage: input.message,
        signature: base64Decode(
          expectString(sig, 'solana:signMessage', 'signature')
        ),
      });
    }
    return outputs;
  }

  // solana:signTransaction. Sign-only (the dApp broadcasts). The serialized tx
  // rides the wire as base64 (the host parses it); the host returns the signed
  // wire as base64, decoded back to bytes.
  private async signTransaction_(
    inputs: SolanaSignTransactionInput[]
  ): Promise<SolanaSignTransactionOutput[]> {
    const outputs: SolanaSignTransactionOutput[] = [];
    for (const input of inputs) {
      this.assertChain_(input.chain);
      await this.useCluster_(input.chain);
      const signed = await this.roundTrip('solana:signTransaction', {
        address: input.account.address,
        transaction: base64Encode(input.transaction),
      });
      outputs.push({
        signedTransaction: base64Decode(
          expectString(signed, 'solana:signTransaction', 'transaction')
        ),
      });
    }
    return outputs;
  }

  // solana:signAndSendTransaction. Sign AND broadcast (the wallet sends). The
  // host returns the broadcast transaction signature as base58 (the Solana RPC
  // sendTransaction result), decoded back to the 64-byte signature.
  //
  // input.options (preflightCommitment / skipPreflight / maxRetries /
  // minContextSlot) is forwarded as params.options — a WHITELIST of the four
  // Wallet-Standard send options with defined-values-only (the desktop
  // validates strictly and refuses unknown keys/shapes with 1100, so nothing
  // beyond the whitelist may ride along). An absent/empty options object is
  // simply omitted; a pre-options desktop ignores the extra params key, so
  // forwarding is backward-compatible.
  private async signAndSendTransaction_(
    inputs: SolanaSignAndSendTransactionInput[]
  ): Promise<SolanaSignAndSendTransactionOutput[]> {
    const outputs: SolanaSignAndSendTransactionOutput[] = [];
    for (const input of inputs) {
      this.assertChain_(input.chain);
      await this.useCluster_(input.chain);
      const params: Record<string, unknown> = {
        address: input.account.address,
        transaction: base64Encode(input.transaction),
      };
      const options = sendOptionsFrom(input.options);
      if (options !== null) {
        params.options = options;
      }
      const sig = await this.roundTrip('solana:signAndSendTransaction', params);
      outputs.push({
        signature: base58Decode(
          expectString(sig, 'solana:signAndSendTransaction', 'signature')
        ),
      });
    }
    return outputs;
  }

  // The wallet supports only the clusters it advertises; a dApp-requested chain
  // outside that set is refused (never silently signed on another cluster).
  private assertChain_(chain?: string): void {
    if (chain !== undefined && !SOLANA_CLUSTERS.has(chain)) {
      throw new Error(`unsupported chain: ${chain}`);
    }
  }

  // One desktop round-trip on this adapter's chain. A 4100 answer means the
  // desktop no longer grants this origin the accounts cached here (see
  // isUnauthorized — e.g. a session-only grant ended by a desktop restart):
  // forget them with Wallet Standard's own "no accounts" shape, the
  // change{accounts:[]} a desktop disconnect raises, then let the refusal reach
  // the dApp unchanged. The refusal answers THIS adapter's request only, so Sui,
  // on the same `wstd` namespace and transport, keeps its own accounts. Mirror of
  // the EVM provider's roundTrip, for the same reasons: the whole cache goes, and
  // no other code clears it.
  private async roundTrip(method: string, params: unknown): Promise<unknown> {
    try {
      return await this.transport.send('wstd', method, params, this.chainUrn);
    } catch (e) {
      if (isUnauthorized(e)) {
        this.setAccounts([]); // a no-op, and no event, on an empty set
      }
      throw e;
    }
  }

  private setAccounts(accounts: WalletAccount[]): void {
    if (sameAccounts(this.accounts_, accounts)) {
      return;
    }
    // Freeze so a dApp that reads `accounts` (or the connect result) cannot
    // push/splice into the wallet's live state — `readonly` is erased at runtime.
    this.accounts_ = Object.freeze(accounts) as WalletAccount[];
    const change: StandardEventsChange = { accounts: this.accounts_ };
    this.emitter.emit('change', change);
  }

  // A desktop push for this dApp. `accountsChanged` re-shapes the granted set;
  // `disconnect` (a desktop-initiated revoke in the wallet UI) clears it. Both
  // route through setAccounts, so each emits 'change' only when the set really
  // changed. Any other event name is not serviced.
  private handleEvent(
    ns: Namespace,
    event: string,
    data: unknown,
    chain?: string
  ): void {
    // Ignore pushes for a non-Wallet-Standard provider (EVM / TRON / TON Connect)
    // sharing this window. Solana and Sui BOTH serve `wstd`, so ns alone cannot
    // separate them — the desktop tags the push with its chain, and we react only
    // when it matches ours. A missing chain (a pre-chain desktop) means "no further
    // filter", preserving the earlier ns-only behaviour.
    if (ns !== 'wstd' || (chain && chain !== this.chainUrn)) {
      return;
    }
    if (event === 'accountsChanged') {
      this.setAccounts(this.shapeAccounts(data));
      return;
    }
    if (event === 'disconnect') {
      // A desktop-initiated disconnect (the user revoked this origin in the wallet
      // UI). Wallet-Standard models disconnection as the account set going empty
      // (there is no separate disconnect event in standard:events), so clear + emit
      // change{accounts:[]} — the same shape as a dApp-initiated standard:disconnect.
      // Solana and Sui share the `wstd` namespace, so BOTH adapters receive this
      // push; setAccounts is idempotent (an already-empty adapter no-ops), and the
      // desktop revoke is per-ORIGIN (every chain the origin was connected on is
      // disconnected together), so an adapter still holding accounts for this origin
      // is genuinely being disconnected — never a co-existing-chain false clear.
      this.setAccounts([]);
    }
  }
}

// Window registration lives in wallet_standard.ts (registerWallet) — shared with
// the Sui adapter. solana_inpage.ts imports it directly.
