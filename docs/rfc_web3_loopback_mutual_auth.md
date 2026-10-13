# RFC: mutual authentication for the web3 loopback transport

Status: **IMPLEMENTED** in wire protocol `2.3.1` (major 3), on both sides.
Author: extension side. Scope: both sides of the loopback link (this browser
extension and the AirNox Wallet desktop app).

This is the design record: the proposal as agreed before the build, with the
desktop's internals reduced to what the desktop does. Read it for the threat
model (sections 1, 2 and 8) and the transcript and MAC rules (section 4). Two of
its mechanisms were replaced before anything shipped:

- **Secret provisioning (sections 3 to 5).** The text has the desktop hand a
  fresh secret back on the first approved request (`auth_secret`), trusting the
  first use. The shipped design pairs by a code instead (section 8's
  recommendation): `sys_pair_begin` / `sys_pair_finish` run an X25519 exchange,
  HKDF-SHA-256 derives the secret and the confirmation keys, and the person
  types the code the desktop shows into the extension's pairing page; both
  sides confirm before the secret is kept. No secret ever travels on the wire.
- **Key loss and migration (sections 5 and 7).** The text recovers by sending a
  first frame without a handshake so that the desktop re-pairs. The shipped
  desktop refuses any frame before the handshake (4100, nothing bound). A
  browser with no key, or with a key the desktop holds no secret for, is
  answered 1002 on `sys_auth_begin`, pairs again by code on that same socket,
  and begins again. A desktop proof that fails to verify is never retried with
  the same key: the person resets the pairing in the desktop's Settings and
  pairs again.

Where the code differs from the text, the code and its known-answer vectors
(`test/testdata/auth_handshake_vectors.json`, `test/testdata/pair_vectors.json`,
byte-identical on both sides) are authoritative. Section 9's questions were all
settled before protocol 2.3.1; each now records its outcome.

The gap it closes: the loopback WebSocket had no server-to-client
authentication, so any program listening on the port could pose as the
desktop.

## 1. Problem

The extension and the desktop signer talk over a plaintext loopback WebSocket
(`ws://127.0.0.1:<port>/rpc?iid=<uuid>`). Today the desktop authenticates the
client on three things, none of them a secret:

1. the TCP peer is loopback;
2. the URL carries a 36-character `?iid=` (a length check only);
3. every frame's envelope `iid` equals the socket's `iid` (a self-consistency
   check — the client picks both sides).

