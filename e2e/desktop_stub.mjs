// A protocol-faithful stand-in for the desktop wallet's web3 server, used by the
// e2e to isolate the variables under test without a running desktop build: can
// the real MV3 extension, loaded in a real Chromium, open the loopback
// WebSocket, complete the handshake, and carry every ecosystem's connect / sign /
// broadcast round-trip end to end? It mirrors the real server's wire contract
// (loopback bind, 36-char `iid` query gate, envelope-iid cross-check, the
// protocol-version gate, and the per-namespace result SHAPES of the desktop's
// dispatcher) but holds no keys and runs no UI.
//
// The reply shapes below are mirrored from the desktop's handlers, NOT invented:
// a connect answers bare addresses for EVM and Solana and {address, publicKey}
// objects for Sui; a sign a bare signature string; a transaction the tx hash; a
// Wallet Standard sign {bytes, signature}; a Wallet Standard transaction a bare
// signature for Solana and {digest, bytes, signature, effects} for Sui; a TON
// Connect connect {items:[...]}, its transaction {boc} and its sign-data the
// request params echoed back; a chain switch the RESOLVED chain key; a
// watch-asset a bare `true`. A shape drifting from the desktop's is exactly
// the "fixtures left on the old shape" failure this harness exists to catch, so
// change them together.
//
// PARTIAL, deliberately: the dispatcher's read-passthrough allowlist and
// wallet_addEthereumChain's full validation are not modelled, and the REQUEST
// fixtures the dApp sends (a 4-byte Solana "transaction", a two-byte TRON
// raw_data_hex, a Sui transaction JSON with no inputs) are decodable by this stub
// but NOT by a real signer. Replies are decoder-valid for the extension;
// requests are not builder-valid for the desktop. Swapping this for the real
// desktop server therefore needs real payloads on the dApp side — the harness is not
// as drop-in as it looks.

