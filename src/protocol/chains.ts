// The single source of truth for the mhda chain-key URNs the extension stamps on
// every chain-scoped wire frame. The desktop signer is the ultimate SSOT for
// chain identity — a non-canonical key is ultimately refused (no fallback makes
// it work), so the extension only ever PRODUCES keys here; it never parses or
// reconstructs them ad hoc in a provider.
//
// mhda 1.1 (extern/mhda, released 2026-07-04) redefined the grammar: a chain key
// is `nt:<network>:ci:<chain_id>` and the (network, chain_id) pair IS the
// identity. The SLIP-44 coin type (`ct:`) is no longer part of the key, and
// several network-type names were renamed. Centralising the grammar here means a
// future transition needs a single edit, not a five-provider sweep.

// The mhda network-type identifiers — the `nt:` component of a chain key. These
// are the 1.1 spellings and the ONLY ones the desktop accepts; the pre-1.1 short
// names (sol, tvm, btc, ...) are invalid, so they are deliberately absent.
export const MhdaNetwork = {
  Evm: 'evm',
  Solana: 'solana',
  Sui: 'sui',
  Tron: 'tron',
  Ton: 'ton',
} as const;
export type MhdaNetwork = (typeof MhdaNetwork)[keyof typeof MhdaNetwork];

// Build a canonical mhda 1.1 chain-key URN. This is the one place the extension
// encodes the grammar; every wire chain key flows through it, so a pre-1.1 shape
// (a `ct:` segment, a reordered component) cannot be produced by construction.
export function chainKey(network: MhdaNetwork, chainId: string): string {
  return `nt:${network}:ci:${chainId}`;
}

// The default (mainnet) chain key per ecosystem the providers bootstrap with.
// The desktop ships the full chain set; the extension hardcodes only these
// bootstrap defaults. A dApp moves off one via EIP-3326
// (wallet_switchEthereumChain), and the RESOLVED key always comes back from the
// desktop — the extension adopts it, never derives it. The desktop spells every
// EVM chain id in decimal (`nt:evm:ci:137`); hex lives only in EIP-1193's chainId.
export const EVM_MAINNET_CHAIN_URN = chainKey(MhdaNetwork.Evm, '1');
export const SOLANA_MAINNET_CHAIN_URN = chainKey(MhdaNetwork.Solana, 'mainnet');
// Solana's devnet: the one test cluster the desktop's manifest carries (`nt:solana:ci:devnet`), served beside
// mainnet by the Wallet Standard adapter (solana_wallet.ts) and switched to by a request that names it.
export const SOLANA_DEVNET_CHAIN_URN = chainKey(MhdaNetwork.Solana, 'devnet');
export const SUI_MAINNET_CHAIN_URN = chainKey(MhdaNetwork.Sui, 'mainnet');
export const TRON_MAINNET_CHAIN_URN = chainKey(MhdaNetwork.Tron, 'mainnet');
export const TON_MAINNET_CHAIN_URN = chainKey(MhdaNetwork.Ton, 'mainnet');