On top of that there is a **trust-on-first-use pairing gate**: the first
non-`sys_ping` frame from an unpaired `iid` raises a "a browser extension wants
to connect" dialog, and on approval the bare `iid` string is persisted
(with its label and timestamps, in the desktop's encrypted local store) —
**with no key or secret bound to it**.

**The gap.** Pairing authenticates a string the client itself supplies, over an
unauthenticated channel, with no proof of possession. The `iid` travels in
cleartext in the WS URL and in every frame. Any local process that (a) reaches
the loopback port and (b) presents a paired `iid` is indistinguishable from the
real extension. Concretely, a non-privileged local process that squats one of
the four well-known ports (8114/8274/18114/48114) before the wallet binds it, or
that reads a paired `iid` off the wire, can:

- **impersonate the desktop to the extension** — pass the extension's `sys_ping`
  probe (the reply only needs a version-shaped object), then receive the real
  `iid` and the full stream of dApp origins + request params, and return forged
  results (a fake `eth_sendTransaction`/`tonConnect_sendTransaction` receipt, a
  spoofed `eth_requestAccounts` set, injected cross-origin `accountsChanged` /
  `disconnect` events);
- **impersonate the extension to the desktop** — open `/rpc?iid=<paired>` and
  drive the real wallet as the paired extension, raising sign prompts attributed
  to a legitimate origin (the per-sign user confirmation is the only backstop;
  key material is never exposed).

## 2. Goals / non-goals

Goals:

- A local process that does not possess a per-pairing secret cannot impersonate
  either side after the pairing is established.
- Reuse the desktop's existing pairing approval, paired-instance storage,
  and Settings→Web3 management UI — no new user-facing pairing concept.
- `sys_ping` stays reachable pre-authentication (port discovery + locked-state
  status must keep working; it exposes only non-secret status).
- Fail closed: an unauthenticated socket is registered for nothing (no event
  push, no non-`sys` frame honored).
- Clean OOP on both sides; no fallbacks, no silent downgrade.

Non-goals / explicitly deferred:

- Defeating an attacker present _at the very first pairing_ (see §7 residuals) —
  that is the TOFU boundary, hardenable later with a pairing code (§8, option).
- Confidentiality of frame contents on the wire beyond what loopback already
  gives (no TLS on loopback; the threat is local impersonation, not on-network
  MITM).

## 3. Design overview

Bind a **per-pairing secret** to each `iid` at pairing time, then require a
**mutual HMAC challenge-response** on every subsequent connection before the
socket is trusted for anything beyond `sys_ping`.

```
First pairing (TOFU, once):
  ext ──ws open──▶ desktop
  ext ──sys_ping──▶ desktop            (discovery + status; pre-auth)
  ext ──first real request──▶ desktop  (hits the existing pairing gate)
  desktop shows the approval dialog ───▶ user approves
  desktop: s = CSPRNG(32); store s in the paired instance [iid] (LOCAL, enc)
  desktop ──Response to the triggering request { …, auth_secret: s }──▶ ext
       (no dedicated "pairing result" frame exists — s rides the request that
        tripped the pairing gate; see §6.1)
  ext: import s as a NON-EXTRACTABLE WebCrypto HMAC key; discard the raw bytes

Every later connection (authenticated):
  ext ──ws open──▶ desktop
  ext ──sys_ping──▶ desktop            (optional; still pre-auth)
  ext ──sys_auth_begin { iid, nc }──▶ desktop
  desktop ──sys_auth_challenge { ns, server_mac }──▶ ext
       server_mac = HMAC(s, "srv" ‖ iid ‖ nc ‖ ns ‖ port ‖ ver)
  ext verifies server_mac  (authenticates the DESKTOP; a squatter without s fails)
  ext ──sys_auth_finish { client_mac }──▶ desktop
       client_mac = HMAC(s, "cli" ‖ iid ‖ nc ‖ ns ‖ port ‖ ver)
  desktop verifies client_mac (authenticates the EXTENSION) → registers the
       socket for events + honors non-sys frames
```

Key points:

- **Mutual.** The desktop proves possession of `s` first (so a squatter _server_
  is caught before the extension sends anything sensitive); the extension proves
  it second (so a squatter _client_ cannot be registered). Domain-separation
  tags (`"srv"`/`"cli"`) prevent reflecting one side's MAC as the other's.
- **Fresh nonces both ways** (`nc`, `ns`) prevent replay across connections.
- **Transcript binding.** The MAC covers `iid`, both nonces, the resolved
  loopback `port`, and the negotiated protocol `version`, so a captured
  handshake cannot be replayed onto a different port/instance/version.
- **`sys_ping` exempt.** It is answered before the auth gate (as it is answered
  before the pairing gate today), so port discovery and the locked-state UX keep
  working. It returns only status, never a secret.
- **Event push gated, per socket.** Authentication is a **per-connection
  (per-socket)** property, never a per-`iid` one. The desktop adds the socket to
  the set it fans events out to — and lets it send non-`sys` frames — **only after
  that socket's own `client_mac` verifies.** It must NOT be hoisted to the `iid`:
  the same paired `iid` can appear on two concurrent sockets (a real reconnect,
  or an attacker opening a second socket with the cleartext `iid`), and a per-`iid`
  "authenticated" flag would let the un-handshaked second socket ride the first's
  status — reintroducing the exact impersonation this RFC closes. See §6.2.

## 4. Wire protocol

Two new pre-auth control methods on the existing `sys` namespace (so they ride
the same envelope and the same pre-pairing exemption path as `sys_ping`). All
byte values are base64; MAC is HMAC-SHA-256 (32 bytes).

| method            | dir         | params                                  | result                                             |
| ----------------- | ----------- | --------------------------------------- | -------------------------------------------------- |
| `sys_auth_begin`  | ext→desktop | `{ nc }` (client nonce, **16 B fixed**) | `{ ns, server_mac }` (server nonce **16 B fixed**) |
| `sys_auth_finish` | ext→desktop | `{ client_mac }`                        | `{ ok: true }`                                     |

Transcript (both MACs, with the domain tag as the only difference). Every field
is **fixed-width** so the concatenation is injective by construction — do not
rely on separators, and do not append a variable-length trailing field without
switching to length-prefixed (TLV) framing first:

```
mac = HMAC_SHA256(s, tag(3) ‖ iid(36) ‖ nc(16) ‖ ns(16) ‖ port(u32be,4) ‖ ver(u16be×3,6))
      tag ∈ { "srv", "cli" }        ver = wallet ‖ major ‖ minor, each u16be
```

- `iid` is the connection's `iid` (already known to both); `ver` is the
  `{wallet,major,minor}` the desktop reports, binding the handshake to a version.
- **`port` is load-bearing, not optional.** On loopback a relaying squatter and
  the real desktop are necessarily on _different_ ports, so binding `port`
  defeats a two-socket relay MITM (a `server_mac` computed by the real desktop on
  its port fails the extension's check, which expects the port it dialed). See
  Open Decision #5 — `port` must stay in the transcript.
- **`nc`/`ns` uniqueness is security-critical**, not just unpredictability: a
  repeated `ns` (bad RNG) would let a captured `client_mac` be replayed. 16 B
  from a CSPRNG is adequate; the desktop MUST draw `ns` from its CSPRNG.
- Comparison MUST be explicit constant-time on both sides: a plain
  `memcmp`/`==` on the 32-byte MAC would not be constant-time. The extension
  verifies `server_mac` with `crypto.subtle.verify` (not sign-then-JS-compare).

**Invariant to preserve in code.** The desktop answers `sys_auth_begin` from any
pre-auth caller for a (publicly known) paired `iid`, so it is a free `"srv"`-MAC
generator over an attacker-chosen `nc`. This leaks nothing _only_ because (a) the
`"srv"`/`"cli"` domain tag keeps that output from ever validating as a
`client_mac`, and (b) `port` binding stops it being relayed to the real desktop.
Both controls are therefore load-bearing; neither may be "simplified" away.

**Secret provisioning has no dedicated frame — it must be plumbed (see §6.1).**
There is no "pairing result" frame today: pairing approval is an internal boolean
and, on approval, the dispatcher simply serves the _original triggering request_.
The 32-byte secret is generated at approval and returned to the extension on that
**triggering request's `Response`** (an additive `auth_secret` field, present only
on the response that completes a fresh pairing). Re-pair rotates it.

Failure codes (reuse existing `ErrorCode`):

- unknown/unpaired `iid` at `sys_auth_begin` → `NotPaired (1002)` (drives a
  re-pair, exactly as an unpaired first request does today);
- bad `client_mac` → `Unauthorized (4100)`, socket closed;
- a paired-`iid` socket that sends a normal frame **without** attempting the
  handshake (e.g. the extension lost its key — see §5) → treat as a re-pair
  trigger, **not** a bare `Unauthorized` dead-end (avoids the key-loss deadlock);
- wallet locked when the secret is needed → `WalletLocked (1001)` (the secret
  lives in the encrypted store; same handling the pairing gate already has —
  defer behind the unlock prompt or fail locked).

## 5. Extension-side changes (airnox-browser-extension)

- **`HandshakeAuthenticator`** (new, `src/transport/`) — a pure-ish collaborator
  injected into `WsClient`. Given a `send`/`receive` pair on a freshly opened
  socket and the stored key, it runs `sys_auth_begin`/`sys_auth_finish`,
  verifies `server_mac`, and resolves only on mutual success. `WsClient.openOnce`
  gates on it: the socket is not adopted (no `onMessage` wiring, no `ping`) until
  the authenticator resolves; on failure it closes and the connect attempt fails
  (fail closed — never fall back to the current version-only check).
- **Key storage.** The per-pairing secret is imported once via WebCrypto as a
  **non-extractable** `CryptoKey`
  (`crypto.subtle.importKey('raw', s, {name:'HMAC',hash:'SHA-256'}, false,
['sign','verify'])`) and persisted as a `CryptoKey` in IndexedDB; the raw bytes
  are discarded after import. A profile-file reader (or a later extension bug)
  then cannot exfiltrate the raw secret — only _use_ the key while the extension
  runs. Produce `client_mac` with `crypto.subtle.sign('HMAC', key, transcript)`;
  **verify `server_mac` with `crypto.subtle.verify('HMAC', key, mac, transcript)`**
  so the comparison stays constant-time in the platform (never a JS byte compare).
- **Key-loss recovery.** MV3 IndexedDB can be evicted under storage pressure or
  cleared by the user, leaving the extension with the `iid` but no `CryptoKey`
  while the desktop still holds the secret. The extension must detect "paired iid,
  no key" and fall back to the pairing bootstrap (send the first real frame
  without a handshake) so the desktop re-pairs and re-provisions — never a silent
  deadlock. This pairs with the desktop's "no-handshake-attempt ⇒ re-pair" rule
  in §4.
