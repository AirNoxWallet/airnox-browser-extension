import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveFirstReachablePort } from '../src/transport/ws_client';
import {
  WEB3_AUTO_PORTS,
  WEB3_PROTOCOL_VERSION,
  checkVersion,
  formatVersion,
  isAirNoxSysPingResult,
  isVersionCompatible,
  isVersionOlder,
  parseProtocolVersion,
  readDesktopSession,
  readDesktopVersion,
} from '../src/protocol/envelope';

// ── resolveFirstReachablePort — the Auto-mode scan order ─────────────────────

test('returns the first port whose probe succeeds, in order', async () => {
  const probed: number[] = [];
  const found = await resolveFirstReachablePort([8114, 8274, 18114], (p) => {
    probed.push(p);
    return Promise.resolve(p === 8274);
  });
  assert.equal(found, 8274);
  // Scans in order and STOPS at the first hit (never probes 18114).
  assert.deepEqual(probed, [8114, 8274]);
});

test('returns null when no port probes true', async () => {
  const found = await resolveFirstReachablePort([8114, 8274], () =>
    Promise.resolve(false)
  );
  assert.equal(found, null);
});

test('empty candidate list resolves to null', async () => {
  const found = await resolveFirstReachablePort([], () =>
    Promise.resolve(true)
  );
  assert.equal(found, null);
});

// ── readDesktopSession — which desktop session answered ──────────────────────

test('reads the 32-hex desktop session a sys_ping result names', () => {
  const session = '0123456789abcdef'.repeat(2);
  assert.equal(
    readDesktopSession({ wallet_status: 'unlocked', desktop_session: session }),
    session
  );
});

test('an absent or malformed desktop session reads as unknown', () => {
  // Unknown makes the SW forget nothing — an older desktop names no session, and
  // a garbled one must not pass for a restart.
  assert.equal(readDesktopSession({ wallet_status: 'unlocked' }), undefined);
  assert.equal(
    readDesktopSession({ desktop_session: 'A'.repeat(32) }),
    undefined
  ); // upper case
  assert.equal(
    readDesktopSession({ desktop_session: 'a'.repeat(31) }),
    undefined
  );
  assert.equal(
    readDesktopSession({ desktop_session: 'a'.repeat(33) }),
    undefined
  );
  assert.equal(
    readDesktopSession({ desktop_session: 'g'.repeat(32) }),
    undefined
  );
  assert.equal(readDesktopSession({ desktop_session: 42 }), undefined);
  assert.equal(readDesktopSession(null), undefined);
  assert.equal(readDesktopSession('a'.repeat(32)), undefined);
});

// ── isAirNoxSysPingResult / readDesktopVersion — the server-identity check ────

test('accepts a sys_ping result carrying a version object (any version)', () => {
  assert.equal(
    isAirNoxSysPingResult({
      wallet_status: 'unlocked',
      protocol_version: { wallet: 2, major: 1, minor: 0 },
    }),
    true
  );
  // A version-incompatible AirNox server is still recognised as AirNox.
  assert.equal(
    isAirNoxSysPingResult({
      protocol_version: { wallet: 2, major: 9, minor: 5 },
    }),
    true
  );
});

test('rejects a legacy-int / missing / malformed protocol_version', () => {
  assert.equal(isAirNoxSysPingResult({ protocol_version: 2 }), false); // legacy int
  assert.equal(isAirNoxSysPingResult({ wallet_status: 'unlocked' }), false);
  assert.equal(
    isAirNoxSysPingResult({ protocol_version: { wallet: 2, major: 1 } }),
    false // missing minor
  );
});

test('rejects non-object results', () => {
  assert.equal(isAirNoxSysPingResult(null), false);
  assert.equal(isAirNoxSysPingResult(undefined), false);
  assert.equal(isAirNoxSysPingResult('ok'), false);
  assert.equal(isAirNoxSysPingResult(2), false);
});

test('readDesktopVersion extracts the version object or null', () => {
  assert.deepEqual(
    readDesktopVersion({ protocol_version: { wallet: 2, major: 1, minor: 0 } }),
    { wallet: 2, major: 1, minor: 0 }
  );
  assert.equal(readDesktopVersion({ protocol_version: 2 }), null);
  assert.equal(readDesktopVersion({}), null);
  assert.equal(readDesktopVersion(null), null);
});

