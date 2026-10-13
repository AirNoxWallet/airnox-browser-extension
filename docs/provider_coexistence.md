# When another wallet holds the provider (study, 2026-10-11)

The rule: if Brave, another browser or another wallet has
already taken a provider global, AirNox does not take it back, in any browser.
Instead the popup tells the user, for the active tab, that another web3 wallet
controls that page. This document records how browsers and wallets actually
behave, what the extension does as a result, and what a real browser run still
has to confirm.

Sources were read on 2026-10-11 from the projects' public code and docs. Each
claim names its source and the date of the commit, release or page ("no date"
where the page has none). UNCONFIRMED marks a claim with no primary source.

## The globals in question

| Global                          | Ours | Who else installs it                                          |
| ------------------------------- | ---- | ------------------------------------------------------------- |
| `window.ethereum`               | yes  | Brave Wallet, MetaMask, Rabby, Phantom, Coinbase, OKX, ...    |
| `tronWeb` / `tronLink` / `tron` | yes  | TronLink (no browser installs a TRON global)                  |
| `window.airnox` (TON Connect)   | yes  | nobody: no key in the TON wallets list is `airnox`            |
| `window.solana` / `phantom`     | no   | Brave Wallet, Phantom; we serve Solana by the Wallet Standard |
| Sui                             | no   | Wallet Standard only                                          |

The Wallet Standard (`wallet-standard:register-wallet` / `app-ready`) and
EIP-6963 (`eip6963:announceProvider`) are lists, not slots: every wallet
registers next to every other, so there is nothing to take over there. AirNox
keeps announcing on both whoever holds the legacy globals.

## Browsers

**Brave** (brave/brave-core, master read 2026-10-11).

- Settings: "Brave Wallet", "Extensions (Brave Wallet fallback)" (the default
  for Ethereum and Solana) and "Extensions (no fallback)"
  (`components/brave_wallet/common/brave_wallet.mojom`,
  `components/brave_wallet/browser/pref_names.cc`).