- **Probe unchanged.** `probePort` keeps using `PROBE_IID` + `sys_ping` for
  discovery; the handshake happens only on the real `openOnce`, after a port is
  chosen.
- **Pairing bootstrap.** On the first connection for an `iid` with no stored key,
  the extension proceeds as today (no handshake), completes the pairing, and on
  the pairing result imports `auth_secret`. Subsequent connects require the
  handshake.
- **Tests.** Pure MAC/transcript vectors; authenticator resolves on a good
  server_mac and rejects a bad one; `openOnce` does not adopt a socket whose
  handshake fails; `WalletLocked`/`NotPaired` map to the right dApp-facing
  outcome.

## 6. Desktop-side behaviour

What the desktop does, as the extension relies on it:

1. **The secret stays in the desktop's encrypted local store**, bound to the
   machine, never exported, and kept out of every snapshot, settings view and
   log; it is read only when a handshake runs.
2. **Authentication belongs to the socket, not to the `iid`.** A second socket
   on the same paired `iid` does not ride the first socket's status: each one
   runs its own handshake, and events fan out only to authenticated sockets.
3. **Before the handshake** a socket is served only `sys_ping`, the pairing
   frames and the handshake frames; anything else is refused (4100) and binds
   nothing. `sys_ping` stays exempt and exposes only status.
