// The desktop WebSocket transport client, owned by the service worker. It opens
// ws://127.0.0.1:<port>/rpc?iid=<iid> on demand, sends v2 request frames, and
// resolves each by its `rid`. The MV3 SW may be evicted between requests (the
// socket then closes); the client reconnects lazily on the next send, with a
// bounded exponential backoff for a desktop that is down / locked / web3-off.
//
// The port is no longer fixed: the client is given an ORDERED candidate list
// (one pinned port in Manual mode, the predefined loopback set in Auto). In both
// modes it sys_ping-probes the candidates and keeps the first that answers as an
// AirNox v2 server (a bare WS open proves only "something listens", not "the
// wallet listens"); the resolved port is cached and only re-scanned if it stops
// opening (e.g. the desktop restarted on a different Auto port).
//
// A DESKTOP THAT IS NOT RUNNING IS A NORMAL STATE, NOT AN ERROR. The user starts
// the signer when they need it, so the transport must stay quiet in between —
// and "quiet" here can only mean OPENING FEWER SOCKETS: Chrome writes
// `WebSocket connection to 'ws://127.0.0.1:<port>/rpc?iid=...' failed: ...
// net::ERR_CONNECTION_REFUSED` to the worker console from below the JS layer, on
// every refused connect. It is not an exception and no listener suppresses it,
// so every socket this client opens against a dead port costs one console line.
// Two rules follow, and both are load-bearing:
//   * the connect budget is the CALLER's (see ensureConnected) — the badge
//     heartbeat spends ONE pass, because its retry is the next alarm tick;
//     a dApp request keeps the full retry sequence, because a user is waiting;
//   * the sequence is single-flighted with the budget raised (never lowered) by
//     late joiners, so concurrent callers share one set of sockets.
// The cadence of the heartbeat itself backs off while the desktop is down —
// that half lives in transport/heartbeat_schedule.ts.

import { v4 as uuidv4 } from 'uuid';
import {
  ErrorCode,
  Event,
  ProtocolVersion,
  Request,
  Response,
  WEB3_PROTOCOL_VERSION,
  WalletStatus,
  WireError,
  checkVersion,
  isAuthRequiredAt,
  isVersionCompatible,
  parseProtocolVersion,
  isEvent,
  isResponse,
  isAirNoxSysPingResult,
  AuthMethod,
  SYS_AUTH_BEGIN,
  SYS_PAIR_BEGIN,
  SYS_PAIR_FINISH,
  makeRequest,
  readDesktopSession,
  readDesktopVersion,
  readResumeResult,
  versionErrorMessage,
  wsUrl,
} from '../protocol/envelope';
import {
  HandshakeFailure,
  HandshakeOutcome,
  authenticate,
} from './socket_auth';
import { keyFingerprint } from './key_fingerprint';
import { SwKeepalive } from './sw_keepalive';

// A confirm-bearing method (connect / sign / tx) blocks on the desktop until the
// user decides, which can take minutes — so the per-request timeout is generous;
// it is only a backstop against a desktop that never answers. A dropped socket
// rejects in-flight requests immediately via onClose, well before this fires.
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const PING_TIMEOUT_MS = 5 * 1000;
// A handshake frame no dApp waits on is answered at once (a locked wallet is a
// refusal, not a prompt); the begin a dApp's request waits on may sit behind the
// desktop's unlock window, so it gets the request timeout.
const HANDSHAKE_TIMEOUT_MS = 5 * 1000;
// While a dApp request is outstanding, ping this often to keep the MV3 worker
// alive — comfortably under Chrome's ~30s SW idle-eviction window (a WS message
// resets that timer on Chrome 116+).
const KEEPALIVE_MS = 20 * 1000;

// A dApp request has a user waiting on it, so its connect retries through a
// desktop that is slow to bind (mid-start, mid-restart).
const MAX_CONNECT_ATTEMPTS = 4;
// The badge heartbeat spends a SINGLE pass: a refused loopback connect is a
// definitive answer, not a transient one, and the next alarm tick IS the retry.
// Retrying here would multiply the console noise of an absent desktop by four
// for no information gained.
const PING_CONNECT_ATTEMPTS = 1;
const BACKOFF_BASE_MS = 200;
const BACKOFF_MAX_MS = 2000;
const OPEN_TIMEOUT_MS = 4000;
// A probe opens + sys_pings a candidate port; a port where something non-AirNox
// listens opens but never sends a v2 reply, so the probe needs its own timeout.
const PROBE_TIMEOUT_MS = 2500;

