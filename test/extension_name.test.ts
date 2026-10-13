import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BROWSER_TARGETS, manifestFor } from '../manifest_build';
import { AIRNOX_NAME, AIRNOX_RDNS } from '../src/inpage/brand';
import { DEFAULT_DEVICE_INFO } from '../src/inpage/tonconnect_bridge';
import { IDLE_TITLE, badgeFace } from '../src/background/badge_state';
import { versionErrorMessage } from '../src/background/background_router';
import { friendlyErrorMessage } from '../src/inpage/rpc_error';
import { ErrorCode } from '../src/protocol/envelope';

// The extension is named "AirNox"; the desktop application it talks to keeps
// its name, "AirNox Wallet". Every text that names the extension says "AirNox",
// every text that names the desktop says "AirNox Wallet", and the identifiers
// that installed copies, dApps and the stores already key on stay as they are.

const ROOT = join(__dirname, '..');

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as Record<
    string,
    unknown
  >;
}

function readText(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

const base = readJson('manifest.json');
const firefoxKeys = readJson('firefox.json');

for (const target of BROWSER_TARGETS) {
  test(`${target}: the manifest names the extension AirNox`, () => {
    const m = manifestFor(target, base, firefoxKeys) as Record<
      string,
      unknown
    > & { action?: { default_title?: string } };
    assert.equal(m.name, 'AirNox');
    assert.equal(m.short_name, 'AirNox');
    assert.equal(m.action?.default_title, 'AirNox');
  });
}

test('the manifest description fits the store and names the desktop app', () => {
  const d = base.description;
  assert.equal(typeof d, 'string');
  // The Chrome Web Store refuses a description longer than 132 characters.
  assert.ok((d as string).length <= 132, `${(d as string).length} characters`);
  assert.match(d as string, /AirNox Wallet desktop app/);
});

test('the idle toolbar tooltip is the manifest default_title', () => {
  const action = base.action as { default_title?: string };
  assert.equal(IDLE_TITLE, action.default_title);
  // A state tooltip names the extension first, then the reason.
  assert.match(badgeFace(false).title, /^AirNox — /);
});

test('a dApp sees the name AirNox in every discovery standard', () => {
  // EIP-6963 info.name and both Wallet Standard wallets read this constant.
  assert.equal(AIRNOX_NAME, 'AirNox');
  // TON Connect's DeviceInfo.appName, which the SDK compares with the
  // wallets-list entry.
  assert.equal(DEFAULT_DEVICE_INFO.appName, 'AirNox');
});

test('the package and its archives carry the new name', () => {
  const pkg = readJson('package.json') as {
    name: string;
    scripts: Record<string, string>;
  };
  assert.equal(pkg.name, 'airnox-browser-extension');
  const lock = readJson('package-lock.json') as {
    name: string;
    packages: Record<string, { name?: string }>;
  };
  assert.equal(lock.name, 'airnox-browser-extension');
  assert.equal(lock.packages['']?.name, 'airnox-browser-extension');
  assert.match(
    pkg.scripts['package:chrome'],
    / -n airnox-chrome-\{version\}\.zip /
  );
  assert.match(
    pkg.scripts['package:firefox'],
    / -n airnox-firefox-\{version\}\.zip /
  );
});

test('the extension-side error texts name the extension, the desktop ones the app', () => {
  assert.match(
    versionErrorMessage({
      compatible: false,
      updateSide: 'extension',
      desktop: { wallet: 2, major: 3, minor: 0 },
    }),
    /^The AirNox extension is out of date /
  );
  assert.match(
    versionErrorMessage({
      compatible: false,
      updateSide: 'desktop',
      desktop: { wallet: 2, major: 1, minor: 0 },
    }),
    /^AirNox Wallet desktop is out of date /
  );
  // It is this browser's extension instance that is not paired, not the site.
  const notPaired = friendlyErrorMessage(ErrorCode.NotPaired, '');
  assert.match(notPaired, /^This browser is not paired with AirNox Wallet\./);
  assert.match(
    friendlyErrorMessage(ErrorCode.VersionIncompatible, ''),
    /The AirNox extension and the AirNox Wallet desktop app /
  );
  assert.match(
    readText('src/transport/ws_client.ts'),
    /new Error\('cannot reach the AirNox Wallet desktop app'\)/
  );
});

test('the popup is titled AirNox and its mark links to the site', () => {
  const html = readText('src/popup/popup.html');
  assert.match(html, /<title>AirNox<\/title>/);
  assert.ok(!html.includes('◢'), 'the old text glyph is gone');
  const brand = /<a\s+class="brand"([^>]*)>([\s\S]*?)<\/a>/.exec(html);
  assert.ok(brand, 'the header brand is a link');
  const [, attrs, body] = brand;
  assert.match(attrs, /href="https:\/\/airnox\.app"/);
  assert.match(attrs, /target="_blank"/);
  assert.match(attrs, /rel="noopener noreferrer"/);
  const img = /<img\s([^>]*)>/.exec(body);
  assert.ok(img, 'the mark is an image');
  const src = /src="\/(icons\/icon-\d+\.png)"/.exec(img[1]);
  assert.ok(src, img[1]);
  // The build copies icons/ into every package, so the popup reaches the file
  // at the extension root.
  readFileSync(join(ROOT, src[1]));
  assert.match(img[1], /alt=""/);
  assert.match(body, /AirNox/);
});

test('no tracked text calls the extension "AirNox Wallet" or "AirNox wallet"', () => {
  // This file names the texts to find them, so it is the one file not searched.
  const skip = new Set(['test/extension_name.test.ts']);
  const files = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((f) => f !== '' && !skip.has(f));
  const hits: string[] = [];
  for (const file of files) {
    const bytes = readFileSync(join(ROOT, file));
    if (bytes.includes(0)) {
      continue;
    }
    bytes
      .toString('utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/AirNox Wallet extension|AirNox wallet\b/.test(line)) {
          hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
        }
      });
  }
  assert.deepEqual(hits, []);
});

// The identifiers frozen at the first release: a rename here re-pairs every
// installed browser, breaks a dApp's saved connector, or makes a new add-on.
const FROZEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['src/transport/iid.ts', /const IID_KEY = 'airnox_instance_id';/],
  ['src/transport/settings.ts', /const MODE_KEY = 'airnox_transport_mode';/],
  ['src/transport/settings.ts', /const PORT_KEY = 'airnox_manual_port';/],
  ['src/popup/popup_view.ts', /export const THEME_KEY = 'theme' as const;/],
  [
    'src/inpage/tonconnect_inpage.ts',
    /const JS_BRIDGE_KEY = 'airnox' as const;/,
  ],
  ['src/inpage/evm_provider.ts', /readonly isAirNoxWallet = true;/],
  ['src/content/content.ts', /runtime\.connect\(\{ name: 'airnox' \}\)/],
];

test('the frozen identifiers keep their values', () => {
  assert.equal(AIRNOX_RDNS, 'app.airnox');
  const gecko = (
    firefoxKeys.browser_specific_settings as { gecko: { id: string } }
  ).gecko;
  assert.equal(gecko.id, 'airnox@airnox.app');
  for (const [file, pattern] of FROZEN) {
    assert.match(readText(file), pattern, file);
  }
});
