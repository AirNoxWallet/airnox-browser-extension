# AirNox browser extension

AirNox connects web3 sites to the AirNox Wallet desktop app (https://airnox.app).
The extension holds no keys: it exposes the standard provider interfaces to a
page and relays each request over a loopback WebSocket to the desktop app, which
asks the person to approve it and signs it.

- EVM: EIP-1193 `window.ethereum`, announced through EIP-6963.
- Solana and Sui: Wallet Standard.
- TON: TON Connect's injected bridge.
- TRON: `window.tron` / `tronLink` / `tronWeb`.

Builds target Chrome, Firefox, Brave and Opera (Manifest V3). Opera users
install from the Chrome Web Store; Firefox is distributed self-hosted and
unlisted (see `docs/publishing.md`).

## How it is put together

| Path                | Runs in          | Role                                                                    |
| ------------------- | ---------------- | ----------------------------------------------------------------------- |
| `src/protocol/**`   | bundled into all | the wire protocol shared with the desktop: frames, versions, chain keys |
| `src/transport/**`  | service worker   | the loopback WebSocket, its handshake and the pairing key               |
| `src/background/**` | service worker   | routing between pages and the desktop                                   |
| `src/content/**`    | isolated world   | stamps the page's real origin onto every request and relays it          |
| `src/inpage/**`     | page main world  | the provider objects a dApp sees                                        |
| `src/popup/**`      | popup and pages  | connection state, transport settings, pairing by code                   |

The extension and the desktop authenticate each other on every socket with a
key shared once by a code the desktop shows. The flow is implemented in
`src/transport/` and pinned by the known-answer vectors in `test/testdata/`;
`docs/rfc_web3_loopback_mutual_auth.md` is the original design record, with
the parts the build replaced marked at its top. How AirNox behaves when another wallet
already holds a provider global is `docs/provider_coexistence.md`.

## Development

Node 24 (`.nvmrc`) and npm 11.

```sh
npm ci
npm run typecheck   # tsc --noEmit
npm run lint        # eslint and prettier --check
npm test            # node:test over test/*.test.ts
npm run build       # both targets into dist/
npm run e2e         # builds the Chrome target and drives it against a desktop stub
npm run package     # the store packages
```

`npm run e2e` runs on Linux and needs Playwright's Chromium (`npx playwright
install chromium`). The Firefox target is checked by hand, as `docs/publishing.md`
describes.

## License

Apache-2.0 (`LICENSE`). Bundled third-party code and its licences:
`THIRD_PARTY_NOTICES`.
