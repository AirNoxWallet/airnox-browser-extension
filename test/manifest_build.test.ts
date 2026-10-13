import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BROWSER_TARGETS,
  BrowserTarget,
  chromiumManifest,
  firefoxManifest,
  manifestFamily,
  manifestFor,
} from '../manifest_build';

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

test('firefoxManifest strips the Chrome-only minimum_chrome_version', () => {
  const out = firefoxManifest(
    { manifest_version: 3, minimum_chrome_version: '116', name: 'x' },
    {}
  );
  assert.ok(!('minimum_chrome_version' in out));
  assert.equal(out.manifest_version, 3);
  assert.equal(out.name, 'x'); // base keys survive
});

test('firefoxManifest applies the Firefox background override wholesale', () => {
  // The overlay REPLACES the whole `background` object — the Firefox event-page
  // form must not retain the Chrome service_worker key.
  const out = firefoxManifest(
    { background: { service_worker: 'src/background/background.js' } },
    { background: { scripts: ['src/background/background.js'] } }
  );
  assert.deepEqual(out.background, {
    scripts: ['src/background/background.js'],
  });
});

test('the real Firefox manifest declares a background Firefox MV3 can run', () => {
  // Firefox MV3 does not run background.service_worker; it needs
  // background.scripts (a non-persistent event page). This guards against the
  // artifact regressing to a dead-on-arrival service_worker background.
  const out = firefoxManifest(
    readJson('manifest.json'),
    readJson('firefox.json')
  );
  const background = out.background as Record<string, unknown>;
  assert.ok(
    Array.isArray(background.scripts),
    'background.scripts must be set'
  );
  assert.ok(background.scripts.length > 0, 'background.scripts non-empty');
  assert.ok(
    !('service_worker' in background),
    'Firefox background must not carry service_worker'
  );
  // The gecko id survives the overlay (required by AMO).
  const bss = out.browser_specific_settings as { gecko?: { id?: string } };
  assert.equal(bss.gecko?.id, 'airnox@airnox.app');
  // The Chrome-only key is stripped.
  assert.ok(!('minimum_chrome_version' in out));
});

// ── per-target manifests built from the real sources ─────────────────────────

const INPAGE = 'src/inpage/inpage.js';
const WEB_SCHEMES = ['http://*/*', 'https://*/*'];

function built(target: BrowserTarget): Record<string, unknown> {
  return manifestFor(
    target,
    readJson('manifest.json'),
    readJson('firefox.json')
  );
}

type ContentScript = {
  matches?: string[];
  js?: string[];
  run_at?: string;
  world?: string;
  all_frames?: boolean;
};

function contentScripts(m: Record<string, unknown>): ContentScript[] {
  const cs = m.content_scripts;
  assert.ok(Array.isArray(cs), 'content_scripts must be an array');
  return cs as ContentScript[];
}

function gecko(m: Record<string, unknown>): Record<string, unknown> {
  const bss = m.browser_specific_settings as
    | { gecko?: Record<string, unknown> }
    | undefined;
  assert.ok(bss?.gecko, 'browser_specific_settings.gecko must be set');
  return bss.gecko;
}

test('Chrome, Brave and Opera ship one Chromium manifest; Firefox its own', () => {
  assert.deepEqual(BROWSER_TARGETS, ['chrome', 'brave', 'opera', 'firefox']);
  assert.equal(manifestFamily('chrome'), 'chromium');
  assert.equal(manifestFamily('brave'), 'chromium');
  assert.equal(manifestFamily('opera'), 'chromium');
  assert.equal(manifestFamily('firefox'), 'firefox');
  assert.deepEqual(built('brave'), built('chrome'));
  assert.deepEqual(built('opera'), built('chrome'));
  assert.deepEqual(built('chrome'), readJson('manifest.json'));
});

test('chromiumManifest is a copy: mutating it leaves the source intact', () => {
  const base = { content_scripts: [{ js: ['a.js'] }] };
  const out = chromiumManifest(base);
  (out.content_scripts as { js: string[] }[])[0].js.push('b.js');
  assert.deepEqual(base, { content_scripts: [{ js: ['a.js'] }] });
});

