# Publishing runbook — Chrome Web Store and Mozilla (self-hosted)

This is the working checklist for the first public release. It records what was
verified, what is still missing, and the order in which the stores and the
desktop release go out.

## Distribution decisions

| Decision                | Value                                                                          |
| ----------------------- | ------------------------------------------------------------------------------ |
| First published version | `0.1.0` (unchanged)                                                            |
| Chrome                  | Chrome Web Store, listed                                                       |
| Mozilla                 | **Self-hosted (unlisted)** — AMO signs the XPI, distribution from `airnox.app` |
| Release gate            | **After loopback mutual authentication** — met by protocol `2.3.1`, see below  |

### Why the release waited for mutual authentication

Loopback mutual authentication (`docs/rfc_web3_loopback_mutual_auth.md`)
replaced the `iid`-only pairing with a per-pairing secret, set up once by a
code the desktop shows, and an HMAC challenge-response on every socket. It is a
breaking wire change, so it bumped the protocol `major` to 3 on both sides.
Publishing before it would have meant an immediate forced re-submission of both
store artifacts, and a window in which installed extensions spoke the older
wire and were refused by an updated desktop with `VersionIncompatible (1103)`
until the user updated. Both sides now speak `2.3.1`, so the gate is met.

## What is verified

Re-check each line on the release candidate.

- **Protocol lockstep** (2026-10-13). Both sides on `2.3.1`. Chain URNs,
  namespaces, error codes, the AUTO port list and the handshake's known-answer
  vectors match the desktop byte-for-byte.
- **Gates green** (2026-10-13). `npm run typecheck`, `npm run lint`, `npm test`
  (624 tests), and `npm run e2e` (Chromium, ten scenarios: the version gate both
  ways, connect + sign + broadcast APPROVED and REFUSED across EVM, Solana, Sui,
  TON Connect and TRON, the per-tab badge, a desktop restart, pushes about
  another chain, held sessions, and pairing by code with every socket
  authenticated).

Checked on 2026-08-21, before the protocol 3 work:

- **Packages build clean.** `npm run package` produces both zips, about 103 KB
  each, 18 files.
- **AMO lint clean.** `web-ext lint -s dist/dist-firefox --self-hosted`:
  0 errors, 0 warnings, 0 notices.
- **Chrome loads without install warnings**, and grants `ws://127.0.0.1/*` as a
  valid host permission (verified via `chrome.permissions.getAll()` in the
  service worker).
- **No review red flags in the bundles.** No `eval`, no `new Function`, no remote
  code, no external network hosts. The build does not minify, so a reviewer reads
  the same code that is in the repository.

## Open items

### 1. Firefox MV3 host permissions — must be verified by hand (highest risk)

Firefox treats MV3 `host_permissions` differently from Chrome. If
`ws://127.0.0.1/*` is not granted at install time, the service worker cannot open
the desktop socket and the extension is inert until the user grants it manually.

This could not be verified automatically with a snap-packaged Firefox, which
defeats `web-ext run`, Marionette and the remote
debugging port. Verify by hand before submitting:

1. `about:debugging#/runtime/this-firefox` -> Load Temporary Add-on ->
   `dist/dist-firefox/manifest.json`.
2. Start the desktop wallet (or `node e2e/desktop_stub.mjs` equivalent on 8114).
3. Open a dApp and call `eth_requestAccounts`.
4. Inspect the extension's permission panel for the loopback host permission.

If the permission is not granted at install, the fix is a deliberate design
decision, not a workaround: request it explicitly at first use via
`permissions.request()` from a user gesture in the popup, with an explanatory
state in the popup UI. Do not paper over it with a retry loop.

Items keep their number once assigned, closed or not, so a closed item is
marked here rather than renumbered away.

### 2. Branding placeholders still ship — CLOSED

The placeholder mark is gone: `src/inpage/brand.ts` is now the single brand SSOT,
and `provider.ts` / `wallet_standard.ts` re-export from it. Its icon is the
brand guidelines' FLAT mark, `assets/airnox-icon-flat.svg`,
inlined as a base64 SVG data URI (about 2 KB; `test/brand.test.ts` holds the
copy to the file). This is what dApps show in EIP-6963 wallet pickers and Wallet
Standard connect modals, so it stays worth re-checking visually before
submission — but there is nothing left to replace.

### 3. Manifest icon set stops at 96 — CLOSED

