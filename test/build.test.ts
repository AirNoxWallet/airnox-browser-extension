// The release build: every step awaited, each package written from an empty
// tree, and the same source building the same bytes. A tree's digest is the
// value a store reviewer compares after rebuilding from the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Builder, treeDigest } from '../buildUtils';
import { addReleaseFiles } from '../build';

const root = path.resolve(__dirname, '..');

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'airnox-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function releaseBuilder(distRoot: string): Builder {
  return addReleaseFiles(
    new Builder({
      watchFlag: false,
      devFlag: false,
      chromeFlag: true,
      firefoxFlag: true,
      distRoot,
      logLevel: 'silent',
    })
  );
}

const PACKAGE_FILES = [
  'manifest.json',
  'src/background/background.js',
  'src/content/content.js',
  'src/inpage/inpage.js',
  'src/popup/popup.js',
  'src/popup/popup.html',
  'src/popup/popup.css',
  'src/popup/pairing.js',
  'src/popup/pairing.html',
  'icons/icon-128.png',
  'LICENSE',
  'THIRD_PARTY_NOTICES',
];

test('a build writes each package from an empty tree', async (t) => {
  const dist = tempDir(t);
  for (const target of ['dist-chrome', 'dist-firefox']) {
    mkdirSync(path.join(dist, target, 'src/old'), { recursive: true });
    writeFileSync(path.join(dist, target, 'src/old/stale.js'), 'stale');
  }
  await releaseBuilder(dist).build();
  for (const target of ['dist-chrome', 'dist-firefox']) {
    assert.equal(existsSync(path.join(dist, target, 'src/old')), false, target);
    for (const file of PACKAGE_FILES) {
      assert.ok(existsSync(path.join(dist, target, file)), `${target}/${file}`);
    }
    for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES']) {
      assert.deepEqual(
        readFileSync(path.join(dist, target, file)),
        readFileSync(path.join(root, file)),
        `${target}/${file}`
      );
    }
  }
});

test('two builds into different directories give the same trees', async (t) => {
  const a = tempDir(t);
  const b = tempDir(t);
  await releaseBuilder(a).build();
  await releaseBuilder(b).build();
  for (const target of ['dist-chrome', 'dist-firefox']) {
    assert.equal(
      await treeDigest(path.join(a, target)),
      await treeDigest(path.join(b, target)),
      target
    );
  }
});

test('a failing entry point rejects the build', async (t) => {
  const builder = releaseBuilder(tempDir(t));
  builder.addBuildFile('src/no_such_entry.ts');
  await assert.rejects(builder.build());
});

test('a tree digest follows every byte and every name', async (t) => {
  const dir = tempDir(t);
  mkdirSync(path.join(dir, 'a'));
  writeFileSync(path.join(dir, 'a/one.js'), 'one');
  writeFileSync(path.join(dir, 'two.js'), 'two');
  const first = await treeDigest(dir);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(await treeDigest(dir), first);
  writeFileSync(path.join(dir, 'two.js'), 'twO');
  const edited = await treeDigest(dir);
  assert.notEqual(edited, first);
  renameSync(path.join(dir, 'two.js'), path.join(dir, 'three.js'));
  assert.notEqual(await treeDigest(dir), edited);
});