import {
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { WebSocketServer } from 'ws';

const IID_LEN = 36;
// The semantic protocol version the desktop speaks (a mirror of the desktop
// wallet's protocol definitions — major 3 since every socket must
// authenticate). Overridable per-stub so the e2e can drive both the
// compatible and the version-incompatible path. The extension's AUTO probe verifies a sys_ping
// carries a valid version OBJECT, so this MUST be the object form — a legacy
// integer would make isAirNoxSysPingResult reject the stub as non-AirNox.
const DEFAULT_VERSION = { wallet: 2, major: 3, minor: 1 };

// As on the desktop: from this major a socket is
// served nothing but sys_ping, the pairing and the handshake until it
// authenticated.
const AUTH_REQUIRED_FROM_MAJOR = 3;

// A fixed eligible account the stub "grants" so a connected dApp gets a non-empty
// eth_requestAccounts result — the GREEN signal the harness asserts on.
const GRANTED_ACCOUNT = '0x000000000000000000000000000000000000dEaD';

// The canonical mhda 1.1 chain keys the providers stamp. Solana
// (nt:solana:ci:mainnet) and Sui share the `wstd` namespace, so standard:connect
// is disambiguated by THIS field alone — which is precisely the routing the e2e
// proves over a real wire. Any key but Sui's gets the Solana account.
const SUI_CHAIN = 'nt:sui:ci:mainnet';

// Per-ecosystem reply fixtures. Every value is structurally valid for the decoder
// the provider runs it through — a Solana address that base58-decodes to 32
// bytes, a Sui publicKey that hex-decodes, a TRON address whose base58check
// yields the `41…` hex form. They are shared with the unit suites' fixtures on
// purpose: a decoder change breaks both, not just one. Values that a provider
// merely passes through are kept DISTINCT from each other so a swapped field
// (bytes for signature) fails an assertion instead of matching by luck.
const FIXTURES = {
  evm: {
    account: GRANTED_ACCOUNT,
    txHash: '0x' + 'ab'.repeat(32),
    signature: '0x' + 'cd'.repeat(65),
  },
  solana: {
    account: 'So11111111111111111111111111111111111111112',
    // In base58 a leading '1' IS a leading zero byte, so a run of 64 decodes to
    // exactly 64 zero bytes — a structurally valid ed25519 signature without
    // inventing one that only looks real.
    signature: '1'.repeat(64),
    signedTransaction: 'AQIDBA==',
    messageSignature: 'BQYHCA==',
  },
  sui: {
    account: '0x' + 'aa'.repeat(32),
    publicKey: 'bb'.repeat(32),
    bytes: 'AQIDBA==',
    signature: 'BQYHCA==',
    digest: 'CQoLDA==',
    effects: 'DQ4PEA==',
  },
  ton: {
    address:
      '0:83dfd552e63729b472fcbcc8c45ebcc6691702558b68ec7527e1ba403a0f31a8',
    network: '-239',
    publicKey: 'ee'.repeat(32),
    walletStateInit: 'te6ccgEBAQEAAgAAAA==',
    boc: 'te6ccgEBAQEAAgAAAQ==',
    proofSignature: 'ERITFA==',
    signDataSignature: 'FRYXGA==',
  },
  tron: {
    account: 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH',
    accountHex: '41c8599111f29c1e1e061265b4af93ea1f274ad78a',
    // trx.sign gets the BARE 65-byte hex signature (the extension appends it to
    // the tx's signature[]); signMessageV2 gets the 0x-prefixed form.
    signature: 'ef'.repeat(65),
    messageSignature: '0x' + 'ef'.repeat(65),
    txid: 'ab'.repeat(32),
  },
};

// The desktop / extension compat rule: same wallet line + same major (minor — a
// capability bitmask — never gates).
// ── pairing by code and the socket handshake ─────────────────────────────────
// The desktop's two pairing frames (with the dialog that shows the code) and
// its two handshake frames, byte
// for byte as the extension's known-answer files pin them: the same labels, the
// same transcripts, X25519 + HKDF-SHA-256 + HMAC-SHA-256. The code the desktop
// would SHOW is recorded in `shownCodes` instead, for the harness to type into
// the extension's pairing page, as the person reads it off the dialog.
const PAIR_TRANSCRIPT_LABEL = 'airnox-web3-pair-v1';
const PAIR_CONFIRM_LABEL = 'airnox-web3-pair-confirm-v1';
const PAIR_SECRET_LABEL = 'airnox-web3-pair-secret-v1';
const PAIR_CODE_CHECK_LABEL = 'airnox-web3-pair-check-v1';
const PAIR_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Standard base64 of exactly `n` bytes, in its one canonical spelling, or null.
function fromB64(s, n) {
  if (typeof s !== 'string') return null;
  const b = Buffer.from(s, 'base64');
  return b.length === n && b.toString('base64') === s ? b : null;
}

function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function versionBytes(v) {
  const b = Buffer.alloc(6);
  b.writeUInt16BE(v.wallet, 0);
  b.writeUInt16BE(v.major, 2);
  b.writeUInt16BE(v.minor, 4);
  return b;
}

// A fresh 16-character code: 15 random symbols and the check character.
function newPairCode() {
  let body = '';
  for (let i = 0; i < 15; i++) {
    body += PAIR_CODE_ALPHABET[randomInt(PAIR_CODE_ALPHABET.length)];
  }
  const digest = createHash('sha256')
    .update(PAIR_CODE_CHECK_LABEL + body)
    .digest();
  return body + PAIR_CODE_ALPHABET[digest[0] >> 3];
}

function x25519Raw(publicKey) {
  return Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
}

function x25519Public(raw) {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') },
    format: 'jwk',
  });
}

// The handshake's MAC: tag | iid | nc | ns | port (u32be) | version (u16be x3).
function authMac(secret, tag, iid, nc, ns, port, version) {
  return createHmac('sha256', secret)
    .update(
      Buffer.concat([
        Buffer.from(tag),
        Buffer.from(iid),
        nc,
        ns,
        u32be(port),
        versionBytes(version),
      ])
    )
    .digest();
}