`manifest.json` now declares 16/32/48/96/**128**, and `icons/icon-128.png` is
tracked. Chrome uses the 128 for the installation dialog and the extensions
management page; the store listing takes its own padded icon (item 5). The set follows the brand
guidelines' size rule: 16/32/48 are the FLAT mark
(`assets/airnox-icon-flat.svg`), 96/128 the METAL one (`assets/airnox-icon.svg`),
all cut from the brand's media kit.

### 4. Self-hosted Firefox distribution — manifest side wired, hosting open

`firefox.json` now carries, under `browser_specific_settings.gecko`:

- `update_url`: `https://airnox.app/extension/firefox/updates.json`.
- `strict_min_version`: `140.0`, the first Firefox with the built-in
  data-consent UI; it also covers MAIN-world content scripts (128) and
  `storage.session` (115). An older Firefox refuses the install.
- `data_collection_permissions`: `{ "required": ["none"] }`.

`firefox_updates.json` is the shape of the update manifest served at that URL:
one entry per released version, with `{version}` and `{sha256}` to be filled by
the packaging step from the signed XPI, which is served next to it as
`airnox-<version>.xpi`. Still open: generating it at packaging time and hosting
both files on `airnox.app`.

Signing for an unlisted add-on is `web-ext sign --channel=unlisted` with AMO API
credentials (`web-ext` is pinned at 10.7.0).

### 5. Store listing assets: the icon exists, the rest is missing

The extension is named **AirNox** (manifest `name`, `short_name` and the
toolbar title; the name dApps see in EIP-6963, Wallet Standard and TON
Connect). The desktop application it serves keeps its name, **AirNox Wallet**.
The manifest's `description` is the store summary (at most 132 characters):
"Connects web3 sites to the AirNox Wallet desktop app, which keeps your keys
and asks you to approve every request." The site is `https://airnox.app`
(`homepage_url`, and the popup's header links to it).

Present: `store/chrome-web-store-icon-128.png`, the Chrome Web Store icon:
128x128, the metal 96 px mark (the pixels of `icons/icon-96.png`) on 16 px of
transparent padding, as the store asks. It is uploaded in the dashboard and is
not packaged; the manifest's own `icons/icon-128.png` stays full bleed.
`test/store_icon.test.ts` holds both.

Still missing (no artwork is invented here; each needs a design pass or a
running desktop):

| Store            | Asset                                                                 | Size                | Required?                        |
| ---------------- | --------------------------------------------------------------------- | ------------------- | -------------------------------- |
| Chrome Web Store | screenshots (a running desktop and a dApp in frame)                   | 1280x800 or 640x400 | at least 1, up to 5              |
| Chrome Web Store | small promo tile                                                      | 440x280             | yes                              |
| Chrome Web Store | marquee promo tile                                                    | 1400x560            | no (only for featuring)          |
| Chrome Web Store | privacy-policy page on `airnox.app`, with the Limited Use statement   | a URL               | yes                              |
| Chrome Web Store | listing copy: the full description and a category                     | text                | yes                              |
| airnox.app       | the Firefox download page, `updates.json` and the signed XPI (item 4) | files on the site   | yes, for the self-hosted channel |

Firefox is unlisted (AMO signs, no listing page) and there is no Opera
listing (Opera users install from the Chrome Web Store), so neither store
needs listing assets.

The privacy policy's content is simple and honest for this extension: it
stores an instance UUID, the transport settings and the pairing key (a
non-extractable key that the desktop shares, set up by a code the desktop
shows), talks to nothing but `127.0.0.1`, and transmits no data off the
machine.

Source: [Chrome Web Store images](https://developer.chrome.com/docs/webstore/images).

### 6. Reviewer testability — the likeliest cause of rejection

Both stores' reviewers will install the extension and find that it does nothing:
without the AirNox Wallet desktop application running on loopback, there is no
wallet to talk to. A reviewer who cannot exercise the extension may reject it as
non-functional.

Mitigate in the submission notes, on both stores:

- State plainly that this is a **companion extension** to a desktop application
  and cannot function alone.
- Give a direct download link to a desktop build for the reviewer's platform,
  plus the exact steps: install, launch, enable web3 in settings, then connect
  from a dApp.
- Explain the loopback design in one paragraph — why `ws://127.0.0.1` is the
  entire network surface, and that keys never enter the browser.

### 7. Source code submission for AMO

The build bundles with esbuild. It does not minify, but it does concatenate, so
AMO requires the sources: the repository as-is (with `package-lock.json`) plus a
note naming the environment and the command. AMO's reviewer rebuilds and
requires no differences.

- Environment: Node 24 (`.nvmrc`; `engines` with `engine-strict` refuses any
  other major at `npm ci`) and npm 11.
- Command, from a fresh clone: `npm ci && npm run build:firefox`.
- Check: the build prints `sha256 <digest>  dist/dist-firefox`, a digest of the
  unpacked tree (each file's sha256 and path, sorted, hashed again;
  `treeDigest` in `buildUtils.ts`). Record it with the submission. It names the
  package's content, not the zip, whose entries carry timestamps.

Every build starts from an empty `dist/<target>`, so nothing from an earlier
build reaches a package, and any failed step fails the command. Build a release
from a fresh `npm ci` checkout: a `node_modules` reached through a symlink puts
a different path into the bundles' module comments.

### 8. Repository hygiene — CLOSED

`LICENSE` holds the Apache-2.0 text `package.json` declares.
`THIRD_PARTY_NOTICES` names each package bundled into a shipped script (today
`uuid`, MIT, and `webextension-polyfill`, MPL-2.0, with where its Source Code
Form is), with its licence text. The build copies both files into every
package; `test/third_party_notices.test.ts` fails when a bundled package or its
version is missing from the notices.

## Permission justifications

Prepared answers for the Chrome Web Store privacy tab. Each is minimal and true.

| Permission                                        | Justification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `storage`                                         | `storage.local` keeps the extension instance id (a UUID used as the desktop pairing handle), the user's transport mode and port, the popup's theme choice and, after a failed desktop proof, the fingerprint of the pairing key that is no longer offered. `storage.session` keeps the desktop's session and resume tokens and the pairing-window cooldown for the browser session only. The pairing key itself is a non-extractable WebCrypto key in IndexedDB. No wallet, account or browsing data.                    |
| `alarms`                                          | Drives the once-a-minute heartbeat that reports desktop connection state on the toolbar badge. MV3 service workers are evicted when idle, so an alarm is the only way to schedule it.                                                                                                                                                                                                                                                                                                                                    |
| `host_permissions: ws://127.0.0.1/*`              | The extension's entire network surface. It connects only to the AirNox Wallet desktop application on loopback; keys and signing stay in that application. Chrome gates the service worker's WebSocket on this permission.                                                                                                                                                                                                                                                                                                |
| Content scripts on `http://*/*` and `https://*/*` | The web3 provider objects a dApp expects (`window.ethereum`, Wallet Standard, TON Connect, TronWeb) must exist at `document_start` on any site the user chooses to visit, so one script runs in the page's main world. The extension cannot know in advance which sites are dApps. The isolated-world script reads no page content; it stamps the page's origin onto requests and relays them, and opens its connection to the extension only when the page reaches for a provider. No extension file is web-accessible. |

