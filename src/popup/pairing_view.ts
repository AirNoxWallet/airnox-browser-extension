// Pure view logic for the pairing page — the testable core of pairing.ts, kept
// free of any DOM / browser API. The page pairs this extension with the desktop
// app by the one-time code the desktop shows: once the person presses Pair, it
// asks the desktop for a code, takes what the person types and reports how it
// went. Nothing reaches the desktop before that press: a dApp that opened the
// page cannot make the desktop show a code. Every failure offers "Try again",
// which starts a new attempt (and a new code on the desktop).

import { PairingFailure, PairingOutcome } from '../transport/pairing_flow';

// Where the page stands: waiting for the person to press Pair (`origin`: the
// dApp whose connect opened the page), asking the desktop for a code, checking
// a typed code, or an outcome of the pairing flow.
export type PairingStep =
  | { kind: 'ready'; origin?: string }
  | { kind: 'starting' }
  | { kind: 'checking' }
  | PairingOutcome;

export interface PairingView {
  tone: 'info' | 'ok' | 'warn' | 'error';
  title: string;
  detail: string;
  start: boolean; // the Pair button that asks the desktop for a code is shown
  codeEntry: boolean; // the code field and its Pair button are shown
  busy: boolean; // a frame is in flight: the controls are disabled
  tryAgain: boolean; // a new attempt is offered
  close: boolean; // the page is done: Close is offered
}

const view = (
  v: Partial<PairingView> & Pick<PairingView, 'title' | 'detail'>
): PairingView => ({
  tone: 'error',
  start: false,
  codeEntry: false,
  busy: false,
  tryAgain: false,
  close: false,
  ...v,
});

// The desktop's message as a sentence: its first letter raised, a full stop
// added. Its words are shown as they are, never rewritten.
const sentence = (message: string | undefined): string => {
  const m = (message ?? '').trim();
  if (m === '') {
    return '';
  }
  const s = m[0].toUpperCase() + m.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
};

const FAILURES: Record<
  PairingFailure,
  { title: string; detail: string; tone?: PairingView['tone'] }
> = {
  unreachable: {
    title: 'Cannot reach AirNox Wallet',
    detail:
      'Start the desktop app and check the port in the extension’s popup, then try again.',
  },
  busy: {
    title: 'Another pairing is open in AirNox Wallet',
    detail: 'Finish or cancel it in the desktop app, then try again.',
    tone: 'warn',
  },
  cooldown: {
    title: 'AirNox Wallet just refused a pairing',
    detail: 'Wait a few seconds, then try again.',
    tone: 'warn',
  },
  locked: {
    title: 'AirNox Wallet is locked',
    detail: 'Unlock the desktop app, then try again. Nothing was paired.',
    tone: 'warn',
  },
  'unlock-skipped': {
    title: 'The unlock was skipped',
    detail:
      'The code shows once AirNox Wallet is unlocked. Try again to unlock it.',
    tone: 'warn',
  },
  unsupported: {
    title: 'This AirNox Wallet cannot pair by code',
    detail: 'Update the desktop app, then try again.',
  },
  incompatible: {
    title: 'AirNox Wallet and the extension do not match',
    detail: 'Update the side that is out of date, then try again.',
  },
  refused: {
    title: 'AirNox Wallet refused the code',
    detail: 'Try again for a new code.',
  },
  malformed: {
    title: 'AirNox Wallet refused the request',
    detail: 'Try again. If it keeps failing, update the extension.',
  },
  'desktop-error': {
    title: 'AirNox Wallet could not pair',
    detail: 'Try again.',
  },
  'bad-answer': {
    title: 'The answer was not AirNox Wallet’s',
    detail:
      'Nothing was paired. If the desktop app is running, another program may be listening on its port.',
  },
  interception: {
    title: 'The answer did not prove the code',
    detail:
      'Nothing was paired. Whatever answered took the code without knowing it: another program may be trying to pose as AirNox Wallet. Check the desktop app, then try again.',
  },
  'connection-changed': {
    title: 'The connection to AirNox Wallet changed',
    detail: 'Nothing was paired. Try again.',
  },
  'not-saved': {
    title: 'The pairing could not be kept',
    detail:
      'The browser refused to store the key. Try again to pair with a new code.',
  },
  'no-attempt': {
    title: 'No pairing is in progress',
    detail: 'Try again to ask AirNox Wallet for a code.',
  },
};

const BAD_CODE: Record<'character' | 'length' | 'check', string> = {
  character:
    'The code has only digits and letters. Check it against the desktop app.',
  length: 'The code has 16 characters. Check it against the desktop app.',
  check:
    'This is not the code shown: a character is wrong or two are swapped. Check it against the desktop app.',
};

const ENTER_TITLE = 'Type the code shown in AirNox Wallet';
const ENTER_DETAIL =
  'The desktop app shows a 16-character code. Type it only here, in this AirNox window.';

export function derivePairingView(step: PairingStep): PairingView {
  switch (step.kind) {
    case 'ready':
      return view({
        tone: 'info',
        title: 'Pair this browser with AirNox Wallet',
        detail:
          step.origin === undefined
            ? 'Press Pair, and the AirNox Wallet desktop app shows a code to type here.'
            : `${step.origin} asked to connect, and this browser is not paired with AirNox Wallet. Press Pair, and the desktop app shows a code to type here.`,
        start: true,
      });
    case 'starting':
      return view({
        tone: 'info',
        title: 'Asking AirNox Wallet for a code…',
        detail:
          'If the wallet is locked, unlock it first: the code shows once it is open.',
        busy: true,
      });
    case 'enter-code':
      return view({
        tone: 'info',
        title: ENTER_TITLE,
        detail: ENTER_DETAIL,
        codeEntry: true,
      });
    case 'checking':
      return view({
        tone: 'info',
        title: 'Checking the code…',
        detail: ENTER_DETAIL,
        codeEntry: true,
        busy: true,
      });
    case 'bad-code':
      return view({
        tone: 'warn',
        title: ENTER_TITLE,
        detail: BAD_CODE[step.reason],
        codeEntry: true,
      });
    case 'paired':
      return view({
        tone: 'ok',
        title: 'Paired with AirNox Wallet',
        detail: 'You can close this window.',
        close: true,
      });
    case 'failed': {
      const f = FAILURES[step.failure];
      const said = sentence(step.message);
      return view({
        tone: f.tone ?? 'error',
        title: f.title,
        detail: said === '' ? f.detail : `${said} ${f.detail}`,
        tryAgain: true,
      });
    }
  }
}

// The dApp whose connect opened the page, from the page's own query string: a
// label hint for the desktop's dialog. Taken only as a bare http(s) origin.
export function readOriginHint(search: string): string | undefined {
  const raw = new URLSearchParams(search).get('origin');
  if (!raw) {
    return undefined;
  }
  try {
    const url = new URL(raw);
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.origin === raw
      ? raw
      : undefined;
  } catch {
    return undefined;
  }
}
