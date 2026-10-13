// The Wallet-Standard adapter for Sui. It holds NO keys: the desktop derives +
// signs + enforces permissions. Every feature round-trips through the injected
// Transport on the `wstd` namespace (shared with Solana — the desktop routes by
// chain); accountsChanged pushes arrive via the same Transport.onEvent channel.
// Decoupled from the postMessage wiring + window registration for testability —
// mirror of AirNoxSolanaWallet, reusing the shared wallet_standard primitives.
//
// Features: standard:connect/disconnect/events + the account shaping that
// consumes the desktop's pubkey-enriched connect reply, plus the three Sui
// signing features — sui:signPersonalMessage, sui:signTransaction (sign-only,
// the dApp submits), and sui:signAndExecuteTransaction (the wallet submits).
// Every Sui feature is SINGLE-input/single-output per @mysten/wallet-standard
// (NOT the Solana batch shape). For the transaction features the dApp passes an
// unresolved transaction object; the adapter `await`s its toJSON() and ships
// that JSON — the desktop resolves + builds + signs (host-build).
//
// The legacy *Block aliases (sui:signTransactionBlock /
// sui:signAndExecuteTransactionBlock) are NOT exposed as Wallet-Standard
// features here: their @mysten contract differs materially (a Transaction object
// input, and for signAndExecuteTransactionBlock a parsed SuiTransactionBlockResponse
// output that cannot be reproduced from the desktop's base64-BCS reply without
// pulling in @mysten/sui, which this inpage deliberately avoids). The desktop
// still routes those method strings as aliases for robustness. Modern dApps
// (dapp-kit / current @mysten/wallet-standard) use the non-Block features.

import { SUI_MAINNET_CHAIN_URN } from '../protocol/chains';
import { base64Encode, bytesToHex0x, hexDecode } from './encoding';
import { Emitter } from './emitter';
import { expectString, expectStringField } from './expect_string';
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

export type { Wallet, WalletAccount } from './wallet_standard';

// The features an account is usable with (the Wallet-Standard account `features`
// list). Advertises only what is implemented, so a dApp never sees a feature
// without a handler.
const ACCOUNT_FEATURES: readonly string[] = [
  'sui:signPersonalMessage',
  'sui:signTransaction',
  'sui:signAndExecuteTransaction',
];

// The wire chain (mhda URN) the desktop dispatcher expects is the SSOT
// `SUI_MAINNET_CHAIN_URN` from the chain registry. `SUI_STD_CHAIN` is the
// Wallet-Standard chain identifier the dApp sees — a different namespace (CAIP-2
// style), NOT an mhda URN, so it stays local to the adapter.
export const SUI_STD_CHAIN = 'sui:mainnet';

// sui:signPersonalMessage I/O (Wallet-Standard). SINGLE input → single output
// (per @mysten/wallet-standard — Sui is not batch like Solana). The output
// `bytes` is the base64 of the signed message and `signature` is the base64 of
// the 97-byte serialized Sui signature (flag || sig || pubkey) — both strings
// (unlike Solana's Uint8Array outputs).
export interface SuiSignPersonalMessageInput {
  readonly account: WalletAccount;
  readonly message: Uint8Array;
}
export interface SuiSignPersonalMessageOutput {
  readonly bytes: string;
  readonly signature: string;
}

// sui:signTransaction / sui:signAndExecuteTransaction I/O (Wallet-Standard).
// SINGLE input → single output. The dApp passes an UNRESOLVED transaction whose
// toJSON() yields the @mysten Transaction JSON; the adapter ships that JSON and
// the desktop resolves + builds + signs (host-build). `chain` is the
// Wallet-Standard chain identifier (e.g. "sui:mainnet").
export interface SuiSignTransactionInput {
  readonly transaction: { toJSON(): Promise<string> };
  readonly account: WalletAccount;
  readonly chain: string;
}
// signTransaction is sign-only: { bytes, signature } (the dApp submits). `bytes`
// is the base64 BCS(TransactionData) the desktop built, `signature` the base64
// serialized signature.
export interface SuiSignTransactionOutput {
  readonly bytes: string;
  readonly signature: string;
}
// signAndExecuteTransaction adds the execution `digest` and base64 BCS `effects`
// (the wallet submits); `bytes`/`signature` are as above.
export type SuiSignAndExecuteTransactionInput = SuiSignTransactionInput;
export interface SuiSignAndExecuteTransactionOutput {
  readonly digest: string;
  readonly bytes: string;
  readonly signature: string;
  readonly effects: string;
}

export class AirNoxSuiWallet implements Wallet {
  readonly version = '1.0.0' as const;
  readonly name = AIRNOX_NAME;
  readonly icon = AIRNOX_ICON_DATA_URI;
  readonly chains: readonly string[];

  private accounts_: WalletAccount[] = [];
  private readonly emitter = new Emitter();
  private readonly features_: Record<string, unknown>;

