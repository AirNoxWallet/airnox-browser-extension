import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveHolderBanner,
  deriveStatusView,
  deriveVersionBanner,
  isThemeChoice,
  nextTheme,
  parseManualPort,
  resolveTheme,
  themeToggleLabel,
  truncateIid,
} from '../src/popup/popup_view';
import { WEB3_PROTOCOL_VERSION, formatVersion } from '../src/protocol/envelope';

test('deriveStatusView maps the three connection states', () => {
  // offline — connected:false dominates regardless of status.
  const off = deriveStatusView({ connected: false, iid: 'x', port: 8114 });
  assert.equal(off.state, 'offline');
  assert.equal(off.showRetry, true);
  assert.equal(off.portWarn, true); // a wrong port is a common offline cause

  // unlocked — ready to sign, no action offered.
  const up = deriveStatusView({
    connected: true,
    status: 'unlocked',
    iid: 'x',
    port: 8114,
  });
  assert.equal(up.state, 'unlocked');
  assert.equal(up.showRetry, false);
  assert.equal(up.portWarn, false);
  assert.match(up.label, /ready/i);

  // locked — connected but locked, Retry offered.
  const lk = deriveStatusView({
    connected: true,
    status: 'locked',
    iid: 'x',
    port: 8114,
  });
  assert.equal(lk.state, 'locked');
  assert.equal(lk.showRetry, true);
  assert.equal(lk.portWarn, false);
});

test('deriveStatusView treats connected-but-unknown-status as locked (conservative)', () => {
  const v = deriveStatusView({ connected: true, iid: 'x', port: 8114 });
  assert.equal(v.state, 'locked'); // never claim "ready to sign" without confirmation
});

test('truncateIid shows first 4 / last 4 of a UUID, leaves short strings as-is', () => {
  assert.equal(
    truncateIid('8f3a1b2c-0000-0000-0000-0000000ac1d2'),
    '8f3a…c1d2'
  );
  assert.equal(truncateIid(''), '');
  assert.equal(truncateIid('short'), 'short'); // <= 9 chars → verbatim
});

test('resolveTheme: auto follows the OS, explicit choices win', () => {
  assert.equal(resolveTheme('auto', true), 'dark');
  assert.equal(resolveTheme('auto', false), 'light');
  assert.equal(resolveTheme('light', true), 'light'); // manual light beats a dark OS
  assert.equal(resolveTheme('dark', false), 'dark'); // manual dark beats a light OS
});

test('nextTheme cycles auto → light → dark → auto', () => {
  assert.equal(nextTheme('auto'), 'light');
  assert.equal(nextTheme('light'), 'dark');
  assert.equal(nextTheme('dark'), 'auto');
});

test('isThemeChoice validates the persisted value', () => {
  assert.equal(isThemeChoice('auto'), true);
  assert.equal(isThemeChoice('light'), true);
  assert.equal(isThemeChoice('dark'), true);
  assert.equal(isThemeChoice('neon'), false);
  assert.equal(isThemeChoice(undefined), false);
  assert.equal(isThemeChoice(42), false);
});

test('themeToggleLabel describes the CURRENT choice', () => {
  assert.match(themeToggleLabel('auto').label, /system/i);
  assert.match(themeToggleLabel('light').label, /light/i);
  assert.match(themeToggleLabel('dark').label, /dark/i);
  // each has a non-empty glyph
  for (const c of ['auto', 'light', 'dark'] as const) {
    assert.ok(themeToggleLabel(c).glyph.length > 0);
  }
});

test('parseManualPort accepts unprivileged ports, trims, rejects the rest', () => {
  assert.equal(parseManualPort('8114'), 8114);
  assert.equal(parseManualPort('  9000  '), 9000); // trimmed
  assert.equal(parseManualPort('65535'), 65535);
  assert.equal(parseManualPort('1025'), 1025);
  // Privileged / out-of-range / non-numeric / empty → null.
  assert.equal(parseManualPort('1024'), null);
  assert.equal(parseManualPort('80'), null);
  assert.equal(parseManualPort('65536'), null);
  assert.equal(parseManualPort('0'), null);
  assert.equal(parseManualPort(''), null);
  assert.equal(parseManualPort('80a'), null);
  assert.equal(parseManualPort('8.1'), null);
  assert.equal(parseManualPort('-8114'), null);
});

