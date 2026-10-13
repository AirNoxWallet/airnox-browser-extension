// The page->SW seam's request validation, kept pure (no window / no port) so it
// is unit-tested. content.ts owns the browser wiring (the window listener, the
// origin stamp, the relay) and delegates the "may this frame proceed?" decision
// here.

import {
  HolderReport,
  PageHolders,
  PageTouch,
  PAGE_TO_CONTENT,
  RpcRequest,
  parseHolderReport,
  requestFieldsProblem,
} from '../protocol/bridge';
import { ErrorCode } from '../protocol/envelope';

// The outcome of validating a raw page postMessage payload:
//   - `ignore`: not a well-formed request for us (wrong channel / no id). It
//     carries no correlatable id, so the caller drops it silently.
//   - `reject`: a request a page is not allowed to make (a `sys` control-plane
//     frame, an unknown namespace) or one whose fields would not make a wire
//     frame (see requestFieldsProblem). The caller replies with the error so the
//     dApp's promise settles instead of hanging.
//   - `touch`: the page reached for a provider but asked for nothing (see
//     PageTouch). It has no id and gets no reply; the caller just relays it.
//   - `holders`: the main world's answer to the content script's probe for who
//     holds each provider global (see PageHolders). It never leaves the content
//     script.
//   - `relay`: forward the typed request to the SW.
export type PageRequestResult =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'touch' }
  | { readonly kind: 'holders'; readonly report: HolderReport }
  | {
      readonly kind: 'reject';
      readonly id: string;
      readonly code: ErrorCode;
      readonly message: string;
    }
  | { readonly kind: 'relay'; readonly req: RpcRequest };

export function parsePageRequest(data: unknown): PageRequestResult {
  const frame = data as
    | Partial<RpcRequest & PageTouch & PageHolders>
    | undefined;
  if (!frame || frame.channel !== PAGE_TO_CONTENT) {
    return { kind: 'ignore' };
  }
  // A touch carries no id and no namespace — it is checked BEFORE the id guard
  // that drops everything else, and never reaches the namespace gate below.
  if (frame.touch === true) {
    return { kind: 'touch' };
  }
  // A holder report has no id either. One that is not exactly the shape the main
  // world sends is dropped: there is nothing to answer it with.
  if (frame.holders !== undefined) {
    const report = parseHolderReport(frame.holders);
    return report === undefined
      ? { kind: 'ignore' }
      : { kind: 'holders', report };
  }
  if (typeof frame.id !== 'string') {
    return { kind: 'ignore' };
  }
  const problem = requestFieldsProblem({ ...frame, id: frame.id });
  if (problem !== undefined) {
    return {
      kind: 'reject',
      id: frame.id,
      code: ErrorCode.MalformedRequest,
      message: problem,
    };
  }
  return { kind: 'relay', req: frame as RpcRequest };
}