  constructor(
    private readonly transport: Transport,
    private readonly chainUrn: string = SUI_MAINNET_CHAIN_URN,
    private readonly stdChain: string = SUI_STD_CHAIN
  ) {
    this.chains = [stdChain];
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
      'sui:signPersonalMessage': {
        version: '1.0.0',
        signPersonalMessage: (input: SuiSignPersonalMessageInput) =>
          this.signPersonalMessage_(input),
      },
      'sui:signTransaction': {
        version: '1.0.0',
        signTransaction: (input: SuiSignTransactionInput) =>
          this.signTransaction_(input),
      },
      'sui:signAndExecuteTransaction': {
        version: '1.0.0',
        signAndExecuteTransaction: (input: SuiSignAndExecuteTransactionInput) =>
          this.signAndExecuteTransaction_(input),
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
  // connect this session.
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

  // standard:disconnect (dApp-initiated): clear the local accounts + emit 'change'.
  // This only forgets the session locally — the desktop grant persists until the
  // user revokes it in the wallet UI, which then pushes a `wstd disconnect`
  // (handled in handleEvent). Both paths converge on setAccounts([]).
  private disconnect_(): Promise<void> {
    this.setAccounts([]);
    return Promise.resolve();
  }

  // Shape the desktop's granted-account array into WalletAccount objects. For Sui
  // each entry is a { address, publicKey } object — a Sui address is
  // Blake2b-256(flag||pubkey), so the dApp cannot recover the pubkey from it; the
  // desktop's connect reply carries it as bare lowercase hex. A non-object /
  // malformed entry is skipped (never surfaced) rather than throwing the whole
  // connect.
  private shapeAccounts(result: unknown): WalletAccount[] {
    if (!Array.isArray(result)) {
      return [];
    }
    const out: WalletAccount[] = [];
    for (const a of result) {
      // A bare-string entry (the host's pubkey-resolution missed for this
      // account) is intentionally DROPPED, not accepted: a Sui WalletAccount
      // needs the real pubkey, and a Sui address cannot yield it — so the only
      // honest options are the enriched object or nothing. Do NOT "fix" this
      // guard to accept strings; that would force a guessed/absent pubkey.
      if (
        typeof a !== 'object' ||
        a === null ||
        typeof (a as { address?: unknown }).address !== 'string' ||
        typeof (a as { publicKey?: unknown }).publicKey !== 'string'
      ) {
        continue;
      }
      const entry = a as { address: string; publicKey: string };
      if (entry.address.length === 0) {
        continue;
      }
      let publicKey: Uint8Array;
      try {
        publicKey = hexDecode(entry.publicKey);
      } catch {
        continue;
      }
      out.push({
        address: entry.address,
        publicKey,
        chains: [this.stdChain],
        features: ACCOUNT_FEATURES,
      });
    }
    return out;
  }

  // sui:signPersonalMessage. The message rides the wire as 0x-hex; the desktop
  // intent-wraps it (PersonalMessage scope) + Blake2b-digests + Ed25519-signs and
  // returns the 97-byte serialized signature as base64. `bytes` echoes the signed
  // message (base64). A rejected / failed signature rejects.
  private async signPersonalMessage_(
    input: SuiSignPersonalMessageInput
  ): Promise<SuiSignPersonalMessageOutput> {
    const sig = await this.roundTrip('sui:signPersonalMessage', {
      address: input.account.address,
      message: bytesToHex0x(input.message),
    });
    // The host contract here is a BARE base64 string (not an object, unlike the
    // transaction features), so expectStringField does not apply — a non-string
    // is a contract breach; fail loud rather than coerce a silently-wrong sig.
    return {
      bytes: base64Encode(input.message),
      signature: expectString(sig, 'sui:signPersonalMessage', 'signature'),
    };
  }

  // Refuse a dApp-requested chain outside the advertised set — never silently
  // build/sign on the default chain (mirror of the Solana adapter's guard). An
  // absent chain is allowed (the adapter uses its single configured chain).
  private assertChain_(chain?: string): void {
    if (chain !== undefined && !this.chains.includes(chain)) {
      throw new Error(`unsupported chain: ${chain}`);
    }
  }

  // sui:signTransaction (host-build, sign-only). `await`s the dApp's UNRESOLVED
  // transaction.toJSON() and ships that JSON; the desktop resolves + builds +
  // signs (stamping its own account as the sender) and returns
  // { bytes, signature } (base64). The dApp submits the pair itself. A rejected /
  // failed signature rejects.
  private async signTransaction_(
    input: SuiSignTransactionInput
  ): Promise<SuiSignTransactionOutput> {
    this.assertChain_(input.chain);
    const transaction = await input.transaction.toJSON();
    const result = await this.roundTrip('sui:signTransaction', {
      address: input.account.address,
      transaction,
    });
    return {
      bytes: expectStringField(result, 'bytes', 'sui:signTransaction'),
      signature: expectStringField(result, 'signature', 'sui:signTransaction'),
    };
  }

  // sui:signAndExecuteTransaction (host-build, the wallet submits). Same send as
  // signTransaction but the desktop also broadcasts and returns the full
  // { digest, bytes, signature, effects } reply (effects is base64 BCS, "" if the
  // node omitted it). A rejected / failed execution rejects.
  private async signAndExecuteTransaction_(
    input: SuiSignAndExecuteTransactionInput
  ): Promise<SuiSignAndExecuteTransactionOutput> {
    this.assertChain_(input.chain);
    const transaction = await input.transaction.toJSON();
    const result = await this.roundTrip('sui:signAndExecuteTransaction', {
      address: input.account.address,
      transaction,
    });
    const method = 'sui:signAndExecuteTransaction';
    return {
      digest: expectStringField(result, 'digest', method),
      bytes: expectStringField(result, 'bytes', method),
      signature: expectStringField(result, 'signature', method),
      effects: expectStringField(result, 'effects', method),
    };
  }

  // One desktop round-trip on this adapter's chain. A 4100 answer means the
  // desktop no longer grants this origin the accounts cached here (see
  // isUnauthorized — e.g. a session-only grant ended by a desktop restart):
  // forget them with Wallet Standard's own "no accounts" shape, the
  // change{accounts:[]} a desktop disconnect raises, then let the refusal reach
  // the dApp unchanged. The refusal answers THIS adapter's request only, so
  // Solana, on the same `wstd` namespace and transport, keeps its own accounts.
  // Mirror of the EVM provider's roundTrip, for the same reasons: the whole
  // cache goes, and no other code clears it.
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
    // sharing this window. Sui and Solana BOTH serve `wstd`, so ns alone cannot
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