- Since commit d7839dcd4 (2026-08-19, "Only Inject web3 providers once a wallet
  is created") Brave injects nothing until the user has created a Brave wallet.
  The first release that ships it is UNCONFIRMED.
- Injection runs in `RenderFrameObserver::DidClearWindowObject`
  (`renderer/brave_wallet/brave_wallet_render_frame_observer.cc`, 2026-09-01),
  so it precedes every document_start content script (inferred from Chromium's
  lifecycle; no Brave doc states it). http(s) secure contexts only, and only
  where the `ethereum` / `solana` Permissions Policy allows it.
- "Brave Wallet": `window.braveEthereum` and, if absent, `window.ethereum` are
  data properties, non-writable and non-configurable (`SetProviderNonWritable`,
  `v8_helper.cc`; `js_ethereum_provider.cc`, 2026-10-10). Nothing can replace
  them.
- "Extensions (Brave Wallet fallback)": `window.ethereum` is a plain writable,
  configurable data property, skipped when the MetaMask extension is enabled
  (detected by its id only). So on the default setting, with a Brave wallet
  created and no MetaMask, `window.ethereum` is Brave's before our script runs.
- "Extensions (no fallback)": nothing injected, no EIP-6963.
- The provider is a Proxy flagged `isBraveWallet: true` and `isMetaMask: true`.
- EIP-6963: announced as `com.brave.wallet` in every mode but "no fallback",
  first at `DidFinishLoad`, i.e. after the load event (commit 4b86330bc,
  2025-12-15).
- Solana (`js_solana_provider.cc`, 2026-06-03): `window.solana` locked in
  "Brave Wallet", writable in the fallback mode, and NOT checked for an existing
  value. No TRON or TON globals anywhere in brave-core.
- Settings doc: https://wallet-docs.brave.com/default-wallet/ (no date).

**Opera.** The built-in Crypto Wallet stopped working on 2025-07-15 and was
removed from Opera One and GX on 2026-01-01
(https://blogs.opera.com/desktop/2025/06/how-to-migrate-your-opera-crypto-wallet-on-desktop/,
2025-06-20). The Wallet Selector, a per-site picker among installed EIP-1193
wallets (https://blogs.opera.com/crypto/2022/10/multi-wallet-extension-management-wallet-selector/,
2022-10-28), may still intercept assignments to `window.ethereum`: Rabby's page
provider assigns instead of defining on Opera (`RabbyHub/page-provider`
`src/index.ts`, "fix: opera", 2023-10-25). Whether the Selector still exists in
2026, how it wraps providers and whether it announces EIP-6963 are UNCONFIRMED
(closed source); the `isOpera` flag is known only from search snippets.

**Edge** had a Windows-only CryptoWallet, obsolete from Edge 128
(https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/cryptowalletenabled,
2026-05-20). **Chrome, Firefox, Safari**: no built-in wallet found
(UNCONFIRMED: absence of evidence).

## Wallet extensions

- **MetaMask** (metamask-extension, 2026-10-07; MetaMask/providers
  `src/initializeInpageProvider.ts`, 2025-04-28): a MAIN-world document_start
  content script that does not look for an existing provider and sets the
  global by plain assignment, `window.ethereum = provider`, in strict-mode code,
  inside a try/catch. Against a getter with no setter that assignment throws,
  MetaMask logs it and leaves `window.ethereum` to whoever held it; it still
  announces EIP-6963. No re-assertion, and no special case for `isBraveWallet`.
- **Rabby** (Rabby `_raw/sw.js`, 2026-08-27; `@rabby-wallet/page-provider`
  0.4.11, 2026-03-06): registered MAIN-world document_start script. When
  `window.ethereum` is absent or configurable it defines a getter with
  `configurable: false`, which replaces ours and locks the global; otherwise it
  assigns. Its getter is a router that forwards to a user-chosen EIP-6963
  provider; it reads the previous holder's `window.ethereum` once at install.
  Announces `io.rabby` (and `io.metamask` in its MetaMask mode).
- **Phantom, Coinbase Wallet, OKX, Trust Wallet**: no public extension source.
  Phantom exposes `window.phantom.ethereum` / `.solana` and may also hold
  `window.ethereum` / `window.solana` (docs.phantom.com, no date); Coinbase keeps
  `window.coinbaseWalletExtension` and a `window.ethereum.providers` array; OKX
  `window.okxwallet`. Descriptors, timing and their "default wallet" toggles are
  UNCONFIRMED.
- **TronLink** (https://developers.tron.network/docs/tronlink-integration,
  2026-08-18): the provider is `window.tron`; `tronLink` and `tronWeb` remain for
  compatibility, `tronWeb` being `false` until the site is authorised. It
  injects late (`tronLink#initialized`; the docs wait up to about 3 s) and
  announces through TIP-6963. Descriptor UNCONFIRMED.
- **TON wallets**: none of the 25 bridge keys in ton-blockchain/wallets-list
  `wallets-v2.json` (2026-10-11) is `airnox`. Tonkeeper assigns
  `window.tonkeeper` from an async script tag (tonkeeper-web, 2025-07-18);
  MyTonWallet assigns `window.mytonwallet` and sets `window.ethereum` only if it
  is absent (2026-10-06).

The standards: EIP-1193 (Final) calls `window.ethereum` a convention outside
the specification. EIP-6963 (Final, 2023-05-01) names the race ("the last wallet
to load usually wins"), keeps `window.ethereum` as a fallback for dApps, and
requires a UUIDv4 per page session, a reverse-DNS `rdns` and a data-URI icon.

## What this means for the extension

1. **Who is first is not ours to decide.** A browser wallet is always first;
   between extensions, the order of document_start scripts is unspecified. So
   the rule has to hold both ways: never take a global that exists, and never
   keep one from a wallet that comes later.
2. **A getter with no setter took MetaMask's place.** When our script ran
   first, MetaMask's strict-mode assignment threw and MetaMask lost
   `window.ethereum`. The same applies to TronLink, Tonkeeper-style and
   MyTonWallet-style assignments. Our accessor now has a setter that gives the
   global away: the assignment becomes an ordinary writable, configurable,
   enumerable data property holding the assigned value, as if ours had never
   been there. A wallet that redefines (Rabby) already could.
3. **Presence is decided by the descriptor, not by reading the value.** A
   global that exists at install time is left alone even when it holds nothing
   (TronLink's `tronWeb = false` placeholder): only a browser or another
   extension can have put it there before our script. A foreign getter is never
   called to find out; any accessor that is not ours counts as held.
4. **The notice is asked for, not pushed.** Only the main world can see who
   holds a global. When the popup opens, it sends a runtime message to the
   active tab's top frame; the content script probes the page and returns the
   main world's answer (or nothing after 500 ms). No page posts anything and no
   service worker wakes just because another wallet is installed, which for a
   MetaMask user would be every page. The answer reflects the page at the
   moment the popup opens, so a late injector (TronLink after seconds) is seen.
5. **What the popup says.** "Another web3 wallet controls this page", and which
   ecosystems: "Ethereum", "TRON" (any of the three TRON globals) and "TON",
   with "A dApp that offers a list of wallets can still connect to AirNox." when
   Ethereum is among them (EIP-6963). It does not name the other wallet: the
   flags are claims (`isMetaMask` is set by Brave, Rabby and others) and a
   Proxy can answer for a different wallet than its own.
6. **Trust.** The answer comes from the page's own world, so a page can forge
   it. That is page-confined: a page could equally hold `window.ethereum`
   itself, and the answer only decides a notice about that page. The registry
   captures `Object.getOwnPropertyDescriptor`, `Object.defineProperty` and
   `Object.create` when our script runs, tells a descriptor's kind by its own
   keys and builds its descriptors with no prototype, so a page that later
   patches `Object` or plants `get` / `value` on `Object.prototype` neither
   bends a typical report nor breaks the setter that gives the global away.

## Not done here, and why

- Solana's `window.solana` is not watched: we never install it, so another
  wallet holding it takes nothing from AirNox (Wallet-Standard dApps still list
  AirNox).
- We do not answer TIP-6963 (TRON's multi-wallet discovery): a new provider
  surface, outside this rule.
- Rabby's install reads the previous `window.ethereum` once, which on a page
  with Rabby reads ours and reports a touch, lighting our toolbar badge on every
  page. Behaviour of the badge, not of this rule; recorded for the browser tests.
- A `<div id="ethereum">` makes `window.ethereum` resolve to the element through
  the DOM's named access. Only own properties of the window are considered, so
  it is not mistaken for a wallet.

## Owed to a browser run

On Chrome, Brave, Opera and Firefox 140, with throwaway profiles:

- Brave, each of the three settings, with and without a Brave wallet created:
  the holder of `window.ethereum` / `window.solana` at document_start and after
  load, and the popup's notice.
- Opera: whether the Wallet Selector still exists and what it does to
  `window.ethereum` (assignment interception), with the notice.
- MetaMask installed with AirNox, both install orders: MetaMask ends up holding
  `window.ethereum` without an error in its console, the notice shows, and an
  EIP-6963 dApp still lists AirNox.
- Rabby installed with AirNox: Rabby holds `window.ethereum` (locked), the
  notice shows.
- TronLink: it gets `tron` / `tronLink` / `tronWeb` after its late injection,
  and the notice names TRON.
- A wallet-free page: no notice; a browser page (`chrome://`, the store): no
  notice and no error in the popup.