function compatible(reqVersion, ours) {
  return (
    reqVersion != null &&
    reqVersion.wallet === ours.wallet &&
    reqVersion.major === ours.major
  );
}

// Mirror of the desktop's domain_from_origin: strip the scheme, KEEP the port.
// Hardcoding "127.0.0.1" here would have been wrong — the dApp is served on a
// random port, so the port is part of the domain the desktop signs over.
function domainFromOrigin(origin) {
  const i = origin.indexOf('://');
  return i === -1 ? origin : origin.slice(i + 3);
}

// The params SHAPE the desktop dispatcher demands, per (ns, method) — the half
// of the wire contract a permissive stub used to hide. The transaction and sign
// handlers read NAMED keys off an OBJECT and refuse anything else with 1100;
// the switch-chain and add-chain handlers read `params[0]` off an ARRAY (EIP-3326 / EIP-3085 are positional on the wire too); EIP-747
// `wallet_watchAsset` is an object. A stub that accepted every shape let the
// extension ship a positional eth_sendTransaction that a real desktop answered
// with `transaction params must be an object`: drift from the desktop wire
// contract, with the fixtures left on the old shape.
//
// Only the methods whose shape the desktop's dispatcher pins are listed. A method absent from this table is not asserted rather than guessed.
const PARAMS_SHAPE = {
  'evm|eth_sendTransaction': 'object',
  'evm|personal_sign': 'object',
  'evm|eth_signTypedData_v4': 'object',
  'evm|wallet_switchEthereumChain': 'array-of-object',
  'evm|wallet_addEthereumChain': 'array-of-object',
  'evm|wallet_watchAsset': 'object',
};

// True iff `params` matches `shape`. Mirrors the dispatcher's own guards: a bare
// object is `is_object()`, and the positional pair is `is_array()` with an
// object at [0].
function shapeOk(shape, params) {
  const isObject =
    typeof params === 'object' && params !== null && !Array.isArray(params);
  if (shape === 'object') {
    return isObject;
  }
  if (shape === 'array-of-object') {
    return (
      Array.isArray(params) &&
      params.length > 0 &&
      typeof params[0] === 'object' &&
      params[0] !== null &&
      !Array.isArray(params[0])
    );
  }
  return true;
}

// The per-(ns, method) result table, keyed exactly as the wire addresses it.
// `req` is the decoded frame, so a handler may branch on `chain` — which is how
// the two Wallet-Standard ecosystems are told apart — or echo `params`, which is
// what the desktop's signData reply does.
const HANDLERS = {
  'evm|eth_requestAccounts': () => [FIXTURES.evm.account],
  'evm|personal_sign': () => FIXTURES.evm.signature,
  'evm|eth_signTypedData_v4': () => FIXTURES.evm.signature,
  'evm|eth_sendTransaction': () => FIXTURES.evm.txHash,
  // A chain switch answers with the RESOLVED chain key — the wallet is the
  // SSOT for chain identity, so it echoes its own key, not the dApp's chainId.
  'evm|wallet_switchEthereumChain': (req) => {
    const chainId = req.params?.[0]?.chainId;
    // The desktop keys every EVM chain by its decimal chain id : 0x89 is nt:evm:ci:137.
    return `nt:evm:ci:${BigInt(chainId).toString(10)}`;
  },
  'evm|wallet_addEthereumChain': () => null,
  'evm|wallet_watchAsset': () => true,

  'wstd|standard:connect': (req) =>
    req.chain === SUI_CHAIN
      ? [{ address: FIXTURES.sui.account, publicKey: FIXTURES.sui.publicKey }]
      : [FIXTURES.solana.account],
  'wstd|solana:signMessage': () => FIXTURES.solana.messageSignature,
  'wstd|solana:signTransaction': () => FIXTURES.solana.signedTransaction,
  'wstd|solana:signAndSendTransaction': () => FIXTURES.solana.signature,
  'wstd|sui:signPersonalMessage': () => FIXTURES.sui.signature,
  'wstd|sui:signTransaction': () => ({
    bytes: FIXTURES.sui.bytes,
    signature: FIXTURES.sui.signature,
  }),
  'wstd|sui:signAndExecuteTransaction': () => ({
    digest: FIXTURES.sui.digest,
    bytes: FIXTURES.sui.bytes,
    signature: FIXTURES.sui.signature,
    effects: FIXTURES.sui.effects,
  }),

  'tonconnect|tonConnect_connect': (req) => tonConnectReply(req),
  'tonconnect|tonConnect_restoreConnection': (req) => tonConnectReply(req),
  'tonconnect|tonConnect_sendTransaction': () => ({ boc: FIXTURES.ton.boc }),
  'tonconnect|tonConnect_signData': (req) => ({
    signature: FIXTURES.ton.signDataSignature,
    address: FIXTURES.ton.address,
    timestamp: 1700000000,
    domain: domainFromOrigin(req.origin),
    // The desktop echoes the request params verbatim; hardcoding a payload here
    // would let a bridge that shipped the WRONG params still pass.
    payload: req.params,
  }),
  'tonconnect|tonConnect_disconnect': () => ({}),

  'tron|tron_requestAccounts': () => [FIXTURES.tron.account],
  'tron|tron_signMessageV2': () => FIXTURES.tron.messageSignature,
  'tron|tron_signTransaction': () => FIXTURES.tron.signature,
  'tron|tron_sendRawTransaction': () => ({
    result: true,
    txid: FIXTURES.tron.txid,
  }),
};

