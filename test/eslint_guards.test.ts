// The realm guards in eslint.config.mjs, linted against probe snippets. tsc
// cannot see a realm boundary, so these rules are the only thing that stops a
// cross-realm import or an extension-API reference in the main world; a rule
// that silently stops matching would leave `npm run lint` green on exactly the
// mistake it exists for. Each case names a file path inside a realm, a line of
// code, and whether the guards must refuse it.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';

const root = path.resolve(__dirname, '..');

// require(esm): the flat config is an ES module; Node 24 loads it synchronously.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { guardBlocks } = require('../eslint.config.mjs') as {
  guardBlocks: Linter.Config[];
};

const linter = new ESLint({
  cwd: root,
  overrideConfigFile: true,
  overrideConfig: [
    { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
    ...guardBlocks,
  ],
});

async function refusedBy(file: string, code: string): Promise<string[]> {
  const [result] = await linter.lintText(code, {
    filePath: path.join(root, file),
  });
  assert.equal(result.fatalErrorCount, 0, JSON.stringify(result.messages));
  return result.messages.map((m) => m.ruleId ?? 'fatal');
}

type Case = [file: string, code: string, rule: string | null];

const cases: Case[] = [
  // Cross-realm imports, every spelling of the path.
  [
    'src/inpage/p.ts',
    "import '../transport/ws_client';",
    'no-restricted-imports',
  ],
  ['src/inpage/p.ts', "import '../transport';", 'no-restricted-imports'],
  [
    'src/inpage/p.ts',
    "import '../../src/transport/ws_client';",
    'no-restricted-imports',
  ],
  ['src/content/p.ts', "import '../transport/index';", 'no-restricted-imports'],
  ['src/content/p.ts', "import '../background';", 'no-restricted-imports'],
  [
    'src/content/p.ts',
    "import '../../src/inpage/provider';",
    'no-restricted-imports',
  ],
  ['src/inpage/p.ts', "import '../content/content';", 'no-restricted-imports'],
  ['src/background/p.ts', "import '../popup';", 'no-restricted-imports'],
  [
    'src/background/p.ts',
    "import '../../src/content/port_relay';",
    'no-restricted-imports',
  ],
  [
    'src/transport/p.ts',
    "import '../background/badge';",
    'no-restricted-imports',
  ],
  ['src/transport/p.ts', "import '../background';", 'no-restricted-imports'],
  ['src/popup/p.ts', "import '../inpage';", 'no-restricted-imports'],
  ['src/protocol/p.ts', "import '../transport';", 'no-restricted-imports'],
  [
    'src/protocol/p.ts',
    "import '../../src/background/badge';",
    'no-restricted-imports',
  ],
  ['src/protocol/p.ts', "import { v4 } from 'uuid';", 'no-restricted-imports'],
  // The main world has no extension API, by any name.
  [
    'src/inpage/p.ts',
    "import browser from 'webextension-polyfill';",
    'no-restricted-imports',
  ],
  ['src/inpage/p.ts', 'chrome.runtime.id;', 'no-restricted-globals'],
  ['src/inpage/p.ts', 'browser.runtime.id;', 'no-restricted-globals'],
  ['src/inpage/p.ts', 'globalThis.chrome;', 'no-restricted-properties'],
  ['src/inpage/p.ts', 'globalThis.browser;', 'no-restricted-properties'],
  ['src/inpage/p.ts', 'window.chrome;', 'no-restricted-properties'],
  ['src/inpage/p.ts', "window['browser'];", 'no-restricted-properties'],
  ['src/inpage/p.ts', 'self.chrome;', 'no-restricted-properties'],
  // The service-worker side has no DOM, by any name.
  ['src/background/p.ts', 'document.title;', 'no-restricted-globals'],
  ['src/transport/p.ts', 'globalThis.document;', 'no-restricted-properties'],
  ['src/protocol/p.ts', 'globalThis.window;', 'no-restricted-properties'],
  ['src/background/p.ts', 'self.localStorage;', 'no-restricted-properties'],
  // No HTML sinks anywhere: text goes through textContent.
  [
    'src/popup/p.ts',
    'declare const e: Element; e.innerHTML = "x";',
    'no-restricted-syntax',
  ],
  [
    'src/content/p.ts',
    'declare const e: Element; e.outerHTML = "x";',
    'no-restricted-syntax',
  ],
  [
    'src/inpage/p.ts',
    'declare const e: Element; e["innerHTML"] = "x";',
    'no-restricted-syntax',
  ],
  [
    'src/popup/p.ts',
    'declare const e: Element; e.insertAdjacentHTML("beforeend", "x");',
    'no-restricted-syntax',
  ],
  ['src/inpage/p.ts', 'document.write("x");', 'no-restricted-syntax'],
  ['src/content/p.ts', 'document.writeln("x");', 'no-restricted-syntax'],
  // What each realm may do.
  [
    'src/inpage/p.ts',
    "import { PostMessageTransport } from './transport';",
    null,
  ],
  ['src/inpage/p.ts', "import { chainKey } from '../protocol/chains';", null],
  ['src/inpage/p.ts', "import { v4 } from 'uuid';", null],
  ['src/content/p.ts', "import browser from 'webextension-polyfill';", null],
  ['src/content/p.ts', 'chrome.runtime.id;', null],
  [
    'src/background/p.ts',
    "import { WsClient } from '../transport/ws_client';",
    null,
  ],
  [
    'src/background/p.ts',
    "import { BackgroundRouter } from './background_router';",
    null,
  ],
  [
    'src/popup/p.ts',
    "import { readSettings } from '../transport/settings';",
    null,
  ],
  ['src/popup/p.ts', 'document.title;', null],
  ['src/popup/p.ts', 'declare const e: Element; e.textContent = "x";', null],
  ['src/protocol/p.ts', "import { chainKey } from './chains';", null],
];

for (const [file, code, rule] of cases) {
  const verdict = rule === null ? 'allows' : `refuses (${rule})`;
  test(`${file} ${verdict}: ${code}`, async () => {
    const rules = await refusedBy(file, code);
    if (rule === null) assert.deepEqual(rules, []);
    else assert.ok(rules.includes(rule), `got ${JSON.stringify(rules)}`);
  });
}
