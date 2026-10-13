// Shared Wallet-Standard primitives for the in-tree wallet adapters (Solana +
// Sui) — no @wallet-standard npm dependency. The account/wallet shapes and the
// window registration are ecosystem-agnostic; each adapter (AirNoxSolanaWallet,
// AirNoxSuiWallet) provides its own chains + features + sign round-trips and
// reuses these.

// The brand a dApp sees (name + mark) is shared with the EIP-1193 provider and
// lives in brand.ts; re-exported here so the two Wallet-Standard adapters keep
// importing it from the module that defines their wallet shape.
export { AIRNOX_ICON_DATA_URI, AIRNOX_NAME } from './brand';

// ── Wallet-Standard interfaces ───────────────────────────────────────────────
export interface WalletAccount {
  readonly address: string;
  readonly publicKey: Uint8Array;
  readonly chains: readonly string[];
  readonly features: readonly string[];
  readonly label?: string;
  readonly icon?: string;
}

export interface Wallet {
  readonly version: '1.0.0';
  readonly name: string;
  readonly icon: string;
  readonly chains: readonly string[];
  readonly features: Record<string, unknown>;
  readonly accounts: readonly WalletAccount[];
}

// The 'change' event the standard:events feature emits.
export interface StandardEventsChange {
  accounts?: readonly WalletAccount[];
}

// True iff the two account lists hold the same addresses in the same order — the
// cheap identity check that gates a 'change' emission.
export function sameAccounts(
  a: readonly WalletAccount[],
  b: readonly WalletAccount[]
): boolean {
  return a.length === b.length && a.every((x, i) => x.address === b[i].address);
}

// ── Wallet-Standard window registration ───────────────────────────────────────
// The wallet dispatches a `wallet-standard:register-wallet` event whose detail is
// a callback the dApp invokes with its registration API; and it also listens for
// `wallet-standard:app-ready` (a late-loading dApp) to register on demand. Both
// are best-effort (a non-DOM context simply registers nothing).
// `onTouch` fires when the PAGE takes part in the handshake — it answered our
// register-wallet dispatch with a registry, or it announced itself app-ready.
// Either one means a wallet-standard app is running here, which is what makes
// this a dApp tab (activity.ts). Our own dispatch, on a page with no registry,
// touches nothing.
export function registerWallet(wallet: Wallet, onTouch: () => void): void {
  const callback = ({ register }: { register: (w: Wallet) => void }) => {
    onTouch();
    register(wallet);
  };
  try {
    window.dispatchEvent(new RegisterWalletEvent(callback));
  } catch {
    // best-effort
  }
  try {
    window.addEventListener('wallet-standard:app-ready', (event: Event) => {
      const api = (event as CustomEvent).detail as {
        register: (w: Wallet) => void;
      };
      callback(api);
    });
  } catch {
    // best-effort
  }
}

class RegisterWalletEvent extends Event {
  readonly #detail: (api: { register: (w: Wallet) => void }) => void;

  get detail(): (api: { register: (w: Wallet) => void }) => void {
    return this.#detail;
  }

  constructor(callback: (api: { register: (w: Wallet) => void }) => void) {
    super('wallet-standard:register-wallet', {
      bubbles: false,
      cancelable: false,
      composed: false,
    });
    this.#detail = callback;
  }
}