4. **A locked wallet cannot verify.** `sys_auth_begin` with no origin is answered
   `WalletLocked (1001)` with no prompt; with the dApp's origin it waits on the
   desktop's unlock window. A lock closes every web3 socket.
5. **Pre-authentication work is bounded**: unauthenticated sockets and their
   pending nonces are capped, so a peer cannot force unbounded HMAC work.
6. **Settings can reset a browser's pairing.** A reset (or an unpair) drops the
   secret and closes that browser's sockets (1000); the browser then pairs again
   by code. Pairing again by code also closes the sockets that authenticated
   with the old key.

## 7. Migration and versioning

Mandatory mutual auth is a **breaking** connection-establishment change: an old
extension (no handshake) must be refused once the desktop requires it, and an
old desktop cannot serve a new extension that requires it. Under the protocol's
versioning rule, a breaking change bumps `major`.

Recommended rollout:

- **Land behind a coordinated `major` bump**, shipped in lockstep exactly as the
  mhda-1.1 chain-key bump was (protocol major 2).
  A stale peer across the boundary is refused with `VersionIncompatible (1103)`
  and the correct update prompt — which is the desired fail-closed behavior for a
  security-critical break.
- A `minor` capability bit alone is **not** a defense: an "optional" handshake an
  attacker declines yields zero security. Enforcement must therefore be
  **mandatory**, and must key on the **negotiated `major`**, not on
  secret-presence — otherwise an old extension that bootstraps a pairing receives
  a secret it cannot use and then breaks silently on every later connect, instead
  of getting the clean `VersionIncompatible (1103)` + update prompt.
- A defensible **less-disruptive** rollout is two-phase, still ending fail-closed:
  (1) a `minor` bit that only advertises support so both sides _learn_ the
  handshake and provision secrets during the transition, then (2) a `major` bump
  that flips it to _mandatory_. The end state is identical to a straight major
  bump; the flip just finds most clients already compatible, so fewer hard
  failures at cut-over. Phase 1 provides no security by itself — it is purely a
  migration smoother — so the major flip is not optional.
- Existing paired instances (pre-secret) must re-pair once on upgrade: on the
  first post-upgrade connect, `sys_auth_begin` finds no secret for the `iid` →
  `NotPaired` → the desktop shows the pairing dialog → a fresh secret is
  provisioned. One extra approval per already-paired extension, once.

