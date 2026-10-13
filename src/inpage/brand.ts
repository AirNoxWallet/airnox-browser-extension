// The AirNox brand as the injected providers present it to a dApp: one name and
// one mark, shared by every ecosystem so a dApp sees a single "AirNox" whichever
// chain it asks for (the EIP-6963 info, both Wallet Standard wallets, TON
// Connect's DeviceInfo.appName). Previously each provider carried its own
// placeholder, which meant two literals to keep in step and two copies of the
// payload in the injected bundle.
//
// The mark is inlined as a data URI because both consumers require one: EIP-6963
// specifies a data URI for EIP6963ProviderInfo.icon, and Wallet Standard types
// Wallet.icon the same way (WalletIcon accepts data:image/svg+xml;base64). An
// extension URL is not an option — the main world cannot read the extension
// origin, and neither standard accepts one.
//
// Source of truth: assets/airnox-icon-flat.svg, the AirNox brand guidelines' FLAT mark
// (assets/airnox-icon.svg beside it is the metal one). Flat, because dApp wallet
// pickers draw this at 24-48 px, and under 64 px the brand guidelines call for the flat
// mark: the metal one's highlights turn grey when small. The inline copy is that
// file with its <title> and the whitespace between tags dropped, then
// base64-encoded: about 2 KB, sharp at any pixel density, and no quantisation
// step. Regenerate by those same three steps; test/brand.test.ts holds the copy
// to the file.

export const AIRNOX_NAME = 'AirNox';

// The reverse-DNS identifier a dApp sees in EIP-6963 discovery. Connectors save
// it to reconnect and wallet registries key on it, so it never changes.
export const AIRNOX_RDNS = 'app.airnox';

export const AIRNOX_ICON_DATA_URI =
  'data:image/svg+xml;base64,' +
  'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9' +
  'IjAgMCA1MTIgNTEyIiB3aWR0aD0iNTEyIiBoZWlnaHQ9IjUxMiI+PGRlZnM+PGxp' +
  'bmVhckdyYWRpZW50IGlkPSJhaXJub3gtYmciIHgxPSIwIiB5MT0iNTEyIiB4Mj0i' +
  'NTEyIiB5Mj0iMCIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPjxzdG9w' +
  'IG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzBBMUM1QyIvPjxzdG9wIG9mZnNldD0i' +
  'MC41IiBzdG9wLWNvbG9yPSIjMTI1OTkzIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9w' +
  'LWNvbG9yPSIjMUNBMUQzIi8+PC9saW5lYXJHcmFkaWVudD48bGluZWFyR3JhZGll' +
  'bnQgaWQ9ImFpcm5veC1zaGllbGQiIHgxPSI5NS4wNyIgeTE9IjM2My44OSIgeDI9' +
  'IjQxNi45MyIgeTI9IjQyLjAzIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVz' +
  'ZSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjMzk5NEVEIi8+PHN0b3Ag' +
  'b2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMzhFQ0ZEIi8+PC9saW5lYXJHcmFkaWVu' +
  'dD48L2RlZnM+PHJlY3QgaWQ9ImJhY2tncm91bmQiIHdpZHRoPSI1MTIiIGhlaWdo' +
  'dD0iNTEyIiByeD0iMTA3LjM0IiBmaWxsPSJ1cmwoI2Fpcm5veC1iZykiLz48cGF0' +
  'aCBpZD0ic2hpZWxkIiBmaWxsPSJ1cmwoI2Fpcm5veC1zaGllbGQpIiBkPSJNMTM1' +
  'LjkgMzM2LjU3IEMxMDYuNiAyODkuMjYgODkuMjUgMjIzLjQ3IDk1LjA3IDEyNy42' +
  'OCBDMTkxLjM3IDExNy4xNCAyMTQuMzEgMTAxLjkgMjU2IDcyLjkgQzI5Ny42OSAx' +
  'MDEuOSAzMjAuNjMgMTE3LjE0IDQxNi45MyAxMjcuNjggQzQyMi43NSAyMjMuNDcg' +
  'NDA1LjQgMjg5LjI2IDM3Ni4xIDMzNi41NyBMMzU5LjIgMjk5LjMyIEMzNzUuMzIg' +
  'MjY1LjI0IDM4Ni41MiAyMTkuNCAzODYuMjggMTU2LjY4IEMzMjUuNDcgMTQ5LjU1' +
  'IDI4OS43NyAxMzAuNTYgMjU2IDExMi4yNyBDMjIyLjIzIDEzMC41NiAxODYuNTMg' +
  'MTQ5LjU1IDEyNS43MiAxNTYuNjggQzEyNS40OCAyMTkuNCAxMzYuNjggMjY1LjI0' +
  'IDE1Mi44IDI5OS4zMloiLz48ZyBpZD0ibW9ub2dyYW0iIGZpbGw9IiNGRkZGRkYi' +
  'PjxwYXRoIGQ9Ik0yMzQuMzMgMTcxLjY3IEwyNzcuNjcgMTcxLjY3IEwzMDMuODYg' +
  'MjI5LjQxIEMzMzIuNDUgMjkyLjQyIDI1My45OSAzMTkgMjA5LjAzIDMxOSBMMTc4' +
  'LjAxIDM4Ny4zNyBMMTQ5Ljc5IDM1OC4wMVogTTI1NiAyMTUuNDggTDIyNC4xIDI4' +
  'NS43OCBDMjY5LjE5IDI4My44NyAyODQuOTIgMjc5LjIyIDI4Mi4zIDI3My40Nloi' +
  'Lz48cGF0aCBkPSJNMzIzLjIzIDI3Mi4wOSBMMzYxLjc5IDM1Ny4wOSBDMzMyLjE1' +
  'IDM5NS4wNyAyOTQuMTEgNDE5LjMzIDI1NiA0MzguNDMgQzIzNC41MSA0MjcuNjYg' +
  'MjEzLjA1IDQxNS4yNSAxOTMuMDkgMzk5LjY2IEwyMDYuODkgMzY5LjI2IEMyMjYu' +
  'ODkgMzg1LjgyIDI0NS41NSAzOTUuMjMgMjU2IDQwMi45IEMyNjguOTcgMzkzLjM4' +
  'IDI5NC42IDM4MS4xNyAzMTkuNzMgMzU1Ljk0IEwyOTcuNjggMzA3LjM0IEMzMTIu' +
  'OSAyOTUuNzEgMzIwLjA1IDI4Mi45MyAzMjMuMjMgMjcyLjA5WiIvPjwvZz48L3N2' +
  'Zz4=';