// A throwaway, format-valid iid for discovery probes. The persisted iid is a
// stable pairing handle, so it must NOT be sent to a candidate port until that
// port is confirmed to be an AirNox server. The desktop requires a 36-char iid to
// ACCEPT the socket and matches the frame iid to it, but
// sys_ping is exempt from pairing — so this constant placeholder probes cleanly.
// The real iid is sent only by openOnce, on the resolved (verified) port.
const PROBE_IID = '00000000-0000-0000-0000-000000000000';

type Pending = {
  resolve: (r: Response) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type StatusListener = (
  connected: boolean,
  walletStatus?: WalletStatus,
  // The desktop's protocol version, read from the sys_ping reply — lets the SW
  // compute the compatibility verdict. Absent when offline or on a reply that
  // carries no version.
  desktopVersion?: ProtocolVersion,
  // The desktop session the sys_ping reply names — lets the SW tell a restarted
  // desktop from the one it was talking to. Absent when offline,
  // or from a desktop that does not name one.
  desktopSession?: string
) => void;

// Unsolicited push (accountsChanged / chainChanged / …) from the desktop. The
// SW routes it to the right page by ev.origin.
export type EventListener = (ev: Event) => void;

// Where the desktop's resume secret is kept between sockets (storage.session in
// the SW: it outlives a worker eviction, never reaches the disk and is not
// readable by content scripts). The desktop holds an instance's dApp sessions
// when its socket closes and gives them back only to a socket whose FIRST frame,
// sys_resume, presents the secret the previous one was handed: the iid alone
// rides the URL and every frame. `lost` runs when a secret was presented and the
// sessions were not restored (a lock, an unpair, a desktop restart, or a socket
// that only claimed the iid in between): the pages must forget their accounts.
export type ResumeStore = {
  load(): Promise<string | undefined>;
  save(secret: string): Promise<void>;
  lost(): void;
};

// The socket handshake's collaborators (socket_auth.ts). With them, a socket is
// BOUND (its sys_resume sent, dApp frames let through) only after it
// authenticated with the key a pairing by code left in this browser; with no
// key, it is bound as before while authentication is not required, and never
// once it is.
export type SocketAuth = {
  // The pairing key of `iid`, or undefined when this browser holds none.
  // Rejects when the store could not be read: the socket is then refused, never
  // served as if this browser held no key.
  loadKey(iid: string): Promise<CryptoKey | undefined>;
  // A dApp's connect (opensPairing) found no pairing the desktop accepts: the
  // person may pair on the extension's pairing page, which this may open for
  // `origin` (the caller holds back a dApp that keeps connecting). Never called
  // for any other request: a page polling a read raises nothing.
  pairingNeeded(origin: string): void;
  // Whether a socket must authenticate before it is bound. Defaults to the
  // rule at this extension's own protocol version: a desktop of another major
  // is refused by the version gate anyway.
  required?: boolean;
  // Injected by the tests; random otherwise.
  nonce?: () => Uint8Array;
  // Whether the key with this fingerprint (key_fingerprint.ts) is distrusted: a
  // program on the desktop's port could not prove it holds it. Such a key is
  // never offered to a handshake again; a pairing by code stores a new key,
  // whose fingerprint no record names. Kept where it outlives a browser
  // restart and an update of the extension; a failed read counts as not
  // distrusted (the handshake still verifies the desktop before anything of
  // ours is sent).
  keyDistrusted?: (fingerprint: string) => Promise<boolean>;
  distrustKey?: (fingerprint: string) => Promise<void>;
};

// A socket that failed its handshake: closed, nothing bound, and the connect is
// not retried, since a desktop that cannot prove the pairing on this port will
// not on the next pass either.
export class HandshakeFailureError extends Error {
  constructor(readonly failure: HandshakeFailure, message: string) {
    super(message);
    this.name = 'HandshakeFailureError';
  }
}

// Every text here reaches the dApp, which has no use for the desktop's
// loopback port, so none of them names it.
const handshakeFailureMessage = (failure: HandshakeFailure): string => {
  switch (failure) {
    case 'interception':
      return `the program on the AirNox Wallet desktop app's port could not prove it is the paired desktop app; another program may be listening there. ${RESET_PAIRING_ADVICE}`;
    case 'proof-refused':
      return "the AirNox Wallet desktop app did not accept this browser's pairing; pair again from the extension's popup";
    case 'bad-answer':
      return 'the AirNox Wallet desktop app answered the connection handshake with something unexpected';
  }
};

const RESET_PAIRING_ADVICE =
  "If AirNox Wallet is running, reset this browser's pairing key in its Settings, then pair again by code from the Pairing row of the AirNox extension's popup.";

// What a dApp hears while this browser's key is distrusted.
export const PAIRING_KEY_DISTRUSTED_MESSAGE = `AirNox will not offer this browser's pairing key again: the program on the desktop app's port could not prove it is the paired AirNox Wallet. ${RESET_PAIRING_ADVICE}`;

export const PAIRING_KEY_UNREADABLE_MESSAGE =
  "AirNox could not read this browser's pairing key; try again, or pair again from the Pairing row of the AirNox extension's popup.";

// What a dApp hears when the person must pair first. A connect may have opened
// the pairing window; any other request opened nothing.
export const PAIRING_NEEDED_MESSAGE =
  "This browser is not paired with AirNox Wallet: pair it in the AirNox pairing window or from the Pairing row of the AirNox extension's popup, type the code the desktop app shows, then try again.";

// The requests that may open the pairing window: a dApp asking to connect (the
// person's own gesture, as a rule), never a read, a sign or anything a page
// can send on its own timer. Keyed by method, which no other namespace reuses.
const CONNECT_METHODS: ReadonlySet<string> = new Set([
  'eth_requestAccounts',
  'wallet_requestPermissions',
  'standard:connect',
  'tonConnect_connect',
  'tron_requestAccounts',
]);

// A wire code is any number: the refusal that sends the person to pair.
const NOT_PAIRED_CODE: number = ErrorCode.NotPaired;

export const opensPairing = (req: Request): boolean =>
  req.ns !== 'sys' && CONNECT_METHODS.has(req.method);

// Does `req` hold the MV3 worker awake while it is in flight? A dApp request
// does: the desktop may sit on it for minutes awaiting the person. So do the
// two pairing frames: the desktop answers sys_pair_begin only after its unlock
// window when the wallet is locked, and sys_pair_finish after it recorded the
// pairing. So does a handshake begin that names a dApp: a locked desktop
// answers it after its unlock window. The other sys frames are excluded, so the
// keepalive tick (itself a sys_ping) never sustains itself.
export const keepsWorkerAwake = (req: Request): boolean =>
  req.ns !== 'sys' ||
  req.method === SYS_PAIR_BEGIN ||
  req.method === SYS_PAIR_FINISH ||
  (req.method === SYS_AUTH_BEGIN &&
    typeof (req.params as { origin?: unknown } | undefined)?.origin ===
      'string');

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// Return the first port (in order) for which `probe` resolves true, or null if
// none do. Pure orchestration of the discovery scan — `probe` performs the
// actual open + sys_ping + v2 verify, so this is unit-testable without a socket.
export async function resolveFirstReachablePort(
  ports: readonly number[],
  probe: (port: number) => Promise<boolean>
): Promise<number | null> {
  for (const port of ports) {
    if (await probe(port)) {
      return port;
    }
  }
  return null;
}

export class WsClient {
  private ws: WebSocket | null = null;
  // The loopback port `ws` was opened on.
  private wsPort: number | null = null;
  // `ws` has sent its sys_resume: the desktop bound it to this instance, and dApp
  // frames may go out on it. A socket that authenticates is bound only after its
  // handshake; one that stays unbound carries sys_ping and the pairing frames.
  private bound = false;
  // The handshake (and the bind behind it) running on `ws`, if any.
  private binding: Promise<BindResult> | null = null;
  // The socket's own handshake was refused because the wallet is locked: the
  // heartbeat that sees it unlocked tries again.
  private bindWhenUnlocked = false;
  // A pairing by code is under way: a new socket is left unbound for it rather
  // than authenticated with the key the pairing is replacing (a key that no
  // longer matches the desktop's would fail every handshake, and leave nothing
  // to pair on). Cleared by afterPairing, by a pairing frame the desktop
  // refused or never answered, by the close of the socket the pairing ran on,
  // and by pairingEnded (the pairing window closed); a dApp frame still binds
  // the socket it goes out on.
  private pairingUnderWay = false;
  // The fingerprint of the pairing key that failed a desktop's proof (see
  // SocketAuth.keyDistrusted), or null. A key a new pairing stores has another.
  private distrustedKey: string | null = null;
  // The protocol version the desktop last reported (the discovery probe, then
  // every sys_ping), or null before the first.
  private desktopVersion: ProtocolVersion | null = null;
  // The socket the last pairing frame went out on.
  private pairingSocket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  // Connect passes the in-flight sequence may still spend; the maximum any of
  // its awaiting callers asked for (see ensureConnected). Zero when idle.
  private connectBudget = 0;
  private resolvedPort: number | null = null;
  private readonly pending = new Map<string, Pending>();
  // Holds the worker alive while ≥1 dApp request is in flight (sys_ping is
  // excluded so the keepalive tick never sustains itself — see send()).
  private readonly keepalive = new SwKeepalive(
    () => void this.ping(),
    KEEPALIVE_MS
  );

  constructor(
    private readonly iid: string,
    // Ordered candidate ports: [pinnedPort] in Manual, the predefined set in
    // Auto (see transport/settings.ts candidatePorts).
    private readonly ports: readonly number[],
    private readonly onStatus?: StatusListener,
    private readonly onEvent?: EventListener,
    private readonly resumeStore?: ResumeStore,
    private readonly auth?: SocketAuth
  ) {}

  // The loopback port the client last resolved / connected on (the candidate the
  // discovery probe verified), or null before the first connect / after a failed
  // one. The popup surfaces it in its Port row.
  get currentPort(): number | null {
    return this.resolvedPort;
  }

  // Send a fully-formed wire request and resolve its response by `rid`.
  // `connectAttempts` is the caller's connect budget — see ensureConnected.
  async send(
    req: Request,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
    connectAttempts: number = MAX_CONNECT_ATTEMPTS
  ): Promise<Response> {
    return (await this.exchange(req, timeoutMs, connectAttempts)).response;
  }

  // send(), and the loopback port of the socket the request went out on. The
  // pairing binds that port into its transcript: it must be the port this
  // frame was written to, not whatever the client resolves later.
  //
  // A dApp frame goes out only on a bound socket. When the socket cannot be
  // bound for it (the desktop holds no pairing for this browser, the person
  // skipped the unlock window, the handshake failed), the frame is not sent and
  // the request is answered with the reason, under its own rid. A failed
  // handshake answers Disconnected (4900), not Unauthorized: the desktop was
  // never reached, so nothing is said about the dApp's grant (a 4100 makes a
  // provider forget the accounts it cached).
  async exchange(
    req: Request,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
    connectAttempts: number = MAX_CONNECT_ATTEMPTS
  ): Promise<{ response: Response; port: number }> {
    const dapp = req.ns !== 'sys';
    const pairing =
      req.ns === 'sys' &&
      (req.method === SYS_PAIR_BEGIN || req.method === SYS_PAIR_FINISH);
    if (pairing) {
      this.pairingUnderWay = true;
    }
    try {
      await this.ensureConnected(connectAttempts);
    } catch (e) {
      if (!(e instanceof HandshakeFailureError)) {
        throw e;
      }
      if (dapp) {
        return this.refusal(req, {
          code: ErrorCode.Disconnected,
          message: e.message,
        });
      }
      if (!pairing) {
        throw e;
      }
      // A connect that was under way when the pairing began failed its
      // handshake with the old key: the next socket is left for the pairing.
      await this.ensureConnected(connectAttempts);
    }
    const ws = this.ws;
    const port = this.wsPort;
    if (!ws || port === null) {
      throw new Error('transport is not connected');
    }
    if (dapp) {
      let refused: WireError | undefined;
      try {
        refused = await this.ensureBound(ws, port, req.origin);
      } catch (e) {
        if (e instanceof HandshakeFailureError) {
          return this.refusal(req, {
            code: ErrorCode.Disconnected,
            message: e.message,
          });
        }
        throw e;
      }
      if (refused) {
        if (
          refused.code === NOT_PAIRED_CODE &&
          opensPairing(req) &&
          req.origin !== '' &&
          this.auth
        ) {
          this.auth.pairingNeeded(req.origin);
        }
        return this.refusal(req, refused);
      }
      if (this.ws !== ws) {
        throw new Error('transport disconnected');
      }
    }
    if (pairing) {
      this.pairingSocket = ws;
      let response: Response;
      try {
        response = await this.roundTrip(ws, req, timeoutMs);
      } catch (e) {
        this.pairingEnded();
        throw e;
      }
      if (!response.ok) {
        this.pairingEnded();
      }
      return { response, port };
    }
    return { response: await this.roundTrip(ws, req, timeoutMs), port };
  }

  // A request answered here, without reaching the desktop.
  private refusal(
    req: Request,
    error: WireError
  ): { response: Response; port: number } {
    return {
      response: {
        v: WEB3_PROTOCOL_VERSION,
        iid: this.iid,
        rid: req.rid,
        ok: false,
        error,
      },
      port: this.wsPort ?? 0,
    };
  }

  // Write `req` on `ws` and resolve its answer by rid. Rejects on its timeout, on
  // a malformed answer and when the socket closes.
  private roundTrip(
    ws: WebSocket,
    req: Request,
    timeoutMs: number
  ): Promise<Response> {
    // Hold the worker awake for a request the desktop may sit on for minutes
    // (keepsWorkerAwake).
    const holdsWorker = keepsWorkerAwake(req);
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const release = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (holdsWorker) {
          this.keepalive.end();
        }
      };
      const timer = setTimeout(() => {
        this.pending.delete(req.rid);
        release();
        reject(new Error('request timed out'));
      }, timeoutMs);
      this.pending.set(req.rid, {
        resolve: (r) => {
          release();
          resolve(r);
        },
        reject: (e) => {
          release();
          reject(e);
        },
        timer,
      });
      if (holdsWorker) {
        this.keepalive.begin();
      }
      try {
        ws.send(JSON.stringify(req));
      } catch (e) {
        // The socket slipped to CLOSING between the OPEN check and here — fail
        // this request now rather than leave the entry until onClose / timeout.
        clearTimeout(timer);
        this.pending.delete(req.rid);
        release();
        reject(e instanceof Error ? e : new Error('ws send failed'));
      }
    });
  }

  // A pairing by code just stored a new key. A socket bound without it (or with
  // the key it replaced) is closed, so the next one authenticates with the new
  // key; an unbound one authenticates now, on the same socket.
  afterPairing(): void {
    this.pairingUnderWay = false;
    this.pairingSocket = null;
    const ws = this.ws;
    if (!ws) {
      return;
    }
    if (this.bound) {
      ws.close();
      return;
    }
    const port = this.wsPort;
    if (port !== null) {
      void this.ensureBound(ws, port, undefined).catch(() => undefined);
    }
  }

  // A pairing ended without a new key: the desktop refused a pairing frame (a
  // wrong code, the person cancelled, the cooldown), or the pairing window was
  // closed. A socket left unbound for the pairing binds now, as it would have
  // when it opened.
  pairingEnded(): void {
    if (!this.pairingUnderWay) {
      return;
    }
    this.pairingUnderWay = false;
    this.pairingSocket = null;
    const ws = this.ws;
    const port = this.wsPort;
    if (ws && port !== null && !this.bound && this.binding === null) {
      void this.ensureBound(ws, port, undefined).catch(() => undefined);
    }
  }

  // Connect if the socket is not already open, spending at most `attempts`
  // connect passes.
  //
  // ONE sequence runs at a time and every caller awaits it, so a heartbeat and a
  // dApp request landing together open one set of sockets, not two. The budget is
  // shared state the running sequence re-reads each iteration, and a joiner only
  // ever RAISES it: a dApp request arriving mid-heartbeat lifts that single pass
  // to the full retry sequence rather than inheriting the heartbeat's frugality,
  // while a heartbeat joining a dApp connect cannot cut it short. A socket that
  // is open but still running its own handshake belongs to the sequence: a
  // caller waits for it rather than writing ahead of the handshake.
  private ensureConnected(attempts: number): Promise<void> {
    if (!this.connecting && this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    this.connectBudget = Math.max(this.connectBudget, attempts);
    if (!this.connecting) {
      this.connecting = this.connectSequence().finally(() => {
        this.connecting = null;
        this.connectBudget = 0;
      });
    }
    return this.connecting;
  }

  private async connectSequence(): Promise<void> {
    let delay = BACKOFF_BASE_MS;
    // `connectBudget` is read live, not captured: a caller that joins mid-sleep
    // extends the sequence it is waiting on instead of starting a second one.
    for (let attempt = 0; attempt < this.connectBudget; attempt++) {
      try {
        const port = await this.resolvePort();
        await this.openOnce(port);
        return;
      } catch (e) {
        // Drop the cached port so the next attempt re-scans — this is what
        // recovers when the desktop has moved to a different Auto port.
        this.resolvedPort = null;
        if (e instanceof HandshakeFailureError) {
          this.onStatus?.(false);
          throw e;
        }
        if (attempt < this.connectBudget - 1) {
          await sleep(delay);
          delay = Math.min(delay * 2, BACKOFF_MAX_MS);
        }
      }
    }
    this.onStatus?.(false);
    throw new Error('cannot reach the AirNox Wallet desktop app');
  }

  // The loopback port to connect on: the cached one, or the first candidate that
  // verifies as an AirNox v2 server. Manual mode's single pinned port is probed
  // like Auto's set: the real iid opens the desktop's held sessions and rides
  // every frame, so it goes only to a port that answered a probe as the wallet.
  private async resolvePort(): Promise<number> {
    if (this.resolvedPort !== null) {
      return this.resolvedPort;
    }
    if (this.ports.length === 0) {
      throw new Error('no candidate ports configured');
    }
    const found = await resolveFirstReachablePort(this.ports, (p) =>
      this.probePort(p)
    );
    if (found === null) {
      throw new Error('no AirNox v2 server found on the candidate ports');
    }
    this.resolvedPort = found;
    return found;
  }

  // Open a throwaway socket to `port`, sys_ping it, and resolve true iff the
  // reply is an AirNox v2 frame. Always closes the probe socket.
  private probePort(port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      // PROBE_IID, not the real iid — the candidate may be a non-AirNox listener.
      const ws = new WebSocket(wsUrl(PROBE_IID, port));
      const rid = uuidv4();
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* already closing */
        }
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS);
      ws.addEventListener('open', () => {
        try {
          ws.send(
            JSON.stringify(makeRequest(PROBE_IID, rid, 'sys', '', 'sys_ping'))
          );
        } catch {
          done(false);
        }
      });
      ws.addEventListener('message', (ev: MessageEvent) => {
        let msg: unknown;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        } catch {
          return;
        }
        if (isResponse(msg) && msg.rid === rid) {
          const airnox = msg.ok && isAirNoxSysPingResult(msg.result);
          if (airnox) {
            this.desktopVersion = readDesktopVersion(msg.result);
          }
          done(airnox);
        }
      });
      ws.addEventListener('error', () => done(false));
      ws.addEventListener('close', () => done(false));
    });
  }

  // Open the instance's socket on `port` and bind it: its handshake first when
  // this browser holds a pairing key, then sys_resume. Resolves once the socket
  // is open and its handshake has an outcome, before any queued request goes
  // out on it: the desktop binds a socket by its first frame after the
  // handshake, and anything else first drops the sessions the instance held.
  private async openOnce(port: number): Promise<void> {
    const ws = await this.dial(port);
    this.ws = ws;
    this.wsPort = port;
    this.bound = false;
    this.binding = null;
    this.bindWhenUnlocked = false;
    ws.addEventListener('message', (ev) => this.onMessage(ev));
    ws.addEventListener('close', () => this.onClose(ws));
    ws.addEventListener('error', () => this.onClose(ws));
    if (!(this.pairingUnderWay && this.auth)) {
      await this.ensureBound(ws, port, undefined);
    }
    if (this.ws !== ws) {
      throw new Error('ws closed during its handshake');
    }
    void this.ping();
  }

  // A socket to `port` once it opened; rejects when it fails or times out.
  private dial(port: number): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(wsUrl(this.iid, port));
      const timer = setTimeout(() => {
        cleanup();
        ws.close();
        reject(new Error('ws open timed out'));
      }, OPEN_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onFail);
        ws.removeEventListener('close', onFail);
      };
      const onOpen = () => {
        cleanup();
        resolve(ws);
      };
      const onFail = () => {
        cleanup();
        reject(new Error('ws connect failed'));
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onFail);
      ws.addEventListener('close', onFail);
    });
  }

  // Bind `ws` for `origin` (undefined: the socket's own bind, which no dApp
  // waits on). Resolves undefined once it is bound, or the desktop's (or this
  // side's) reason it is not; rejects with a HandshakeFailureError, the socket
  // closed, when the handshake failed, and with an Error when the socket went
  // away. One bind runs at a time per socket; a caller asking for another
  // origin than the one just refused asks again, since the desktop answers a
  // begin that names a dApp differently (its unlock window).
  private async ensureBound(
    ws: WebSocket,
    port: number,
    origin: string | undefined
  ): Promise<WireError | undefined> {
    for (;;) {
      if (this.ws !== ws) {
        throw new Error('transport disconnected');
      }
      if (this.bound) {
        return undefined;
      }
      const running = this.binding;
      if (running === null) {
        break;
      }
      const prior = await running;
      if (this.ws === ws && !this.bound && prior.origin === origin) {
        return prior.refused;
      }
    }
    const flight = this.bindSocket(ws, port, origin);
    this.binding = flight;
    try {
      return (await flight).refused;
    } finally {
      if (this.binding === flight) {
        this.binding = null;
      }
    }
  }

  private async bindSocket(
    ws: WebSocket,
    port: number,
    origin: string | undefined
  ): Promise<BindResult> {
    const auth = this.auth;
    if (!auth) {
      await this.resume(ws);
      return { origin };
    }
    let key: CryptoKey | undefined;
    try {
      key = await auth.loadKey(this.iid);
    } catch {
      // This browser may hold a key it could not read: refuse, and never serve
      // the socket as if it held none. A later request reads it again.
      return {
        origin,
        refused: {
          code: ErrorCode.Internal,
          message: PAIRING_KEY_UNREADABLE_MESSAGE,
        },
      };
    }
    const required = auth.required ?? isAuthRequiredAt(WEB3_PROTOCOL_VERSION);
    if (key !== undefined || required) {
      // A desktop of another major refuses every frame but sys_ping, the
      // handshake and the pairing too: the person is told which side to
      // update, no key is offered and no pairing page opens.
      const desktop = this.desktopVersion;
      if (
        desktop !== null &&
        !isVersionCompatible(WEB3_PROTOCOL_VERSION, desktop)
      ) {
        return { origin, refused: versionRefusal(desktop) };
      }
    }
    if (key === undefined) {
      if (required) {
        return {
          origin,
          refused: {
            code: ErrorCode.NotPaired,
            message: PAIRING_NEEDED_MESSAGE,
          },
        };
      }
      // Before authentication is required, a browser that never paired by
      // code is served as before: the desktop's own connect prompt pairs it.
      await this.resume(ws);
      return { origin };
    }
    // A key whose fingerprint cannot be taken cannot be named in a record:
    // the handshake still verifies the desktop before anything of ours goes.
    const fingerprint = await keyFingerprint(key).catch(() => undefined);
    if (
      fingerprint !== undefined &&
      fingerprint !== this.distrustedKey &&
      (await (
        auth.keyDistrusted?.(fingerprint) ?? Promise.resolve(false)
      ).catch(() => false))
    ) {
      this.distrustedKey = fingerprint;
    }
    if (fingerprint !== undefined && fingerprint === this.distrustedKey) {
      return {
        origin,
        refused: {
          code: ErrorCode.Disconnected,
          message: PAIRING_KEY_DISTRUSTED_MESSAGE,
        },
      };
    }
    let outcome: HandshakeOutcome;
    // The version the desktop's last handshake answer carried: a refusal for
    // another major names the side to update by it.
    let answeredAt: unknown;
    try {
      outcome = await authenticate({
        request: async (method, params) => {
          const answer = await this.roundTrip(
            ws,
            this.handshakeFrame(method, params),
            method === SYS_AUTH_BEGIN && origin !== undefined
              ? REQUEST_TIMEOUT_MS
              : HANDSHAKE_TIMEOUT_MS
          );
          answeredAt = answer.v;
          return answer;
        },
        key,
        iid: this.iid,
        port,
        origin,
        nonce: auth.nonce,
      });
    } catch (e) {
      // A handshake that never ended leaves the socket somewhere in the
      // desktop's order this side no longer knows: start over on a new one.
      ws.close();
      throw e;
    }
    if (outcome.kind === 'failed') {
      if (outcome.failure === 'interception') {
        // Never offered again: the next socket would hand the same program
        // another chance to probe it. Filed under this key's fingerprint, so a
        // key a pairing stored meanwhile is not the one distrusted.
        if (fingerprint !== undefined) {
          this.distrustedKey = fingerprint;
          void auth.distrustKey?.(fingerprint).catch(() => undefined);
        }
      }
      ws.close();
      throw new HandshakeFailureError(
        outcome.failure,
        handshakeFailureMessage(outcome.failure)
      );
    }
    if (outcome.kind === 'refused') {
      if (outcome.reason === 'locked') {
        this.bindWhenUnlocked = true;
      }
      if (outcome.reason === 'not-paired') {
        return {
          origin,
          refused: {
            code: ErrorCode.NotPaired,
            message: PAIRING_NEEDED_MESSAGE,
          },
        };
      }
      if (outcome.reason === 'incompatible') {
        const desktop = parseProtocolVersion(answeredAt) ?? this.desktopVersion;
        if (
          desktop !== null &&
          !isVersionCompatible(WEB3_PROTOCOL_VERSION, desktop)
        ) {
          return { origin, refused: versionRefusal(desktop) };
        }
      }
      return { origin, refused: outcome.error };
    }
    await this.resume(ws);
    return { origin };
  }

  private handshakeFrame(
    method: AuthMethod,
    params: Record<string, string>
  ): Request {
    return makeRequest(this.iid, uuidv4(), 'sys', '', method, params);
  }

  // Send sys_resume on `ws` and mark it bound, in one step: no frame can go out
  // between the two. Without a resume store the socket is bound as it opens.
  private async resume(ws: WebSocket): Promise<void> {
    const store = this.resumeStore;
    const presented = store
      ? await store.load().catch(() => undefined)
      : undefined;
    if (this.ws !== ws) {
      throw new Error('transport disconnected');
    }
    this.sendResume(ws, presented);
    this.bound = true;
    this.bindWhenUnlocked = false;
  }

  private sendResume(ws: WebSocket, presented: string | undefined): void {
    const store = this.resumeStore;
    if (!store) {
      return;
    }
    const req = makeRequest(
      this.iid,
      uuidv4(),
      'sys',
      '',
      'sys_resume',
      presented !== undefined ? { resume: presented } : {}
    );
    const timer = setTimeout(
      () => this.pending.delete(req.rid),
      PING_TIMEOUT_MS
    );
    this.pending.set(req.rid, {
      resolve: (r) => void this.onResumed(r, presented, store),
      reject: () => undefined,
      timer,
    });
    try {
      ws.send(JSON.stringify(req));
    } catch {
      clearTimeout(timer);
      this.pending.delete(req.rid);
    }
  }

  private async onResumed(
    r: Response,
    presented: string | undefined,
    store: ResumeStore
  ): Promise<void> {
    // An older desktop answers UnsupportedMethod: it holds nothing, as before.
    const result = r.ok ? readResumeResult(r.result) : undefined;
    if (!result) {
      return;
    }
    await store.save(result.resume).catch(() => undefined);
    if (!result.restored && presented !== undefined) {
      store.lost();
    }
  }

  private onMessage(ev: MessageEvent): void {
    let msg: unknown;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    } catch {
      return; // a non-JSON frame is ignored (no rid to fail)
    }
    if (isResponse(msg)) {
      const slot = this.pending.get(msg.rid);
      if (slot) {
        clearTimeout(slot.timer);
        this.pending.delete(msg.rid);
        slot.resolve(msg);
      }
      // An unknown rid settles nothing: a stale or duplicate reply whose request
      // already settled, or the desktop's answer to a frame it could not parse,
      // which carries an EMPTY rid. Nothing in that answer says which request it
      // was, so it must not be pinned on one: the request in flight may be
      // another page's, waiting on the person's confirmation. Every request is
      // still bounded by its timeout and by onClose.
      return;
    }
    // An unsolicited event (no rid) — hand it to the SW to route by origin.
    if (isEvent(msg)) {
      this.onEvent?.(msg);
      return;
    }
    // Neither guard passed. A frame that names a request in flight is that
    // request's answer, malformed: fail it now rather than at its timeout.
    const rid = (msg as { rid?: unknown } | null)?.rid;
    if (typeof rid === 'string') {
      const slot = this.pending.get(rid);
      if (slot) {
        clearTimeout(slot.timer);
        this.pending.delete(rid);
        slot.reject(new Error('malformed reply from the desktop'));
      }
    }
  }

  private onClose(ws: WebSocket): void {
    // The pairing that ran on this socket ended with it.
    if (ws === this.pairingSocket) {
      this.pairingSocket = null;
      this.pairingUnderWay = false;
    }
    // Ignore a late close from a socket we already replaced — only the live
    // socket's close tears down the pending requests.
    if (this.ws !== ws) {
      return;
    }
    this.ws = null;
    this.wsPort = null;
    this.bound = false;
    this.bindWhenUnlocked = false;
    for (const slot of this.pending.values()) {
      clearTimeout(slot.timer);
      slot.reject(new Error('transport disconnected'));
    }
    this.pending.clear();
    this.onStatus?.(false);
  }

  // sys_ping heartbeat → drives the toolbar badge from the wallet's lock state.
  // Deliberately frugal: one connect pass, so an absent desktop costs one socket
  // per candidate port per tick and nothing more. A socket whose own handshake
  // the lock refused authenticates once the wallet reads unlocked, so it is
  // bound (and hears the desktop's pushes) before a dApp asks for anything.
  async ping(): Promise<void> {
    const req = makeRequest(this.iid, uuidv4(), 'sys', '', 'sys_ping');
    try {
      const resp = await this.send(req, PING_TIMEOUT_MS, PING_CONNECT_ATTEMPTS);
      const status = readWalletStatus(resp.result);
      const version = readDesktopVersion(resp.result) ?? undefined;
      if (version !== undefined) {
        this.desktopVersion = version;
      }
      this.onStatus?.(true, status, version, readDesktopSession(resp.result));
      const ws = this.ws;
      const port = this.wsPort;
      if (
        status === 'unlocked' &&
        this.bindWhenUnlocked &&
        ws &&
        port !== null &&
        !this.bound &&
        !this.binding
      ) {
        this.bindWhenUnlocked = false;
        void this.ensureBound(ws, port, undefined).catch(() => undefined);
      }
    } catch {
      this.onStatus?.(false);
    }
  }
}

// One bind of a socket: the origin it was run for, and why the socket is still
// unbound (undefined once it is bound).
type BindResult = { origin: string | undefined; refused?: WireError };

// The refusal for a desktop of another major: its version, and the side to
// update.
const versionRefusal = (desktop: ProtocolVersion): WireError => ({
  code: ErrorCode.VersionIncompatible,
  message: versionErrorMessage(checkVersion(desktop)),
});

function readWalletStatus(result: unknown): WalletStatus | undefined {
  if (typeof result === 'object' && result !== null) {
    const ws = (result as Record<string, unknown>).wallet_status;
    if (ws === 'locked' || ws === 'unlocked') {
      return ws;
    }
  }
  return undefined;
}
