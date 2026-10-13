// The service worker's half of pairing by code: it carries the pairing page's
// two frames, sys_pair_begin and sys_pair_finish, over the desktop socket it
// owns, and answers with the desktop's reply plus the iid and the port the
// frame went out with. It derives nothing and keeps nothing: the attempt lives
// in the page (src/protocol/bridge.ts says why).
//
// The caller admits only the extension's own pages (sender_policy.ts). Even so
// the relay is no general `sys` pipe: a method other than the two, a field
// outside the frame's own, or a value that is not a string is refused before
// anything is sent. The desktop then checks every field again.
//
// Pure: background.ts injects the transport (WsClient.exchange), the iid and
// the rid factory.

import { PairRelayReply } from '../protocol/bridge';
import {
  PairMethod,
  Request,
  Response,
  SYS_PAIR_BEGIN,
  SYS_PAIR_FINISH,
  makeRequest,
} from '../protocol/envelope';

export interface PairRelayDeps {
  // Round-trip a frame and name the port of the socket it went out on.
  exchange(wire: Request): Promise<{ response: Response; port: number }>;
  // The persisted extension instance id.
  iid(): Promise<string>;
  // A fresh per-request id.
  newRid(): string;
}

// The fields each frame may carry.
const FIELDS: Record<PairMethod, readonly string[]> = {
  [SYS_PAIR_BEGIN]: ['epk', 'nc', 'origin'],
  [SYS_PAIR_FINISH]: ['mac'],
};

const isPairMethod = (m: unknown): m is PairMethod =>
  m === SYS_PAIR_BEGIN || m === SYS_PAIR_FINISH;

// The frame's params, when every key is one of the method's fields and every
// value a string; undefined otherwise.
const pairParams = (
  method: PairMethod,
  raw: unknown
): Record<string, string> | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!FIELDS[method].includes(k) || typeof v !== 'string') {
      return undefined;
    }
    out[k] = v;
  }
  return out;
};

export async function relayPairFrame(
  deps: PairRelayDeps,
  msg: unknown
): Promise<PairRelayReply> {
  const m =
    typeof msg === 'object' && msg !== null
      ? (msg as Record<string, unknown>)
      : {};
  const method = m.method;
  if (!isPairMethod(method)) {
    return { delivered: false, message: 'not a pairing frame' };
  }
  const params = pairParams(method, m.params);
  if (params === undefined) {
    return {
      delivered: false,
      message: `${method} takes only string fields of its own`,
    };
  }
  try {
    const iid = await deps.iid();
    const wire = makeRequest(iid, deps.newRid(), 'sys', '', method, params);
    const { response, port } = await deps.exchange(wire);
    return { delivered: true, answer: { iid, port, response } };
  } catch (e) {
    return {
      delivered: false,
      message: e instanceof Error ? e.message : 'transport error',
    };
  }
}
