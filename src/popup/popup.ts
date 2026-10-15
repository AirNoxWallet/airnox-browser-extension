// The toolbar popup's DOM wiring (browser-only — the testable view logic lives in
// popup_view.ts, the same split as PostMessageTransport vs transport.ts). It asks
// the service worker for the current connection state, renders the three-state
// status bar + the instance/port rows, and wires Retry, the theme toggle, and the
// iid copy. It also asks the active tab who holds the page's provider globals and
// says so when another web3 wallet does. It shows NO wallet/account/asset/price
// data — that is desktop-only.

import browser from 'webextension-polyfill';
import { DEFAULT_WS_PORT } from '../protocol/envelope';
import { loadAuthKey } from '../transport/auth_key_store';
import {
  getTransportSettings,
  setTransportSettings,
  TransportSettings,
} from '../transport/settings';
import {
  PAGE_HOLDERS_MESSAGE,
  PAIRING_PAGE,
  PAIRING_WINDOW,
  PageHoldersReply,
  SETTINGS_CHANGED_MESSAGE,
  StatusReply,
  STATUS_MESSAGE,
} from '../protocol/bridge';
import {
  deriveHolderBanner,
  deriveStatusView,
  deriveVersionBanner,
  isThemeChoice,
  nextTheme,
  pairingRow,
  parseManualPort,
  resolveTheme,
  ThemeChoice,
  THEME_KEY,
  themeToggleLabel,
  truncateIid,
} from './popup_view';

const el = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

// ── theme ────────────────────────────────────────────────────────────────────
function applyTheme(choice: ThemeChoice): void {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute(
    'data-theme',
    resolveTheme(choice, prefersDark)
  );
  const { glyph, label } = themeToggleLabel(choice);
  const toggle = el('themeToggle');
  toggle.textContent = glyph;
  toggle.setAttribute('aria-label', label);
  toggle.setAttribute('title', label);
}

async function loadThemeChoice(): Promise<ThemeChoice> {
  const got = await browser.storage.local.get(THEME_KEY);
  const v = got[THEME_KEY];
  return isThemeChoice(v) ? v : 'auto';
}

// ── render ───────────────────────────────────────────────────────────────────
function render(reply: StatusReply): void {
  const view = deriveStatusView(reply);
  const status = el('status');
  status.classList.remove('checking');
  status.setAttribute('data-state', view.state);
  el('statusLabel').textContent = view.label;
  el('statusSub').textContent = view.sublabel;

  const retry = el<HTMLButtonElement>('retry');
  retry.hidden = !view.showRetry;
  retry.disabled = false;

  const iid = el('iid');
  iid.textContent = reply.iid ? truncateIid(reply.iid) : '—';
  iid.setAttribute('title', reply.iid);
  el('port').textContent = reply.port ? String(reply.port) : '—';
  el('portWarn').hidden = !view.portWarn;
  void showPairing(reply.iid);

  // Protocol-version incompatibility banner (which side to update).
  const banner = deriveVersionBanner(reply);
  el('versionBanner').hidden = banner === null;
  if (banner) {
    el('versionBannerLabel').textContent = banner.label;
    el('versionBannerDetail').textContent = banner.detail;
  }
}

// Ask the active tab's top frame who holds its provider globals. A tab with no
// content script of ours (a browser page, a store page, a tab loaded before the
// extension was) rejects the message, and then there is nothing to say about it.
async function readPageHolders(): Promise<PageHoldersReply | undefined> {
  try {
    const [tab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id === undefined) {
      return undefined;
    }
    const reply: unknown = await browser.tabs.sendMessage(
      tab.id,
      { type: PAGE_HOLDERS_MESSAGE },
      { frameId: 0 }
    );
    return typeof reply === 'object' && reply !== null ? reply : undefined;
  } catch {
    return undefined;
  }
}

async function showPageHolders(): Promise<void> {
  const banner = deriveHolderBanner(await readPageHolders());
  el('holderBanner').hidden = banner === null;
  if (banner) {
    el('holderBannerLabel').textContent = banner.label;
    el('holderBannerDetail').textContent = banner.detail;
  }
}

