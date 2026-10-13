// The toolbar badge — the browser half of the per-tab wallet indicator. The
// colour/text policy is in badge_state.ts; which tabs get one is in
// web3_tabs.ts.
//
// The badge is PER TAB and appears only on tabs whose page reached for web3, so
// that on an ordinary browsing tab the wallet looks inactive.
//
// THE BADGE IS ALSO THE REGISTRY'S DURABLE HALF — read this before changing
// anything here. A per-tab badge lives in the browser until the tab navigates or
// closes, which outlives the service worker many times over; the worker's own
// Set of web3 tabs does not survive a single eviction. Because a web3 tab always
// carries a non-empty badge (grey when the desktop is down — badge_state.ts) and
// no other tab ever gets one, `getBadgeText({tabId})` answers "did this tab ask
// for web3?" for a worker that has just restarted, with no storage key and no
// migration path to own. That holds only while the DEFAULT (tab-less) badge
// stays empty, because getBadgeText falls back to it for a tab with no override
// — hence clearDefault(), and hence nothing here ever sets a badge without a
// tabId.

import browser from 'webextension-polyfill';
import { BadgeFace, IDLE_TITLE } from './badge_state';

// A tab can close (or navigate) between the moment we decide to paint it and the
// moment the call lands, and the action API rejects for a tab that is gone.
// Painting is cosmetic and the tab it concerned no longer exists, so the failure
// is genuinely nothing — but it is swallowed HERE, narrowly, and never around a
// call whose result someone depends on.
async function ignoreGoneTab<T>(op: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await op();
  } catch {
    return fallback;
  }
}

// Show wallet state on a tab that wants web3.
export async function paintTab(tabId: number, face: BadgeFace): Promise<void> {
  await ignoreGoneTab(async () => {
    await browser.action.setBadgeBackgroundColor({ tabId, color: face.color });
    await browser.action.setBadgeText({ tabId, text: face.text });
    await browser.action.setTitle({ tabId, title: face.title });
  }, undefined);
}

// Make the wallet look inactive on this tab (a fresh document, or one that never
// asked for web3). Also un-marks the tab for a future worker, since the badge is
// what a restarted one reads back.
export async function clearTab(tabId: number): Promise<void> {
  await ignoreGoneTab(async () => {
    await browser.action.setBadgeText({ tabId, text: '' });
    await browser.action.setTitle({ tabId, title: IDLE_TITLE });
  }, undefined);
}

// Blank the DEFAULT badge — the one a tab without an override inherits. Called
// once per worker before reading any tab back, so a stale default (an older
// build set one globally) cannot make every open tab look like a web3 tab.
export async function clearDefault(): Promise<void> {
  await browser.action.setBadgeText({ text: '' });
}

// The tabs a previous worker marked, read back off their badges. Requires no
// "tabs" permission: only tab IDs are used, never a URL or a title.
export async function markedTabs(): Promise<number[]> {
  const tabs = await browser.tabs.query({});
  const ids = tabs
    .map((tab) => tab.id)
    .filter((id): id is number => id !== undefined);
  const marks = await Promise.all(
    ids.map((id) =>
      ignoreGoneTab(() => browser.action.getBadgeText({ tabId: id }), '')
    )
  );
  return ids.filter((_, i) => marks[i] !== '');
}