// ── version compatibility (mirror of the desktop's ProtocolVersion logic) ────

test('isVersionCompatible: same wallet+major, minor never gates', () => {
  // Derive the peer from our own version so the invariants hold across a bump.
  const base = WEB3_PROTOCOL_VERSION;
  // Same wallet line + same major → compatible, regardless of minor.
  assert.equal(isVersionCompatible(base, { ...base, minor: 0 }), true);
  assert.equal(isVersionCompatible(base, { ...base, minor: 255 }), true);
  // A different major is incompatible.
  assert.equal(
    isVersionCompatible(base, { ...base, major: base.major + 1 }),
    false
  );
  // A different wallet line is incompatible.
  assert.equal(
    isVersionCompatible(base, { ...base, wallet: base.wallet + 1 }),
    false
  );
});

test('WEB3_PROTOCOL_VERSION is major 3 (2.3.1), mirroring the desktop', () => {
  // Major 3: every socket authenticates with the key a pairing by code left
  // before anything else is served. Major 2 was the mhda 1.1 chain-key grammar.
  // The desktop's protocol version must mirror this; the two ship in lockstep,
  // or a stale peer is refused with the wrong update side.
  // Minor value 1 (bit 0): held sessions (sys_resume), an optional capability.
  assert.deepEqual(WEB3_PROTOCOL_VERSION, { wallet: 2, major: 3, minor: 1 });
  assert.equal(formatVersion(WEB3_PROTOCOL_VERSION), '2.3.1');
});

test('isVersionOlder orders by (wallet, major), minor ignored', () => {
  assert.equal(
    isVersionOlder(
      { wallet: 2, major: 1, minor: 0 },
      { wallet: 2, major: 2, minor: 0 }
    ),
    true
  );
  assert.equal(
    isVersionOlder(
      { wallet: 2, major: 1, minor: 0 },
      { wallet: 3, major: 0, minor: 0 }
    ),
    true
  );
  assert.equal(
    isVersionOlder(
      { wallet: 2, major: 2, minor: 0 },
      { wallet: 2, major: 1, minor: 0 }
    ),
    false
  );
  assert.equal(
    isVersionOlder(
      { wallet: 2, major: 1, minor: 9 },
      { wallet: 2, major: 1, minor: 0 }
    ),
    false
  );
});

test('formatVersion / parseProtocolVersion round-trip', () => {
  assert.equal(formatVersion({ wallet: 2, major: 1, minor: 0 }), '2.1.0');
  assert.deepEqual(parseProtocolVersion({ wallet: 2, major: 1, minor: 5 }), {
    wallet: 2,
    major: 1,
    minor: 5,
  });
  assert.equal(parseProtocolVersion({ wallet: 2, major: 1 }), null);
  assert.equal(parseProtocolVersion({ wallet: 2, major: 1, minor: -1 }), null);
  assert.equal(parseProtocolVersion(2), null);
});

test('checkVersion: compatible, and the update-side direction on a mismatch', () => {
  const base = WEB3_PROTOCOL_VERSION;
  // Same major as ours → compatible (minor never gates).
  assert.deepEqual(checkVersion({ ...base, minor: 0 }), {
    compatible: true,
    desktop: { ...base, minor: 0 },
  });
  // Desktop newer major → the extension is behind → update the extension.
  const older = checkVersion({ ...base, major: base.major + 1 });
  assert.equal(older.compatible, false);
  if (!older.compatible) {
    assert.equal(older.updateSide, 'extension');
  }
  // Desktop older major → the extension is ahead → update the desktop.
  const newer = checkVersion({ ...base, major: base.major - 1 });
  assert.equal(newer.compatible, false);
  if (!newer.compatible) {
    assert.equal(newer.updateSide, 'desktop');
  }
});

// ── WEB3_AUTO_PORTS — the mirror invariant ───────────────────────────────────

test('predefined Auto ports are non-empty, 8114-first, all unprivileged', () => {
  assert.ok(WEB3_AUTO_PORTS.length > 0);
  assert.equal(WEB3_AUTO_PORTS[0], 8114); // drop-in compatible primary
  for (const p of WEB3_AUTO_PORTS) {
    assert.ok(p > 1024 && p <= 65535);
  }
});