// Whether this instance holds a pairing key: read from the extension's own
// IndexedDB (auth_key_store.ts), never from the desktop.
async function showPairing(iid: string): Promise<void> {
  let paired: boolean | undefined;
  if (iid) {
    const key = await loadAuthKey(iid).catch(() => null);
    paired = key === null ? undefined : key !== undefined;
  }
  const row = pairingRow(paired);
  el('pairState').textContent = row.value;
  el('pairState').title = row.detail;
  el('pairOpen').textContent = row.action;
}

// The pairing page opens in its own small window, never in a tab beside the
// dApps: the desktop app tells the person to type its code only there.

function openPairing(): void {
  void browser.windows
    .create({ url: browser.runtime.getURL(PAIRING_PAGE), ...PAIRING_WINDOW })
    .then(() => window.close())
    .catch(() => undefined);
}

function showChecking(): void {
  el('status').classList.add('checking');
  el('statusLabel').textContent = 'Checking…';
  el<HTMLButtonElement>('retry').disabled = true;
}

let inFlight = false;
async function refresh(): Promise<void> {
  if (inFlight) {
    return; // never two pings at once
  }
  inFlight = true;
  showChecking();
  try {
    const reply: StatusReply = await browser.runtime.sendMessage({
      type: STATUS_MESSAGE,
    });
    render(reply);
  } catch {
    // The service worker didn't answer — present it as offline.
    render({ connected: false, iid: '', port: 0 });
  } finally {
    inFlight = false;
  }
}

// ── boot ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  let choice = await loadThemeChoice();
  applyTheme(choice);

  el('themeToggle').addEventListener('click', () => {
    choice = nextTheme(choice);
    void browser.storage.local.set({ [THEME_KEY]: choice });
    applyTheme(choice);
  });

  el('retry').addEventListener('click', () => void refresh());
  el('pairOpen').addEventListener('click', openPairing);

  el('copyIid').addEventListener('click', () => {
    const full = el('iid').getAttribute('title') ?? '';
    if (!full) {
      return;
    }
    // The click is a user gesture, so writeText needs no clipboardWrite
    // permission; if a browser still blocks it, fail quietly — the full iid stays
    // visible in the row's title tooltip.
    void navigator.clipboard
      .writeText(full)
      .then(() => {
        const btn = el('copyIid');
        btn.classList.add('copied');
        btn.textContent = 'Copied';
        window.setTimeout(() => {
          btn.classList.remove('copied');
          btn.textContent = 'Copy';
        }, 1200);
      })
      .catch(() => undefined);
  });

  settings = await getTransportSettings();
  applyTransportUi();

  el('modeBtn').addEventListener('click', () => {
    settings = {
      ...settings,
      mode: settings.mode === 'auto' ? 'manual' : 'auto',
    };
    applyTransportUi();
    setHint(
      settings.mode === 'manual'
        ? 'Set the desktop’s manual port, then Save.'
        : 'Auto: the extension finds the desktop on a preset loopback port.'
    );
    void persistSettings();
  });

  el('savePort').addEventListener('click', () => {
    const port = parseManualPort(el<HTMLInputElement>('manualPort').value);
    if (port === null) {
      setHint('Enter an unprivileged port (1025–65535).');
      return;
    }
    settings = { mode: 'manual', manualPort: port };
    applyTransportUi();
    setHint(`Manual port set to ${port}.`);
    void persistSettings();
  });

  // Independent of the desktop: the notice is about the page, so it does not
  // wait for the status round-trip.
  void showPageHolders();
  await refresh();
}

// ── transport settings ───────────────────────────────────────────────────────
let settings: TransportSettings = { mode: 'auto', manualPort: DEFAULT_WS_PORT };

function applyTransportUi(): void {
  const modeBtn = el('modeBtn');
  const label = settings.mode === 'manual' ? 'Manual' : 'Auto';
  modeBtn.textContent = label;
  modeBtn.setAttribute(
    'aria-label',
    `Transport mode: ${label}. Click to switch.`
  );
  el('manualPortRow').hidden = settings.mode !== 'manual';
  el<HTMLInputElement>('manualPort').value = String(settings.manualPort);
}

function setHint(text: string): void {
  el('settingsHint').textContent = text;
}

// Persist the current settings, tell the SW to rebuild its client from them, then
// re-check the connection so the badge + rows reflect the new endpoint.
async function persistSettings(): Promise<void> {
  await setTransportSettings(settings);
  await browser.runtime.sendMessage({ type: SETTINGS_CHANGED_MESSAGE });
  await refresh();
}

void main();