**Single purpose statement**: to expose the user's AirNox Wallet desktop
application to web3 sites through the standard provider interfaces, and to relay
each request to that application for approval and signing.

**Data usage**: no data is collected, transmitted off the machine, or sold. The
extension makes no network requests other than to `127.0.0.1`.

## Release sequence

Once the open items above are closed:

1. If the release changes the wire protocol, bump its version in all **six** places — here:
   `src/protocol/envelope.ts` (the SSOT), `test/transport.test.ts` (the baseline
   guard), `e2e/desktop_stub.mjs`, and `e2e/run_connect_e2e.mjs` (one
   `stubVersion` literal PER SCENARIO, not one for the file); on the desktop:
   its protocol header and that header's own baseline test (which fails if the
   header moves alone).
   `test/transport.test.ts` and `test/e2e_version_lockstep.test.ts` fail on any
   of the four in THIS repo being missed — the lockstep guard checks every
   scenario, so a new one cannot quietly keep a stale literal. The desktop's two
   cannot be checked from here and are on you. A bump that missed one has
   shipped before; that is why the count is spelled out rather than left as
   "everywhere".
2. Set the release version in `manifest.json` and `package.json`.
3. `npm run lint && npm run typecheck && npm test && npm run e2e` — all green.
4. `npm run package`.
5. Verify the Firefox artifact by hand per item 1 above.
6. Submit to the Chrome Web Store; sign the Firefox XPI with
   `web-ext sign --channel=unlisted` and publish it with its update manifest.
7. **Only then** release the desktop build. The extension must never lag the
   desktop across a `major` boundary — store review latency is part of this
   ordering, not an exception to it.
