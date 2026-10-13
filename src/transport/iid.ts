// The extension's instance id (`iid`): a UUIDv4 the desktop server requires as
// the WS handshake (exactly 36 chars) and as every frame's `iid`. Generated once
// and persisted in storage.local, reused across reconnects + SW evictions.
//
// Creation is SINGLE-FLIGHT. The read-then-write below is not atomic — there is
// an await between "storage has no iid" and "storage now has this iid" — so two
// concurrent first callers would each mint a UUID and each persist it, leaving
// the WsClient's socket (`?iid=`) and the router's frames stamped with DIFFERENT
// ids. The desktop cross-checks the two and refuses the frame with
// MalformedRequest (1100), which on a fresh install is every first connect. That
// race is real and was caught by the e2e; storage.local offers no
// compare-and-swap, so the fix is to let only one call run at a time.
//
// The service worker is the only context that calls this (the popup reads the
// iid back from the SW's status reply), so one guard per context is sufficient.

import browser from 'webextension-polyfill';
import { v4 as uuidv4 } from 'uuid';

import { singleFlight } from './single_flight';

const IID_KEY = 'airnox_instance_id';

async function readOrCreateInstanceId(): Promise<string> {
  const stored = await browser.storage.local.get(IID_KEY);
  const existing: unknown = stored[IID_KEY];
  if (typeof existing === 'string' && existing.length === 36) {
    return existing;
  }
  const iid = uuidv4();
  await browser.storage.local.set({ [IID_KEY]: iid });
  return iid;
}

export const getInstanceId: () => Promise<string> = singleFlight(
  readOrCreateInstanceId
).get;
