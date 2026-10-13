// What the toolbar shows for a given desktop state. Pure, so the colour/text
// policy is unit-tested without the action API; badge.ts paints the result.
//
// Every face here is for a tab whose page reached for web3 — a tab that did not
// gets no face at all (badge.ts clearTab), because an idle browsing tab must
// make the wallet look inactive. That is why "offline" has a colour of its own
// instead of an empty badge: on a dApp tab, "the desktop is not running" is the
// one thing the user most needs to see, and it must not look like the blank of a
// tab the wallet is not involved with.
//
// A web3 tab therefore ALWAYS carries a non-empty badge, which is what lets
// badge.ts read the badge back as the answer to "did this tab ask for web3?"
// after a service-worker eviction (see the note there before changing a text).

import type { WalletStatus } from '../protocol/envelope';

const GREEN = '#16a34a';
const AMBER = '#d97706';
const RED = '#dc2626';
// Slate — reads as "off" against both a light and a dark toolbar.
const GREY = '#6b7280';

const DOT = '●';
const BANG = '!';

const NAME = 'AirNox';

export interface BadgeFace {
  readonly text: string; // never empty — see the note above
  readonly color: string;
  readonly title: string; // the toolbar tooltip, which says WHY
}

export function badgeFace(
  connected: boolean,
  status?: WalletStatus,
  incompatible = false
): BadgeFace {
  if (!connected) {
    return {
      text: DOT,
      color: GREY,
      title: `${NAME} — desktop app is not running`,
    };
  }
  // A protocol-incompatible desktop is reachable but unusable — flag it
  // distinctly so the green "ready" dot never misleads while an update is due.
  if (incompatible) {
    return { text: BANG, color: RED, title: `${NAME} — update required` };
  }
  return status === 'unlocked'
    ? { text: DOT, color: GREEN, title: `${NAME} — ready to sign` }
    : { text: DOT, color: AMBER, title: `${NAME} — wallet is locked` };
}

export function sameFace(a: BadgeFace, b: BadgeFace): boolean {
  return a.text === b.text && a.color === b.color && a.title === b.title;
}

// The tooltip a tab with no web3 activity carries: the manifest's default_title,
// restored explicitly because a per-tab title survives until it is overwritten.
export const IDLE_TITLE = NAME;