test('deriveVersionBanner: null when compatible/unknown, prompt per side', () => {
  const base = { connected: true, iid: 'x', port: 8114 };
  // Peer versions are derived from our own so the banner logic holds across a
  // protocol bump: a newer/older desktop is one major above/below ours.
  const ours = WEB3_PROTOCOL_VERSION;
  const desktopNewer = { ...ours, major: ours.major + 1 };
  const desktopOlder = { ...ours, major: ours.major - 1 };
  // No verdict yet → nothing to show.
  assert.equal(deriveVersionBanner(base), null);
  // Compatible → nothing to show.
  assert.equal(
    deriveVersionBanner({
      ...base,
      version: { compatible: true, desktop: { ...ours, minor: 0 } },
    }),
    null
  );
  // Extension behind → "update the extension", with both versions in the detail.
  const ext = deriveVersionBanner({
    ...base,
    version: {
      compatible: false,
      updateSide: 'extension',
      desktop: desktopNewer,
    },
  });
  assert.ok(ext !== null);
  assert.match(ext.label, /update the extension/i);
  assert.ok(ext.detail.includes(formatVersion(desktopNewer)));
  assert.ok(ext.detail.includes(formatVersion(ours)));
  // Extension ahead → "update the desktop app".
  const desk = deriveVersionBanner({
    ...base,
    version: {
      compatible: false,
      updateSide: 'desktop',
      desktop: desktopOlder,
    },
  });
  assert.ok(desk !== null);
  assert.match(desk.label, /update the desktop/i);
});

const ALL_OURS = {
  ethereum: 'airnox',
  tronWeb: 'airnox',
  tronLink: 'airnox',
  tron: 'airnox',
  airnox: 'airnox',
} as const;

test('no holder notice without an answer, or when AirNox or nobody holds the globals', () => {
  assert.equal(deriveHolderBanner(undefined), null);
  assert.equal(deriveHolderBanner({}), null);
  assert.equal(deriveHolderBanner({ holders: ALL_OURS }), null);
  assert.equal(
    deriveHolderBanner({
      holders: { ...ALL_OURS, ethereum: 'none', tron: 'none' },
    }),
    null
  );
});

test('another wallet holding window.ethereum is named as an Ethereum takeover', () => {
  const b = deriveHolderBanner({ holders: { ...ALL_OURS, ethereum: 'other' } });
  assert.ok(b);
  assert.equal(b.label, 'Another web3 wallet controls this page');
  assert.equal(
    b.detail,
    'Ethereum dApps on this tab reach that wallet, not AirNox. A dApp that offers a list of wallets can still connect to AirNox.'
  );
});

test('any TRON global held by another wallet is one TRON takeover, with no list hint', () => {
  for (const key of ['tronWeb', 'tronLink', 'tron'] as const) {
    const b = deriveHolderBanner({ holders: { ...ALL_OURS, [key]: 'other' } });
    assert.ok(b, key);
    assert.equal(
      b.detail,
      'TRON dApps on this tab reach that wallet, not AirNox.',
      key
    );
  }
});

test('the holder notice names every ecosystem taken, in a fixed order', () => {
  const two = deriveHolderBanner({
    holders: {
      ...ALL_OURS,
      ethereum: 'other',
      tronWeb: 'other',
      tron: 'other',
    },
  });
  assert.equal(
    two?.detail,
    'Ethereum and TRON dApps on this tab reach that wallet, not AirNox. A dApp that offers a list of wallets can still connect to AirNox.'
  );
  const three = deriveHolderBanner({
    holders: {
      ...ALL_OURS,
      airnox: 'other',
      tronLink: 'other',
      ethereum: 'other',
    },
  });
  assert.equal(
    three?.detail,
    'Ethereum, TRON and TON dApps on this tab reach that wallet, not AirNox. A dApp that offers a list of wallets can still connect to AirNox.'
  );
  const ton = deriveHolderBanner({ holders: { ...ALL_OURS, airnox: 'other' } });
  assert.equal(
    ton?.detail,
    'TON dApps on this tab reach that wallet, not AirNox.'
  );
});
