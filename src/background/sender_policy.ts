// Who may talk to the service worker, decided from what the BROWSER says about a
// sender, never from what the sender says about itself. Kept free of `browser.*`
// (the sender is typed structurally) so it is unit-tested.
//
// A content script's frames carry the origin it stamped, and that stamp is honest
// only while the renderer it runs in is: a renderer compromised on one site can
// write any origin into a frame. Chromium's guidance for extensions is to treat
// content-script messages as untrusted and take the origin from the sender the
// browser attests, so the port's origin comes from here and a frame's own origin
// field is only ever compared with it.

// The parts of `runtime.MessageSender` this policy reads. `origin` is Chrome's
// (80+); Firefox gives only `url`, whose origin is the same for a top frame.
export interface SenderLike {
  tab?: unknown;
  frameId?: number;
  url?: string;
  origin?: string;
}

// The origin a content port serves, or undefined when the sender is not a
// content script in the top frame of a tab. The content script is declared for
// top frames only, so a port from a child frame or from outside a tab is not
// ours to serve. An opaque origin ("null") is refused as well: every sandboxed
// or opaque document shares it, so it names no one site a grant could be for.
export function contentPortOrigin(
  sender: SenderLike | undefined
): string | undefined {
  if (sender === undefined || typeof sender.tab !== 'object' || !sender.tab) {
    return undefined;
  }
  if (sender.frameId !== 0) {
    return undefined;
  }
  const origin = attestedOrigin(sender);
  if (origin === undefined || origin === '' || origin === 'null') {
    return undefined;
  }
  return origin;
}

function attestedOrigin(sender: SenderLike): string | undefined {
  if (sender.origin !== undefined) {
    // When the browser names the origin, that is the answer, even when it is
    // not the URL's: the URL is only where the document was loaded from.
    return typeof sender.origin === 'string' ? sender.origin : undefined;
  }
  if (typeof sender.url !== 'string') {
    return undefined;
  }
  try {
    return new URL(sender.url).origin;
  } catch {
    return undefined;
  }
}

// Whether a one-shot runtime message comes from one of the extension's own pages
// (the popup), which alone may read the status reply (it carries the pairing
// handle) or reset the transport. `extensionBase` is `runtime.getURL('')`, the
// extension's own origin with its trailing slash, so a prefix match cannot be
// satisfied by another extension whose id merely starts with ours. A content
// script's sender URL is its page's, so it never matches.
export function isExtensionPageSender(
  sender: SenderLike | undefined,
  extensionBase: string
): boolean {
  if (sender === undefined || typeof sender.url !== 'string') {
    return false;
  }
  if (!extensionBase.endsWith('/')) {
    return false; // not an origin with its slash: a prefix test would mean nothing
  }
  return sender.url.startsWith(extensionBase);
}
