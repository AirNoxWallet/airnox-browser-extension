// Pure view logic for the toolbar popup — the testable core, kept free of any DOM
// / browser API so it can be unit-tested without a browser (the DOM wiring lives
// in popup.ts, the same split as transport.ts vs PostMessageTransport).
//
// The popup is a CONNECTION-STATE surface only: it shows whether the desktop is
// reachable + unlocked, never any wallet/account/asset/price data (that is
// desktop-only). It derives exactly three states from the heartbeat's reply.

import { WEB3_PROTOCOL_VERSION, formatVersion } from '../protocol/envelope';
import { PageHoldersReply, StatusReply } from '../protocol/bridge';

// An update prompt shown when the extension and desktop are protocol-incompatible
// by major version. `null` when compatible / unknown — nothing to show.
export interface VersionBanner {
  label: string; // the call to action ("Update the extension" / "…desktop app")
  detail: string; // the two versions, for context
}

export function deriveVersionBanner(reply: StatusReply): VersionBanner | null {
  const v = reply.version;
  if (!v || v.compatible) {
    return null;
  }
  const detail = `Desktop speaks ${formatVersion(
    v.desktop
  )}; this extension speaks ${formatVersion(WEB3_PROTOCOL_VERSION)}.`;
  return {
    label:
      v.updateSide === 'extension'
        ? 'Update the extension'
        : 'Update the desktop app',
    detail,
  };
}

// A notice that another web3 wallet holds a provider global on the active tab,
// so the dApps there that look for a wallet the legacy way reach that wallet and
// not AirNox. `null` when AirNox holds every global it installs, when nothing
// holds one, or when the tab gave no answer (no content script there, or the
// page did not answer in time).
export interface HolderBanner {
  label: string;
  detail: string;
}

export function deriveHolderBanner(
  reply: PageHoldersReply | undefined
): HolderBanner | null {
  const h = reply?.holders;
  if (!h) {
    return null;
  }
  const evm = h.ethereum === 'other';
  const taken = [
    evm ? 'Ethereum' : undefined,
    h.tronWeb === 'other' || h.tronLink === 'other' || h.tron === 'other'
      ? 'TRON'
      : undefined,
    h.airnox === 'other' ? 'TON' : undefined,
  ].filter((name): name is string => name !== undefined);
  if (taken.length === 0) {
    return null;
  }
  const names =
    taken.length === 1
      ? taken[0]
      : `${taken.slice(0, -1).join(', ')} and ${taken[taken.length - 1]}`;
  // EIP-6963 lets a dApp list every installed wallet, AirNox included, whoever
  // holds window.ethereum. TRON and TON have no such list that we serve.
  const listHint = evm
    ? ' A dApp that offers a list of wallets can still connect to AirNox.'
    : '';
  return {
    label: 'Another web3 wallet controls this page',
    detail: `${names} dApps on this tab reach that wallet, not AirNox.${listHint}`,
  };
}

// Validate a Manual-mode port string from the input → the integer, or null if it
// is not an unprivileged TCP port (the desktop binds 127.0.0.1 only and would
// reject a sub-1024 port that needs elevation). Trims whitespace; rejects
// empty / non-numeric.
export function parseManualPort(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 1024 && n <= 65535 ? n : null;
}

export type ConnState = 'unlocked' | 'locked' | 'offline';

// The rendered view model for a state — what the status bar + rows show.
export interface StatusView {
  state: ConnState;
  label: string; // primary status label
  sublabel: string; // one-line context / guidance
  showRetry: boolean; // a Retry (re-ping) action is offered
  portWarn: boolean; // flag the port row (a wrong port is a common offline cause)
}

// Map a heartbeat reply → the three-state view. connected===false is offline
// regardless of `status`; a connected reply with no wallet_status is treated as
// locked (conservative — never claim "ready to sign" without confirmation).
export function deriveStatusView(reply: StatusReply): StatusView {
  if (!reply.connected) {
    return {
      state: 'offline',
      label: 'Desktop not connected',
      sublabel: 'Open the AirNox Wallet desktop app, then retry.',
      showRetry: true,
      portWarn: true,
    };
  }
  if (reply.status === 'unlocked') {
    return {
      state: 'unlocked',
      label: 'Ready to sign',
      sublabel: 'AirNox Wallet desktop is connected and unlocked.',
      showRetry: false,
      portWarn: false,
    };
  }
  return {
    state: 'locked',
    label: 'Wallet locked',
    sublabel: 'Unlock AirNox Wallet on your desktop to approve requests.',
    showRetry: true,
    portWarn: false,
  };
}

// Truncate the 36-char UUID iid to "8f3a…c1d2" (first 4 / last 4) for display.
// The full value is what the copy action yields. A non-UUID-length string is
// returned as-is (defensive).
export function truncateIid(iid: string): string {
  if (iid.length <= 9) {
    return iid;
  }
  return `${iid.slice(0, 4)}…${iid.slice(-4)}`;
}

// ── theme resolution ─────────────────────────────────────────────────────────
// The user's persisted choice; 'auto' follows the OS (prefers-color-scheme).
export type ThemeChoice = 'auto' | 'light' | 'dark';
export const THEME_KEY = 'theme' as const;

export function isThemeChoice(v: unknown): v is ThemeChoice {
  return v === 'auto' || v === 'light' || v === 'dark';
}

// Resolve the active theme to apply (data-theme on <html>).
export function resolveTheme(
  choice: ThemeChoice,
  prefersDark: boolean
): 'light' | 'dark' {
  if (choice === 'auto') {
    return prefersDark ? 'dark' : 'light';
  }
  return choice;
}

// The toggle cycles auto → light → dark → auto.
export function nextTheme(choice: ThemeChoice): ThemeChoice {
  switch (choice) {
    case 'auto':
      return 'light';
    case 'light':
      return 'dark';
    case 'dark':
      return 'auto';
  }
}

// The toggle's glyph + accessible label for the CURRENT choice (what is active,
// not what clicking does).
export function themeToggleLabel(choice: ThemeChoice): {
  glyph: string;
  label: string;
} {
  switch (choice) {
    case 'auto':
      return { glyph: '◐', label: 'Theme: following system' };
    case 'light':
      return { glyph: '☀', label: 'Theme: light' };
    case 'dark':
      return { glyph: '☾', label: 'Theme: dark' };
  }
}

// The popup's Pairing row: whether this instance holds a pairing key, and the
// action that opens the pairing page. `paired` is undefined while unknown;
// `distrusted`: the key failed a desktop's proof and is no longer offered, so
// the person is told what to do rather than shown "Paired".
export function pairingRow(
  paired: boolean | undefined,
  distrusted = false
): {
  value: string;
  action: string;
  detail: string;
} {
  if (paired === undefined) {
    return { value: '—', action: 'Pair', detail: '' };
  }
  if (!paired) {
    return { value: 'Not paired', action: 'Pair', detail: '' };
  }
  return distrusted
    ? {
        value: 'Key withheld',
        action: 'Pair again',
        detail:
          "A program on the desktop app's port could not prove it is AirNox Wallet, so this browser's pairing key is no longer offered. Reset this browser's pairing key in AirNox Wallet's Settings, then pair again.",
      }
    : { value: 'Paired', action: 'Pair again', detail: '' };
}