## 8. Residual risks

- **TOFU at first pairing — and the durable-squatter attack it enables.** The
  secret is delivered over the (still unauthenticated) channel during the first
  pairing, so an attacker present _at that moment_ does more than intercept a
  one-shot: a squatter that binds a well-known port before the wallet can
  **provision its OWN secret** — it returns `{auth_secret: sA}`, and thereby holds
  a **durable** shared credential that authenticates it as "the desktop" on every
  future reconnect, with the real wallet on another port or not running. This is
  the same class as SSH first-connect, but the payoff is a lasting credential, not
  a single session. The "the real desktop never shows a dialog, an attentive user
  notices" signal is **weak**: users don't reliably notice an _absent_ dialog when
  the dApp appears to connect, and a local squatter can pop its own lookalike
  native dialog. **Recommendation: make the desktop-shown pairing code (§9-1) the
  default, not an option** — the real desktop displays a short code the user types
  into the extension, binding the first exchange to the genuine desktop and
  closing the TOFU window. Shipping without it is defensible only if the residual
  is accepted explicitly.
- **Rotation re-opens the window.** Each re-pair ships a fresh secret over the
  still-unauthenticated channel, so a squatter present _at rotation_ captures the
  new secret. Rotation is not, by itself, a mitigation for a compromise; it only
  helps once the pairing-code hardening closes the provisioning channel.
- **Extension-side key use while compromised.** A non-extractable WebCrypto key
  stops raw-secret exfiltration, but a compromised extension _process_ can still
  use the key to sign challenges for as long as it runs. This is inherent to any
  client-held credential and out of scope here.
- **Loopback confidentiality.** Frames remain plaintext on loopback (no TLS);
  the handshake authenticates the peer but does not encrypt the stream. On
  loopback the threat is impersonation (addressed) not on-network sniffing.

## 9. Decisions (all settled before protocol 2.3.1)

Each question as it was put, then its outcome.

1. **First-pairing hardening (recommended: adopt the code).** Ship the
   desktop-shown pairing code as the default (closes the durable-squatter window,
   §8), or accept the TOFU residual explicitly and ship without it? The RFC
   recommends the code; the decision is whether the code-entry UX cost is
   acceptable.
   **Settled:** the pairing code is the only way to pair; no secret travels on
   the wire (see the note at the top).
2. **Locked-wallet handshake:** defer behind the unlock prompt (smoother — the
   handshake completes as part of the first real request's unlock) or fail
   `WalletLocked` and let the extension retry after the user unlocks?
   **Settled:** both, by origin. A begin that names the dApp's origin waits on
   the unlock window; one with no origin is answered `WalletLocked (1001)`.
3. **Version placement + rollout:** a straight `major` bump (lockstep, as with
   mhda-1.1) or the two-phase minor-then-major deploy-then-enforce (§7)? And ride
   an existing `major` release or a dedicated one?
   **Settled:** a straight bump to major 3, shipped in lockstep on both sides; a
   peer of another major is refused with `VersionIncompatible (1103)` and the
   update prompt.
4. **Secret rotation policy:** rotate only on explicit re-pair, or also on desktop
   reinstall (new install → new secret → forced re-pair)? (Note: rotation ships a
   fresh secret over the channel — only safe once the pairing code closes it.)
   **Settled:** the secret changes only by pairing again by code: after a reset
   in the desktop's Settings, or when the extension lost its key. A desktop that
   holds no secret for the browser answers 1002 and the browser pairs again.
5. **Auto-mode port changes (confirm, don't drop `port`).** `port` MUST stay in
   the transcript — it is the anti-relay control (§4). Auto-mode moving the wallet
   across the four ports across restarts is harmless: the stored secret is
   unaffected; the next connect simply re-handshakes on the new port. Confirm this
   is acceptable (it does not weaken security; it only means a handshake is bound
   to the port it ran on).
   **Settled:** `port` stays in the transcript, as specified.
6. **Transcript framing:** fixed-width fields as specified in §4, or switch to TLV
   now to future-proof against ever adding a field? (Fixed-width is injective
   today; TLV is only needed if the field set grows.)
   **Settled:** fixed-width fields, as in section 4.