// The desktop's TON Connect connect reply: a ton_addr item always, a ton_proof item
// only when the dApp asked for one (the desktop reads that from params.ton_proof,
// which the bridge forwards from the ConnectRequest's items).
function tonConnectReply(req) {
  const items = [
    {
      name: 'ton_addr',
      address: FIXTURES.ton.address,
      network: FIXTURES.ton.network,
      publicKey: FIXTURES.ton.publicKey,
      walletStateInit: FIXTURES.ton.walletStateInit,
    },
  ];
  const payload = req.params?.ton_proof;
  if (typeof payload === 'string') {
    const domain = domainFromOrigin(req.origin);
    items.push({
      name: 'ton_proof',
      proof: {
        timestamp: 1700000000,
        domain: { lengthBytes: domain.length, value: domain },
        payload,
        signature: FIXTURES.ton.proofSignature,
      },
    });
  }
  return { items };
}

// Start the stub on the given loopback port (0 = OS-assigned). `version` is the
// protocol version the stub reports + enforces. `rejectMethods` is the set of
// methods to refuse with UserRejected (4001) — the wire-level stand-in for the
// user pressing Reject in the desktop's confirmation dialog, which is the only
// way an e2e can drive that branch without a GUI. Returns { port, grantedAccount,
// fixtures, frames, close }; `frames` is a live log of EVERY frame that got past
// the iid gate, so the harness can assert what actually crossed the wire (origin
// stamping, canonical chain keys, and that a namespace never appears at all)
// rather than only what came back. `push` sends an unsolicited event to every
// connected instance, the stand-in for a desktop push (an eligibility change).
export function startDesktopStub({
  port = 0,
  version = DEFAULT_VERSION,
  rejectMethods = [],
  // The desktop session sys_ping names (the desktop mints one per process): a
  // second stub with a different one is a desktop that restarted.
  desktopSession = '11'.repeat(16),
  // The wallet starts locked: the handshake a socket begins on its own is
  // answered 1001, and one that names a dApp is the person unlocking for it.
  locked = false,
  // Each instance's pairing secret. The desktop keeps them in the profile, so
  // a stub standing in for the same desktop restarted is handed the map of the
  // one before it.
  secrets = new Map(),
  onLog = () => {},
} = {}) {
  const refused = new Set(rejectMethods);
  // Pairing by code and the socket handshake. `secrets` holds each instance's
  // pairing secret; `shownCodes` every code the
  // dialog would show; `sockets` below each socket's handshake state;
  // `socketLogs` every frame method per socket, in order.
  const required = version.major >= AUTH_REQUIRED_FROM_MAJOR;
  const shownCodes = [];
  const pairBegins = [];
  const socketLogs = [];
  const auth = { locked, imposter: false, authenticated: 0 };
  const frames = [];
  // The held sessions, as the desktop keeps them: each instance's
  // current resume secret, every sys_resume answered ({presented, restored,
  // minted}), and every socket's first frame past sys_ping, the pairing and
  // the handshake, which is what binds it.
  const bindings = new Map();
  const resumes = [];
  const firstFrames = [];
  // Each open socket's handshake iid: a push is addressed to the instance.
  // `authenticated`: the sockets whose handshake verified; once authentication
  // is required, only they hear pushes.
  const sockets = new Map();
  const authenticated = new Set();
  const reply = (iid, req, result) =>
    JSON.stringify({ v: version, iid, rid: req.rid, ok: true, result });
  const fail = (iid, rid, code, message) =>
    JSON.stringify({
      v: version,
      iid,
      rid,
      ok: false,
      error: { code, message, data: null },
    });

  // sys_pair_begin {epk, nc, origin?} -> {epk, ns}; sys_pair_finish {mac} ->
  // {mac}. One finish per begin; a code that does not match closes the socket.
  function handlePairing(socket, iid, req, state, listening) {
    const p = req.params ?? {};
    if (req.method === 'sys_pair_begin') {
      const epk = fromB64(p.epk, 32);
      const nc = fromB64(p.nc, 16);
      if (
        !epk ||
        !nc ||
        (p.origin !== undefined && typeof p.origin !== 'string')
      ) {
        socket.send(fail(iid, req.rid, 1100, 'malformed pairing begin'));
        return;
      }
      const own = generateKeyPairSync('x25519');
      const ns = randomBytes(16);
      const code = newPairCode();
      state.attempt = { epk, nc, ns, own, code };
      shownCodes.push(code);
      pairBegins.push({ iid, origin: p.origin ?? null });
      socket.send(
        reply(iid, req, {
          epk: x25519Raw(own.publicKey).toString('base64'),
          ns: ns.toString('base64'),
        })
      );
      return;
    }
    const a = state.attempt;
    state.attempt = null;
    if (!a) {
      socket.send(
        fail(iid, req.rid, 4100, 'no pairing attempt for this instance')
      );
      return;
    }
    const mac = fromB64(p.mac, 32);
    if (!mac) {
      socket.send(fail(iid, req.rid, 1100, 'malformed pairing finish'));
      return;
    }
    const th = createHash('sha256')
      .update(
        Buffer.concat([
          Buffer.from(PAIR_TRANSCRIPT_LABEL),
          Buffer.from(iid),
          a.epk,
          x25519Raw(a.own.publicKey),
          a.nc,
          a.ns,
          u32be(listening),
          versionBytes(version),
        ])
      )
      .digest();
    const dh = diffieHellman({
      privateKey: a.own.privateKey,
      publicKey: x25519Public(a.epk),
    });
    const ikm = Buffer.concat([dh, Buffer.from(a.code)]);
    const expand = (label) =>
      Buffer.from(hkdfSync('sha256', ikm, th, Buffer.from(label), 32));
    const confirm = expand(PAIR_CONFIRM_LABEL);
    const confirmation = (tag) =>
      createHmac('sha256', confirm)
        .update(Buffer.concat([Buffer.from(tag), th]))
        .digest();
    if (!timingSafeEqual(confirmation('cli'), mac)) {
      socket.send(fail(iid, req.rid, 4100, 'the code did not match'));
      socket.close(1008, 'pairing refused');
      return;
    }
    secrets.set(iid, expand(PAIR_SECRET_LABEL));
    onLog(`paired: iid=${iid}`);
    socket.send(
      reply(iid, req, { mac: confirmation('srv').toString('base64') })
    );
    // The instance's other sockets authenticated with the key this pairing
    // replaced: the desktop closes them, and the extension comes back with the
    // new one.
    for (const [other, otherIid] of sockets) {
      if (other !== socket && otherIid === iid && authenticated.has(other)) {
        other.close(1000, 'dApp sessions reset');
      }
    }
  }

  // sys_auth_begin {nc, origin?} -> {ns, mac}; sys_auth_finish {mac} ->
  // {authenticated: true}, with the refusals 06-auth-handshake-wire lists.
  function handleHandshake(socket, iid, req, state, listening, log) {
    const p = req.params ?? {};
    if (req.method === 'sys_auth_begin') {
      const nc = fromB64(p.nc, 16);
      const origin = p.origin;
      const entry = { origin: origin ?? null, answer: null };
      log.auth.push(entry);
      const refuse = (code, message) => {
        entry.answer = code;
        socket.send(fail(iid, req.rid, code, message));
      };
      if (!nc || (origin !== undefined && typeof origin !== 'string')) {
        refuse(1100, 'malformed handshake begin');
        return;
      }
      if (state.phase !== 'open' || state.bound) {
        refuse(1100, 'this connection cannot begin a handshake');
        return;
      }
      const secret = secrets.get(iid);
      if (!secret) {
        refuse(1002, 'this instance is not paired');
        return;
      }
      if (auth.locked) {
        if (origin === undefined) {
          refuse(1001, 'the wallet is locked');
          return;
        }
        // The unlock window named the dApp, and the person unlocked.
        auth.locked = false;
      }
      const ns = randomBytes(16);
      const key = auth.imposter ? randomBytes(32) : secret;
      state.phase = 'pending';
      state.nc = nc;
      state.ns = ns;
      entry.answer = 'ok';
      socket.send(
        reply(iid, req, {
          ns: ns.toString('base64'),
          mac: authMac(key, 'srv', iid, nc, ns, listening, version).toString(
            'base64'
          ),
        })
      );
      return;
    }
    if (state.phase !== 'pending') {
      socket.send(
        fail(
          iid,
          req.rid,
          4100,
          'no handshake is in progress on this connection'
        )
      );
      return;
    }
    const mac = fromB64(p.mac, 32);
    if (!mac) {
      socket.send(fail(iid, req.rid, 1100, 'malformed handshake finish'));
      return;
    }
    const expected = authMac(
      secrets.get(iid) ?? randomBytes(32),
      'cli',
      iid,
      state.nc,
      state.ns,
      listening,
      version
    );
    if (!timingSafeEqual(expected, mac)) {
      state.phase = 'failed';
      socket.send(fail(iid, req.rid, 4100, 'the handshake did not verify'));
      socket.close(1008, 'authentication refused');
      return;
    }
    state.phase = 'authenticated';
    authenticated.add(socket);
    auth.authenticated += 1;
    onLog(`authenticated: iid=${iid}`);
    socket.send(reply(iid, req, { authenticated: true }));
  }

  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port });

    // Without this the promise would never settle on EADDRINUSE and `ws` would
    // throw on an unhandled 'error'. Port 8114 is the REAL wallet's default, so
    // "the developer has the desktop running" is the common case, and it must
    // say so instead of hanging.
    wss.on('error', (e) => {
      reject(
        new Error(
          `desktop stub could not bind 127.0.0.1:${port} (${
            e.code ?? e.message
          }) — ` +
            'is the real AirNox Wallet desktop, or a previous run, still listening?'
        )
      );
    });

    wss.on('connection', (socket, request) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const iid = url.searchParams.get('iid') ?? '';
      // Same perimeter gate the real server enforces: a missing/!=36-char iid is
      // a policy violation — close, never service.
      if (iid.length !== IID_LEN) {
        onLog(`reject: bad iid (len=${iid.length})`);
        socket.close(1008, 'missing or malformed iid');
        return;
      }
      onLog(`connected: iid=${iid}`);
      sockets.set(socket, iid);
      socket.on('close', () => {
        sockets.delete(socket);
        authenticated.delete(socket);
      });
      // A socket's handshake state, as the desktop's: open, pending (the desktop
      // proved itself, the extension's proof awaited), authenticated, failed.
      // `bound`: a frame other than sys_ping, the pairing and the handshake
      // was served on the socket. `attempt`: a pairing begun on it.
      const state = { phase: 'open', bound: false, attempt: null };
      const log = { iid, methods: [], auth: [] };
      socketLogs.push(log);
      const listening = wss.address().port;

      socket.on('message', (raw) => {
        let req;
        try {
          req = JSON.parse(raw.toString());
        } catch {
          socket.send(fail(iid, '', 1100, 'malformed frame'));
          return;
        }
        // The envelope iid must match the handshake iid (real server invariant).
        if (req.iid !== iid) {
          // Log both ids: a mismatch means the extension opened the socket with
          // one iid and stamped frames with another, which is a cold-start race,
          // not a malformed frame — the two ids are what tells them apart.
          onLog(
            `iid mismatch: socket=${iid} envelope=${req.iid} method=${req.method}`
          );
          socket.send(fail(iid, req.rid ?? '', 1100, 'iid mismatch'));
          return;
        }
        onLog(`req: ns=${req.ns} method=${req.method} rid=${req.rid}`);

        // Log EVERY frame that got past the iid gate, BEFORE any branch answers
        // it. Recording only the frames a handler serviced would make "no page
        // frame reached the sys namespace" unfalsifiable, because sys_ping
        // answers and returns above the handler table.
        frames.push({
          ns: req.ns,
          method: req.method,
          origin: req.origin,
          chain: req.chain,
          params: req.params,
        });
        log.methods.push(req.method);

        // sys_ping is EXEMPT from the version gate (so the extension can read our
        // version to decide compatibility) — answer it first.
        if (req.method === 'sys_ping') {
          socket.send(
            reply(iid, req, {
              wallet_status: auth.locked ? 'locked' : 'unlocked',
              protocol_version: version,
              desktop_session: desktopSession,
            })
          );
          return;
        }
        // The order on a socket: after a failed handshake nothing
        // but sys_ping; in the middle of one nothing but its finish.
        const handshake =
          req.ns === 'sys' &&
          (req.method === 'sys_auth_begin' || req.method === 'sys_auth_finish');
        const pairing =
          req.ns === 'sys' &&
          (req.method === 'sys_pair_begin' || req.method === 'sys_pair_finish');
        if (state.phase === 'failed') {
          socket.send(fail(iid, req.rid, 4100, 'authentication failed'));
          return;
        }
        if (state.phase === 'pending' && req.method !== 'sys_auth_finish') {
          socket.send(
            fail(
              iid,
              req.rid,
              4100,
              'a handshake is in progress on this connection'
            )
          );
          return;
        }

        // Version gate, mirroring the desktop's dispatcher: a non-sys request whose
        // `v` is incompatible (wallet/major mismatch) is refused with
        // VersionIncompatible (1103), no work done.
        if (!compatible(req.v, version)) {
          socket.send(
            fail(iid, req.rid, 1103, 'protocol version incompatible')
          );
          return;
        }

        if (pairing) {
          handlePairing(socket, iid, req, state, listening);
          return;
        }
        if (handshake) {
          handleHandshake(socket, iid, req, state, listening, log);
          return;
        }
        // Mandatory authentication: anything else on a socket
        // that has not authenticated is refused and binds nothing.
        if (required && state.phase !== 'authenticated') {
          socket.send(
            fail(iid, req.rid, 4100, 'the connection is not authenticated')
          );
          return;
        }
        if (!state.bound) {
          firstFrames.push({ iid, method: req.method });
        }
        state.bound = true;

        // sys_resume, behind the version gate as on the desktop: a presented
        // secret equal to the instance's current one restores; every answer mints
        // the next one. (The stub keeps no sessions to drop: it records.)
        if (req.ns === 'sys' && req.method === 'sys_resume') {
          const presented =
            typeof req.params?.resume === 'string' ? req.params.resume : null;
          const restored =
            presented !== null && bindings.get(iid) === presented;
          const minted = randomBytes(32).toString('hex');
          bindings.set(iid, minted);
          resumes.push({ presented, restored, minted });
          socket.send(reply(iid, req, { resume: minted, restored }));
          return;
        }

        // The confirmation the user declines. Ordered AFTER the version gate and
        // before any result, exactly where the desktop's sink decision sits.
        if (refused.has(req.method)) {
          socket.send(
            fail(iid, req.rid, 4001, 'user rejected the request in the wallet')
          );
          return;
        }

        // Refuse a malformed shape where the desktop does: after the version and
        // confirmation gates, before any result. Without this the stub answers a
        // frame the real wallet would reject, and the e2e passes on a contract
        // the product does not honour.
        const shape = PARAMS_SHAPE[`${req.ns}|${req.method}`];
        if (shape !== undefined && !shapeOk(shape, req.params)) {
          socket.send(
            fail(
              iid,
              req.rid,
              1100,
              `${req.method} params must be ${
                shape === 'object' ? 'an object' : 'an array of one object'
              }`
            )
          );
          return;
        }

        // The desktop's signing service hex-decodes personal_sign's message
        // and fails a non-hex one with
        // this message after the user approved it; the dApp sees -32003. The
        // dispatcher's shape check passes such a frame, so without this refusal
        // a plain-text message the extension forgot to encode reads as signed
        // here and fails only against the real wallet.
        if (
          req.ns === 'evm' &&
          req.method === 'personal_sign' &&
          !/^0x([0-9a-fA-F]{2})*$/.test(String(req.params?.message))
        ) {
          socket.send(
            fail(iid, req.rid, -32003, 'personal_sign message is not valid hex')
          );
          return;
        }

        const handler = HANDLERS[`${req.ns}|${req.method}`];
        if (handler === undefined) {
          socket.send(fail(iid, req.rid, 4200, `unsupported: ${req.method}`));
          return;
        }
        socket.send(reply(iid, req, handler(req)));
      });
    });

    wss.on('listening', () => {
      const { port: boundPort } = wss.address();
      onLog(`listening on 127.0.0.1:${boundPort}`);
      resolve({
        port: boundPort,
        grantedAccount: GRANTED_ACCOUNT,
        fixtures: FIXTURES,
        frames,
        resumes,
        firstFrames,
        // The desktop closes every socket (what the MV3 worker's eviction looks
        // like from the wire) / forgets every binding (a lock, an unpair).
        dropSockets: () => {
          for (const socket of sockets.keys()) socket.terminate();
        },
        forgetBindings: () => bindings.clear(),
        // Pairing and the handshake: the codes the dialog would show, every
        // pairing begin, each socket's frames and handshake begins, whether an
        // instance is paired; a reset of every pairing secret (Settings "reset
        // pairing"), the lock, and an impostor that answers the handshake
        // without the secret.
        shownCodes,
        pairBegins,
        socketLogs,
        isPaired: (iid) => secrets.has(iid),
        secrets,
        authenticatedCount: () => auth.authenticated,
        // Settings' reset: every secret goes, and every socket is closed as
        // the desktop closes them.
        resetPairing: () => {
          secrets.clear();
          for (const socket of sockets.keys()) {
            socket.close(1000, 'dApp sessions reset');
          }
        },
        // A lock closes every socket, as the desktop's does.
        setLocked: (on) => {
          auth.locked = on;
          if (on) {
            for (const socket of sockets.keys()) {
              socket.close(1000, 'dApp sessions reset');
            }
          }
        },
        setImposter: (on) => {
          auth.imposter = on;
        },
        // The event frame the desktop writes: every key
        // present, `chain` an empty string when the push is not tied to one.
        push: ({ origin, ns, chain = '', event, data }) => {
          for (const [socket, iid] of sockets) {
            if (required && !authenticated.has(socket)) {
              continue;
            }
            socket.send(
              JSON.stringify({
                v: version,
                iid,
                ns,
                origin,
                chain,
                event,
                data,
              })
            );
          }
          onLog(`push: ns=${ns} chain=${chain} event=${event}`);
        },
        close: () =>
          new Promise((done) => {
            for (const c of wss.clients) c.terminate();
            wss.close(() => done());
          }),
      });
    });
  });
}
