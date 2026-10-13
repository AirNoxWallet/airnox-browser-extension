// The pairing page's DOM wiring (browser-only — the view logic lives in
// pairing_view.ts, the flow in transport/pairing_flow.ts). An extension page
// in its own small window, never inside a web page: the desktop app tells the
// person to type its code only here.
//
// The page holds the attempt itself (the flow and its keys live as long as this
// window), and sends its two frames through the service worker, which owns the
// desktop socket. The derived key goes straight into IndexedDB as a
// non-extractable CryptoKey; the typed code is cleared from the field once the
// attempt is spent.

import browser from 'webextension-polyfill';
import {
  PAIRED_MESSAGE,
  PAIR_RELAY_MESSAGE,
  parsePairRelayReply,
} from '../protocol/bridge';
import { saveAuthKey } from '../transport/auth_key_store';
import { PairingFlow } from '../transport/pairing_flow';
import { PairingStep, derivePairingView, readOriginHint } from './pairing_view';
import { THEME_KEY, isThemeChoice, resolveTheme } from './popup_view';

const el = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const flow = new PairingFlow({
  relay: async (method, params) =>
    parsePairRelayReply(
      await browser.runtime.sendMessage({
        type: PAIR_RELAY_MESSAGE,
        method,
        params,
      })
    ),
  saveKey: saveAuthKey,
});

const origin = readOriginHint(window.location.search);

function render(step: PairingStep): void {
  const view = derivePairingView(step);
  el('pairStatus').setAttribute(
    'data-state',
    view.tone === 'ok'
      ? 'unlocked'
      : view.tone === 'warn'
      ? 'locked'
      : view.tone
  );
  el('pairTitle').textContent = view.title;
  el('pairDetail').textContent = view.detail;

  const form = el<HTMLFormElement>('pairForm');
  const code = el<HTMLInputElement>('pairCode');
  form.hidden = !view.codeEntry;
  code.disabled = view.busy;
  el<HTMLButtonElement>('pairSubmit').disabled = view.busy;
  if (!view.codeEntry) {
    code.value = ''; // the attempt is spent: the code goes with it
  }
  const start = el<HTMLButtonElement>('pairStart');
  start.hidden = !view.start;
  start.disabled = view.busy;
  const again = el<HTMLButtonElement>('pairAgain');
  again.hidden = !view.tryAgain;
  again.disabled = view.busy;
  if (view.codeEntry && !view.busy) {
    code.focus();
  }
}

async function begin(): Promise<void> {
  render({ kind: 'starting' });
  render(await flow.begin(origin));
}

async function submit(): Promise<void> {
  render({ kind: 'checking' });
  const outcome = await flow.submit(el<HTMLInputElement>('pairCode').value);
  if (outcome.kind === 'paired') {
    // The key is stored: the worker's socket authenticates with it now.
    await browser.runtime
      .sendMessage({ type: PAIRED_MESSAGE })
      .catch(() => undefined);
  }
  render(outcome);
}

async function applyTheme(): Promise<void> {
  const got = await browser.storage.local.get(THEME_KEY);
  const v = got[THEME_KEY];
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute(
    'data-theme',
    resolveTheme(isThemeChoice(v) ? v : 'auto', prefersDark)
  );
}

function main(): void {
  void applyTheme();
  el('pairForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    void submit();
  });
  el('pairStart').addEventListener('click', () => void begin());
  el('pairAgain').addEventListener('click', () => void begin());
  el('pairClose').addEventListener('click', () => window.close());
  // Nothing goes to the desktop until the person presses Pair.
  render({ kind: 'ready', origin });
}

main();
