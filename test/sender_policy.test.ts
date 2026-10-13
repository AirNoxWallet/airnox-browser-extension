import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SenderLike,
  contentPortOrigin,
  isExtensionPageSender,
} from '../src/background/sender_policy';

// ── contentPortOrigin ────────────────────────────────────────────────────────

test('contentPortOrigin takes the origin Chrome attests for a top frame', () => {
  assert.equal(
    contentPortOrigin({
      tab: { id: 1 },
      frameId: 0,
      url: 'https://app.example/swap',
      origin: 'https://app.example',
    }),
    'https://app.example'
  );
});

test('contentPortOrigin prefers the attested origin to the URL', () => {
  // Chrome's `origin` is the document's security origin; the URL is only where
  // it was loaded from, and the two differ for a document whose origin is not
  // its URL's.
  assert.equal(
    contentPortOrigin({
      tab: { id: 1 },
      frameId: 0,
      url: 'https://a.example/',
      origin: 'https://b.example',
    }),
    'https://b.example'
  );
});

test('contentPortOrigin reads the origin off the URL when the browser gives no origin', () => {
  assert.equal(
    contentPortOrigin({
      tab: { id: 1 },
      frameId: 0,
      url: 'http://localhost:5173/path?q=1#h',
    }),
    'http://localhost:5173'
  );
});

test('contentPortOrigin refuses what is not a content script in a top frame', () => {
  const refused: Array<[string, SenderLike | undefined]> = [
    ['no sender', undefined],
    [
      'no tab (an extension page or a worker)',
      { frameId: 0, url: 'https://a.example/', origin: 'https://a.example' },
    ],
    [
      'a child frame',
      {
        tab: { id: 1 },
        frameId: 5,
        url: 'https://a.example/',
        origin: 'https://a.example',
      },
    ],
    [
      'no frame id',
      {
        tab: { id: 1 },
        url: 'https://a.example/',
        origin: 'https://a.example',
      },
    ],
    ['neither origin nor URL', { tab: { id: 1 }, frameId: 0 }],
    [
      'an unparseable URL',
      { tab: { id: 1 }, frameId: 0, url: 'not a url at all' },
    ],
    [
      'an opaque attested origin',
      {
        tab: { id: 1 },
        frameId: 0,
        url: 'https://a.example/',
        origin: 'null',
      },
    ],
    [
      'a URL with an opaque origin',
      { tab: { id: 1 }, frameId: 0, url: 'about:blank' },
    ],
    [
      'a non-string origin and no URL',
      { tab: { id: 1 }, frameId: 0, origin: 7 as unknown as string },
    ],
    [
      'an empty origin',
      { tab: { id: 1 }, frameId: 0, url: 'https://a.example/', origin: '' },
    ],
  ];
  for (const [what, sender] of refused) {
    assert.equal(contentPortOrigin(sender), undefined, what);
  }
});

// ── isExtensionPageSender ────────────────────────────────────────────────────

const CHROME_BASE = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';
const FIREFOX_BASE = 'moz-extension://1b2c3d4e-0000-4000-8000-0123456789ab/';

test('isExtensionPageSender admits the popup on either browser', () => {
  assert.equal(
    isExtensionPageSender(
      { url: `${CHROME_BASE}src/popup/popup.html` },
      CHROME_BASE
    ),
    true
  );
  assert.equal(
    isExtensionPageSender(
      { url: `${FIREFOX_BASE}src/popup/popup.html` },
      FIREFOX_BASE
    ),
    true
  );
});

test('isExtensionPageSender admits the popup page opened in a tab', () => {
  // Still the extension's own page, with every privilege the popup has; a tab
  // adds nothing a content script could use.
  assert.equal(
    isExtensionPageSender(
      { tab: { id: 3 }, frameId: 0, url: `${CHROME_BASE}src/popup/popup.html` },
      CHROME_BASE
    ),
    true
  );
});

test('isExtensionPageSender refuses a content script and anything not ours', () => {
  const refused: Array<[string, SenderLike | undefined]> = [
    ['no sender', undefined],
    ['no URL', {}],
    [
      'a content script (its URL is the page)',
      { tab: { id: 1 }, frameId: 0, url: 'https://app.example/' },
    ],
    [
      'a content script on a page whose URL embeds the base',
      {
        tab: { id: 1 },
        frameId: 0,
        url: `https://app.example/?r=${CHROME_BASE}`,
      },
    ],
    [
      'another extension whose id starts with ours',
      {
        url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnopq/popup.html',
      },
    ],
    ['the base without its trailing slash', { url: CHROME_BASE.slice(0, -1) }],
    ['a non-string URL', { url: 1 as unknown as string }],
  ];
  for (const [what, sender] of refused) {
    assert.equal(isExtensionPageSender(sender, CHROME_BASE), false, what);
  }
});

test('isExtensionPageSender refuses everything against a base that is not an origin with its slash', () => {
  const popup = { url: `${CHROME_BASE}src/popup/popup.html` };
  assert.equal(isExtensionPageSender(popup, CHROME_BASE.slice(0, -1)), false);
  assert.equal(isExtensionPageSender(popup, ''), false);
});
