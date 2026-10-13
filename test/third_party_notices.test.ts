// The licence files every package carries. LICENSE is this code's Apache-2.0
// text; THIRD_PARTY_NOTICES names every npm package esbuild bundles into a
// shipped script, at the locked version, with the scripts it lands in and its
// licence text verbatim. The bundled set is read from esbuild's own metafile,
// so a new or bumped runtime dependency fails here until its notice is written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { Builder } from '../buildUtils';
import { addReleaseFiles } from '../build';

const root = path.resolve(__dirname, '..');

interface Bundled {
  version: string;
  license: string;
  licenseText: string;
  scripts: string[];
}

function packageOf(input: string): string | null {
  const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
  return match === null ? null : match[1];
}

async function bundledPackages(): Promise<Map<string, Bundled>> {
  const builder = addReleaseFiles(
    new Builder({
      watchFlag: false,
      devFlag: false,
      chromeFlag: true,
      firefoxFlag: true,
    })
  );
  const found = new Map<string, Bundled>();
  for (const entry of builder.buildFiles) {
    const options = builder.entryOptions(entry, 'chrome');
    const result = await build({
      ...options,
      absWorkingDir: root,
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    const script = entry.replace(/\.ts$/, '.js');
    for (const input of Object.keys(result.metafile.inputs)) {
      const name = packageOf(input);
      if (name === null) continue;
      let bundled = found.get(name);
      if (bundled === undefined) {
        const dir = path.join(root, 'node_modules', name);
        const manifest = JSON.parse(
          readFileSync(path.join(dir, 'package.json'), 'utf8')
        ) as { version: string; license: string };
        const licenseFile = readdirSync(dir).find((f) =>
          /^licen[cs]e/i.test(f)
        );
        assert.ok(licenseFile, `${name} ships no licence file`);
        bundled = {
          version: manifest.version,
          license: manifest.license,
          licenseText: readFileSync(path.join(dir, licenseFile), 'utf8'),
          scripts: [],
        };
        found.set(name, bundled);
      }
      if (!bundled.scripts.includes(script)) bundled.scripts.push(script);
    }
  }
  return found;
}

// One block per package, opened by `Package: <name> <version>`.
function noticeBlocks(): Map<string, string> {
  const notices = readFileSync(path.join(root, 'THIRD_PARTY_NOTICES'), 'utf8');
  const blocks = new Map<string, string>();
  const parts = notices.split(/^(?=Package: )/m).slice(1);
  for (const part of parts) {
    const head = /^Package: (\S+) (\S+)$/m.exec(part);
    assert.ok(head);
    blocks.set(`${head[1]} ${head[2]}`, part);
  }
  return blocks;
}

test('THIRD_PARTY_NOTICES names exactly the packages the bundles contain', async () => {
  const bundled = await bundledPackages();
  assert.ok(bundled.size > 0, 'esbuild reported no bundled package');
  const expected = [...bundled].map(([name, b]) => `${name} ${b.version}`);
  assert.deepEqual([...noticeBlocks().keys()].sort(), expected.sort());
});

test('each notice carries its licence, its scripts and its licence text', async () => {
  const blocks = noticeBlocks();
  for (const [name, b] of await bundledPackages()) {
    const block = blocks.get(`${name} ${b.version}`);
    assert.ok(block, name);
    assert.match(block, new RegExp(`^License: ${b.license}$`, 'm'), name);
    assert.match(block, /^Source: https:\/\/\S+$/m, name);
    const scripts = /^Bundled into: (.+)$/m.exec(block);
    assert.ok(scripts, name);
    assert.deepEqual(
      scripts[1].split(', ').sort(),
      [...b.scripts].sort(),
      name
    );
    assert.ok(
      block.includes(b.licenseText.trim()),
      `${name}: the licence text is not verbatim`
    );
  }
});

test('an MPL-2.0 notice says where the Source Code Form is', async () => {
  const blocks = noticeBlocks();
  for (const [name, b] of await bundledPackages()) {
    if (b.license !== 'MPL-2.0') continue;
    const block = blocks.get(`${name} ${b.version}`) ?? '';
    assert.match(block, /Source Code Form/, name);
    assert.match(block, /Mozilla Public License Version 2\.0/, name);
  }
});

test('LICENSE is the Apache License 2.0 text package.json declares', () => {
  const license = readFileSync(path.join(root, 'LICENSE'), 'utf8');
  const manifest = JSON.parse(
    readFileSync(path.join(root, 'package.json'), 'utf8')
  ) as { license: string };
  assert.equal(manifest.license, 'Apache-2.0');
  assert.match(license, /^\s*Apache License\n\s*Version 2\.0, January 2004\n/);
  assert.match(license, /END OF TERMS AND CONDITIONS/);
});
