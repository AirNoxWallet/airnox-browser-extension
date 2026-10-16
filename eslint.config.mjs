// @ts-check
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// ── layer boundaries ─────────────────────────────────────────────────────────
// Four isolated JS realms (background SW, content isolated world, inpage main
// world, popup document) over two shared layers (protocol, transport). tsc
// cannot see a realm boundary, so it is enforced here and reported as the line
// is written rather than at review.
//
// These blocks need no type information, so test/eslint_guards.test.ts lints
// probe snippets against them alone.
//
// NB: a later block that names a rule REPLACES an earlier block's config for
// that rule on the same file. Each file below is therefore covered by exactly
// one `no-restricted-imports` block; do not split them.
// A relative import that reaches the named top-level directories under src/,
// however it is spelled: `../x`, `../x/y`, or `../../src/x/y`. A directory
// import (`../x`, its index) counts as much as a file in it does.
const realmImport = (realms, message) => ({
  regex: `^\\.\\.(/\\.\\.)*/(src/)?(${realms.join('|')})(/|$)`,
  message,
});
const crossRealm =
  'cross-realm import: realms are separate bundles; shared code goes to src/protocol';
const swOnly =
  'src/transport owns the desktop WebSocket and is service-worker-only';
const noExtensionApi =
  'the main world has no extension API — go through the transport seam';
const workerWindows =
  "windows are the service worker's: ask it (OPEN_PAIRING_MESSAGE)";
const domFree =
  'DOM-free layer — this belongs in src/content, src/inpage or src/popup';

// Every way a script names a global object: bare, and through each of the
// three spellings of the global itself.
const globalAliases = ['globalThis', 'self', 'window'];
const viaGlobal = (property, message) =>
  globalAliases.map((object) => ({ object, property, message }));

export const guardBlocks = [
  {
    // The service-worker side has no DOM (an MV3 worker has no document), and
    // protocol/ is bundled into every realm including that worker.
    files: [
      'src/protocol/**/*.ts',
      'src/transport/**/*.ts',
      'src/background/**/*.ts',
    ],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'document', message: domFree },
        { name: 'window', message: domFree },
        {
          name: 'localStorage',
          message: 'use browser.storage.local via src/transport',
        },
      ],
      'no-restricted-properties': [
        'error',
        ...viaGlobal('document', domFree),
        ...viaGlobal('localStorage', domFree),
        { object: 'globalThis', property: 'window', message: domFree },
        { object: 'self', property: 'window', message: domFree },
      ],
    },
  },
  {
    // src/inpage runs in the page's MAIN world, where the extension API does
    // not exist. Reaching the extension goes through the transport seam.
    files: ['src/inpage/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'browser', message: noExtensionApi },
        { name: 'chrome', message: noExtensionApi },
      ],
      'no-restricted-properties': [
        'error',
        ...viaGlobal('browser', noExtensionApi),
        ...viaGlobal('chrome', noExtensionApi),
      ],
    },
  },
  {
    // The pairing window is the service worker's alone, so there is one at a
    // time (src/background/pairing_window.ts): an extension page asks for it
    // with OPEN_PAIRING_MESSAGE and never opens or moves a window itself.
    files: ['src/popup/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'browser', property: 'windows', message: workerWindows },
        { object: 'chrome', property: 'windows', message: workerWindows },
      ],
    },
  },
  {
    // src/protocol is the shared contract layer: no dependencies at all, so it
    // can be bundled into every realm without dragging anything in.
    files: ['src/protocol/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['../*', 'uuid', 'webextension-polyfill'] },
      ],
    },
  },
  {
    // Nothing reaches into a realm from outside it. The realms are separate
    // esbuild entry points, so a cross-realm import duplicates code into the
    // wrong world; and src/transport is a shared layer, so it must not depend
    // upward on a realm at all. Shared code goes to src/protocol.
    files: [
      'src/transport/**/*.ts',
      'src/background/**/*.ts',
      'src/popup/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            realmImport(
              ['background', 'content', 'inpage', 'popup'],
              crossRealm
            ),
          ],
        },
      ],
    },
  },
  {
    // The isolated world additionally must not pull in src/transport: it owns
    // the desktop WebSocket and is service-worker-only.
    files: ['src/content/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            realmImport(
              ['background', 'content', 'inpage', 'popup'],
              crossRealm
            ),
            realmImport(['transport'], swOnly),
          ],
        },
      ],
    },
  },
  {
    // The main world, likewise, and it has no use for the extension API
    // wrapper either. Its own `./transport` (the page-side postMessage seam)
    // is a sibling module, not src/transport, and stays allowed.
    files: ['src/inpage/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'webextension-polyfill', message: noExtensionApi }],
          patterns: [
            realmImport(
              ['background', 'content', 'inpage', 'popup'],
              crossRealm
            ),
            realmImport(['transport'], swOnly),
          ],
        },
      ],
    },
  },
  {
    // No HTML sinks anywhere: a string parsed as markup is how a dApp-supplied
    // value (a name, an origin, an error message) becomes script. Text goes
    // through textContent.
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'MemberExpression[property.name=/^(innerHTML|outerHTML|insertAdjacentHTML)$/]',
          message: 'an HTML sink — use textContent or DOM nodes',
        },
        {
          selector:
            'MemberExpression[computed=true][property.value=/^(innerHTML|outerHTML|insertAdjacentHTML)$/]',
          message: 'an HTML sink — use textContent or DOM nodes',
        },
        {
          selector:
            "CallExpression[callee.object.name='document'][callee.property.name=/^write(ln)?$/]",
          message: 'document.write parses markup — build DOM nodes instead',
        },
      ],
    },
  },
];

export default defineConfig([
  {
    ignores: [
      'node_modules/',
      'dist/',
      'web-ext-artifacts/',
      'e2e/.chromium-profile*/',
    ],
  },
  eslint.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksVoidReturn: {
            arguments: false,
            attributes: false,
          },
        },
      ],
    },
  },
  {
    // node:test's `test()` returns a promise the runner tracks; calling it
    // without await is the intended API, not a floating-promise bug.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  {
    // Node scripts: this config and the e2e harness.
    files: ['**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // The e2e driver also ships callbacks that run inside the browser: in the
    // test page (window) and in the extension's service worker (chrome).
    files: ['e2e/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.webextensions,
      },
    },
  },
  ...guardBlocks,
  prettier,
]);