for (const target of BROWSER_TARGETS) {
  test(`${target}: the inpage entry is a MAIN-world content script at document_start`, () => {
    const m = built(target);
    const main = contentScripts(m).filter((c) => c.world === 'MAIN');
    assert.equal(main.length, 1, 'exactly one main-world entry');
    assert.deepEqual(main[0].js, [INPAGE]);
    assert.equal(main[0].run_at, 'document_start');
    assert.equal(main[0].all_frames, false);
    // The isolated relay runs on the same pages at the same time, so a page
    // never has a provider without the relay that serves it.
    const isolated = contentScripts(m).filter((c) => c.world !== 'MAIN');
    assert.equal(isolated.length, 1, 'exactly one isolated-world entry');
    assert.deepEqual(isolated[0].js, ['src/content/content.js']);
    assert.ok(
      isolated[0].world === undefined || isolated[0].world === 'ISOLATED'
    );
    assert.equal(isolated[0].run_at, 'document_start');
    assert.equal(isolated[0].all_frames, false);
    assert.deepEqual(isolated[0].matches, main[0].matches);
  });

  test(`${target}: no web-accessible resource, so no page can probe the extension`, () => {
    assert.ok(!('web_accessible_resources' in built(target)));
  });

  test(`${target}: content scripts match http and https pages only`, () => {
    for (const c of contentScripts(built(target))) {
      assert.deepEqual([...(c.matches ?? [])].sort(), WEB_SCHEMES);
    }
  });

  test(`${target}: extension pages carry the restrictive CSP`, () => {
    const csp = built(target).content_security_policy as
      | Record<string, unknown>
      | undefined;
    assert.ok(csp, 'content_security_policy must be set');
    assert.deepEqual(Object.keys(csp), ['extension_pages']);
    assert.equal(
      csp.extension_pages,
      "default-src 'self'; script-src 'self'; object-src 'none'; " +
        "base-uri 'none'; connect-src ws://127.0.0.1:*"
    );
  });

  test(`${target}: author is a name and the site is homepage_url`, () => {
    const m = built(target);
    assert.equal(m.author, 'AirNox');
    assert.equal(m.homepage_url, 'https://airnox.app');
  });
}

test('the Chromium manifest keeps its floor and carries no gecko keys', () => {
  const m = built('chrome');
  // world: "MAIN" content scripts need Chrome 111; the worker's WebSocket
  // keep-alive needs 116; X25519 in WebCrypto, which pairing with the desktop
  // by code derives its keys with, needs 133 (Brave and Opera follow their
  // Chromium base).
  assert.ok(Number(m.minimum_chrome_version) >= 133);
  assert.ok(!('browser_specific_settings' in m));
});

test('the Firefox manifest sets its floor, data collection and update URL', () => {
  const g = gecko(built('firefox'));
  assert.equal(g.id, 'airnox@airnox.app');
  // 140 is the first Firefox with the built-in data-consent UI; it also covers
  // world: "MAIN" content scripts (128), storage.session (115) and X25519 in
  // WebCrypto.
  assert.equal(g.strict_min_version, '140.0');
  assert.deepEqual(g.data_collection_permissions, { required: ['none'] });
  assert.equal(
    g.update_url,
    'https://airnox.app/extension/firefox/updates.json'
  );
});

test('the Firefox update manifest template names this add-on and its floor', () => {
  const g = gecko(built('firefox'));
  const doc = readJson('firefox_updates.json') as {
    addons?: Record<string, { updates?: Record<string, unknown>[] }>;
  };
  assert.deepEqual(Object.keys(doc.addons ?? {}), [g.id]);
  const updates = doc.addons?.[g.id as string]?.updates;
  assert.ok(Array.isArray(updates) && updates.length === 1);
  const entry = updates[0];
  assert.deepEqual(Object.keys(entry).sort(), [
    'applications',
    'update_hash',
    'update_link',
    'version',
  ]);
  assert.equal(entry.version, '{version}');
  assert.equal(
    entry.update_link,
    'https://airnox.app/extension/firefox/airnox-{version}.xpi'
  );
  assert.equal(entry.update_hash, 'sha256:{sha256}');
  assert.deepEqual(entry.applications, {
    gecko: { strict_min_version: g.strict_min_version },
  });
  // The XPIs live next to the update manifest.
  const dir = (g.update_url as string).replace(/[^/]*$/, '');
  assert.ok((entry.update_link as string).startsWith(dir));
});
