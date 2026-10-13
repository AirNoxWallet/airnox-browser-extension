// The pure routing / decision core of the MV3 service worker, extracted from the
// browser glue in background.ts so it is unit-tested. It owns the per-origin port
// registry and the protocol-compatibility verdict, and decides — with NO
// `browser.*` dependency — how a page RPC is answered and where a desktop push is
// delivered. background.ts injects the transport `send`, the `iid` accessor and
// the `newRid` factory, and wires the browser listeners to these methods.

import {
  PortHello,
  PortRequest,
  PortResult,
  requestFieldsProblem,
} from '../protocol/bridge';
import {
  ErrorCode,
  Event,
  Request,
  Response,
  VersionVerdict,
  makeRequest,
  versionErrorMessage,
} from '../protocol/envelope';
import { PortPoster, postToPort } from './post_to_port';
import { SenderLike, contentPortOrigin } from './sender_policy';

export { versionErrorMessage };

// The service-worker collaborators the router needs but that depend on the
// browser / transport — injected so the router stays testable.
export interface RouterDeps {
  // Round-trip a wire frame to the desktop (WsClient.send).
  send(wire: Request): Promise<Response>;
  // The persisted extension instance id (getInstanceId, cached).
  iid(): Promise<string>;
  // A fresh per-request id (uuidv4).
  newRid(): string;
}

export class BackgroundRouter {
  // The origin the browser attests for each open content port (its sender), set
  // when the port connects.
  private readonly attested = new Map<PortPoster, string>();
  // The ports bound by a `hello` that named their attested origin, with that
  // origin: an unsolicited event reaches only the page(s) it concerns, and a
  // request is sent to the desktop under this origin and no other.
  private readonly portOrigins = new Map<PortPoster, string>();
  // The latest protocol-compatibility verdict; a major mismatch fails a request
  // fast, before a desktop round-trip.
  private verdict: VersionVerdict | undefined;

  constructor(private readonly deps: RouterDeps) {}

  // A content port as it connects: the origin the browser attests for its sender
  // (sender_policy.ts). False when the sender is not a content script in a tab's
  // top frame; the caller then closes the port.
  openPort(port: PortPoster, sender: SenderLike | undefined): boolean {
    const origin = contentPortOrigin(sender);
    if (origin === undefined) {
      return false;
    }
    this.attested.set(port, origin);
    return true;
  }

  // The content script's `hello` names the origin it stamped. The port is bound,
  // and starts receiving the pushes for that origin, only when the stamp is the
  // origin the browser attested: a mismatch means the renderer is lying about its
  // page, and the caller closes the port. A frame's stamp is never what is
  // trusted; the attested origin is.
  handleHello(port: PortPoster, hello: PortHello): boolean {
    const attested = this.attested.get(port);
    const claimed: unknown =
      typeof hello === 'object' && hello !== null ? hello.origin : undefined;
    if (attested === undefined || claimed !== attested) {
      return false;
    }
    this.portOrigins.set(port, attested);
    return true;
  }

  dropPort(port: PortPoster): void {
    this.attested.delete(port);
    this.portOrigins.delete(port);
  }

  // Update the compatibility verdict the version fail-fast gate reads; also read
  // back by the popup status reply, so the verdict lives in one place.
  setVerdict(verdict: VersionVerdict | undefined): void {
    this.verdict = verdict;
  }

  get compatibilityVerdict(): VersionVerdict | undefined {
    return this.verdict;
  }

  // An event the desktop pushed → forward it to every content port serving its
  // target origin. A page never sees another origin's event.
  routeEvent(ev: Event): void {
    if (!ev.origin) {
      return;
    }
    for (const [port, origin] of this.portOrigins) {
      if (origin === ev.origin) {
        postToPort(port, {
          kind: 'event',
          ns: ev.ns,
          chain: ev.chain,
          event: ev.event,
          data: ev.data,
        });
      }
    }
  }

  // page (via content) → desktop → page. The wire iid/rid and the v2 framing are
  // added here; the page only ever supplied { ns, method, params, chain }, and the
  // origin is the port's, which the browser attested.
  async handleRpc(port: PortPoster, req: PortRequest): Promise<void> {
    // The frame crossed a realm boundary, so its declared type is a claim. With
    // no string id there is nothing to answer it by: it is dropped.
    if (typeof (req.id as unknown) !== 'string') {
      return;
    }
    // The request is sent under the origin its port was bound to, which the
    // browser attested; the frame's own stamp must name the same one. A port
    // that is not bound, or a frame naming another origin, is a renderer acting
    // as a site it is not, and nothing of it reaches the desktop.
    const origin = this.portOrigins.get(port);
    if (origin === undefined || req.origin !== origin) {
      this.replyError(port, req.id, {
        code: ErrorCode.MalformedRequest,
        message: 'request origin is not the origin of its page',
      });
      return;
    }
    try {
      // Fail fast on a known protocol incompatibility — never forward to a desktop
      // we cannot safely talk to (the desktop also gates with VersionIncompatible;
      // this avoids the round-trip and gives an actionable message).
      if (this.verdict && !this.verdict.compatible) {
        this.replyError(port, req.id, {
          code: ErrorCode.VersionIncompatible,
          message: versionErrorMessage(this.verdict),
        });
        return;
      }
      // Defense-in-depth: the content script already refuses these, but the SW
      // re-checks so neither a `sys` control-plane frame nor one the desktop
      // cannot parse ever reaches the socket, whatever port path brought it in.
      const problem = requestFieldsProblem(req);
      if (problem !== undefined) {
        this.replyError(port, req.id, {
          code: ErrorCode.MalformedRequest,
          message: problem,
        });
        return;
      }
      const wire = makeRequest(
        await this.deps.iid(),
        this.deps.newRid(),
        req.ns,
        origin,
        req.method,
        req.params,
        req.chain
      );
      const resp = await this.deps.send(wire);
      postToPort(port, {
        kind: 'rpc-result',
        id: req.id,
        ok: resp.ok,
        result: resp.result,
        error: resp.error,
      });
    } catch (e) {
      this.replyError(port, req.id, {
        code: ErrorCode.Disconnected,
        message: e instanceof Error ? e.message : 'transport error',
      });
    }
  }

  private replyError(
    port: PortPoster,
    id: string,
    error: NonNullable<PortResult['error']>
  ): void {
    postToPort(port, { kind: 'rpc-result', id, ok: false, error });
  }
}
