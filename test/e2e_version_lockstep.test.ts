import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ProtocolVersion,
  WEB3_PROTOCOL_VERSION,
  isVersionCompatible,
} from '../src/protocol/envelope';

// The wire protocol version is duplicated SIX times across two repositories:
// this repo's SSOT
// (src/protocol/envelope.ts), the baseline guard in transport.test.ts, the two
// e2e files checked here, and the desktop wallet's protocol definitions plus
// their own baseline guard. The e2e pair is the one that drifted: the stub kept a stale
// version after an extension bump, so the harness went on passing while testing
// a pairing that no longer existed. A silently-wrong e2e is worse than no e2e,
// hence these guards.
//
// The e2e files are .mjs the harness runs directly, not modules this CJS test can
// import, so they are read as TEXT and their literals parsed out.

// Pull a `{ wallet: N, major: N, minor: N }` literal out of a source fragment.
// Returns null if any field is missing, so a reshaped literal fails loudly
// instead of comparing against a partial object.
function parseVersionLiteral(fragment: string): ProtocolVersion | null {
  const field = (name: string): number | null => {
    const m = new RegExp(`${name}\\s*:\\s*(\\d+)`).exec(fragment);
    return m === null ? null : Number(m[1]);
  };
  const wallet = field('wallet');
  const major = field('major');
  const minor = field('minor');
  if (wallet === null || major === null || minor === null) {
    return null;
  }
  return { wallet, major, minor };
}

test('the e2e desktop stub reports the current protocol version', () => {
  const src = readFileSync('e2e/desktop_stub.mjs', 'utf8');
  const m = /const DEFAULT_VERSION\s*=\s*\{([^}]*)\}/.exec(src);
  // A guard that cannot find its target must fail, never pass vacuously.
  assert.ok(m, 'DEFAULT_VERSION literal not found in e2e/desktop_stub.mjs');
  const version = parseVersionLiteral(m[1]);
  assert.ok(
    version,
    'DEFAULT_VERSION is not a { wallet, major, minor } literal'
  );
  assert.deepEqual(
    version,
    WEB3_PROTOCOL_VERSION,
    'e2e/desktop_stub.mjs DEFAULT_VERSION must mirror WEB3_PROTOCOL_VERSION'
  );
});

test('the e2e scenarios pin a current and a genuinely incompatible version', () => {
  const src = readFileSync('e2e/run_connect_e2e.mjs', 'utf8');
  const found = new Map<string, ProtocolVersion>();
  const re = /label:\s*'([^']+)',\s*stubVersion:\s*\{([^}]*)\}/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const version = parseVersionLiteral(m[2]);
    assert.ok(version, `scenario "${m[1]}" has no parseable stubVersion`);
    found.set(m[1], version);
  }

  // EVERY scenario's version is checked, not just the two named below. The
  // earlier guard looked up only those two, so the three flow scenarios added
  // later carried unguarded copies of the version literal: a major bump could
  // leave them stale with `npm test` still green, which is precisely the drift
  // this file exists to prevent. A scenario is legitimate only if it drives the
  // CURRENT version or is deliberately incompatible — there is no third case.
  for (const [label, version] of found) {
    const current = isVersionCompatible(WEB3_PROTOCOL_VERSION, version);
    const deliberatelyOld = label.includes('incompat');
    assert.equal(
      current,
      !deliberatelyOld,
      `scenario "${label}" drives ${JSON.stringify(
        version
      )}: a scenario must ` +
        'either pin the current version or be labelled incompatible'
    );
  }

  // Both named scenarios must survive — the incompatible one is the only thing
  // proving the 1103 fail-fast and the update-side prompt still work end to end.
  // This asserts they are PRESENT rather than that they are the only two, so
  // adding a scenario stays a one-file change.
  const compatible = found.get('compatible');
  const incompatible = found.get('incompatible');
  assert.ok(compatible, 'no scenario labelled "compatible" in the e2e harness');
  assert.ok(
    incompatible,
    'no scenario labelled "incompatible" in the e2e harness'
  );

  assert.deepEqual(
    compatible,
    WEB3_PROTOCOL_VERSION,
    'the compatible scenario must drive the stub at the current version'
  );
  assert.equal(
    isVersionCompatible(WEB3_PROTOCOL_VERSION, incompatible),
    false,
    'the incompatible scenario must stay incompatible with the current version'
  );
});
