import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePageRequest } from '../src/content/page_request';
import { PAGE_TO_CONTENT } from '../src/protocol/bridge';
import { ErrorCode } from '../src/protocol/envelope';

function pageFrame(overrides: Record<string, unknown>): unknown {
  return {
    channel: PAGE_TO_CONTENT,
    id: 'req-1',
    ns: 'evm',
    method: 'eth_chainId',
    ...overrides,
  };
}

test('a well-formed dApp request is relayed', () => {
  for (const ns of ['evm', 'wstd', 'tonconnect', 'tron']) {
    const out = parsePageRequest(pageFrame({ ns }));
    assert.equal(out.kind, 'relay');
    if (out.kind === 'relay') {
      assert.equal(out.req.ns, ns);
      assert.equal(out.req.id, 'req-1');
    }
  }
});

test('a sys control-plane request is rejected, not relayed', () => {
  const out = parsePageRequest(pageFrame({ ns: 'sys', method: 'sys_ping' }));
  assert.equal(out.kind, 'reject');
  if (out.kind === 'reject') {
    assert.equal(out.id, 'req-1');
    assert.equal(out.code, ErrorCode.MalformedRequest);
  }
});

test('an unknown namespace is rejected (fail closed)', () => {
  for (const ns of ['eth', 'admin', '', 42, undefined]) {
    const out = parsePageRequest(pageFrame({ ns }));
    assert.equal(out.kind, 'reject');
  }
});

test('a frame that is not ours, or has no id, is ignored (no reply)', () => {
  assert.equal(parsePageRequest(undefined).kind, 'ignore');
  assert.equal(parsePageRequest({ channel: 'other', id: 'x' }).kind, 'ignore');
  assert.equal(
    parsePageRequest(pageFrame({ id: undefined })).kind,
    'ignore' // no id → cannot correlate a reply, so drop silently
  );
});

test('a provider touch is relayed as a touch, with no id and no namespace', () => {
  // It is not a request: it carries nothing to answer and must not be dropped by
  // the id guard, nor rejected by the namespace gate that guards `sys`.
  const out = parsePageRequest({ channel: PAGE_TO_CONTENT, touch: true });
  assert.equal(out.kind, 'touch');
});

test('a touch flag on someone else\u2019s channel is still ignored', () => {
  assert.equal(
    parsePageRequest({ channel: 'other', touch: true }).kind,
    'ignore'
  );
  assert.equal(parsePageRequest({ touch: true }).kind, 'ignore');
  // Only the literal `true` counts — a truthy value is not the frame we defined.
  assert.equal(
    parsePageRequest({ channel: PAGE_TO_CONTENT, touch: 'yes' }).kind,
    'ignore'
  );
});

// ── the fields that go into the wire frame ───────────────────────────────────
// The SW copies `method` and `chain` into the frame it sends the desktop. A frame
// the desktop cannot parse is answered without a request id, so it must never get
// that far: a page that could send one could make the transport settle a request
// that is not its own.

function assertRefused(out: ReturnType<typeof parsePageRequest>): void {
  assert.equal(out.kind, 'reject');
  if (out.kind === 'reject') {
    assert.equal(out.id, 'req-1');
    assert.equal(out.code, ErrorCode.MalformedRequest);
  }
}

test('a chain that is present but not a string is refused to the sender', () => {
  for (const chain of [1, 0, null, true, { id: 1 }, ['nt:evm:ci:1']]) {
    assertRefused(parsePageRequest(pageFrame({ chain })));
  }
});

test('a method that is not a non-empty string under the cap is refused', () => {
  for (const method of [
    '',
    42,
    undefined,
    null,
    ['eth_chainId'],
    'm'.repeat(129),
  ]) {
    assertRefused(parsePageRequest(pageFrame({ method })));
  }
  assert.equal(
    parsePageRequest(pageFrame({ method: 'm'.repeat(128) })).kind,
    'relay'
  );
});

test('an id over the cap is refused; one at the cap is relayed', () => {
  const long = 'i'.repeat(129);
  const out = parsePageRequest(pageFrame({ id: long }));
  assert.equal(out.kind, 'reject');
  if (out.kind === 'reject') {
    assert.equal(out.id, long);
    assert.equal(out.code, ErrorCode.MalformedRequest);
  }
  assert.equal(
    parsePageRequest(pageFrame({ id: 'i'.repeat(128) })).kind,
    'relay'
  );
});

test('an absent chain and any params are relayed as given', () => {
  const absent = parsePageRequest(pageFrame({ chain: undefined }));
  assert.equal(absent.kind, 'relay');
  const keyed = parsePageRequest(
    pageFrame({ chain: 'nt:evm:ci:1', params: [{ to: '0x1' }] })
  );
  assert.equal(keyed.kind, 'relay');
  if (keyed.kind === 'relay') {
    assert.equal(keyed.req.chain, 'nt:evm:ci:1');
    assert.deepEqual(keyed.req.params, [{ to: '0x1' }]);
  }
});

const HOLDERS = {
  ethereum: 'other',
  tronWeb: 'airnox',
  tronLink: 'airnox',
  tron: 'airnox',
  airnox: 'none',
};

test('a holder report from the main world is parsed, with no id and no namespace', () => {
  const out = parsePageRequest({ channel: PAGE_TO_CONTENT, holders: HOLDERS });
  assert.equal(out.kind, 'holders');
  if (out.kind === 'holders') {
    assert.deepEqual(out.report, HOLDERS);
  }
});

test('a malformed holder report is ignored, never relayed or answered', () => {
  for (const holders of [null, 'other', { ...HOLDERS, ethereum: 'metamask' }]) {
    const out = parsePageRequest({
      channel: PAGE_TO_CONTENT,
      id: 'req-1',
      ns: 'evm',
      method: 'eth_chainId',
      holders,
    });
    assert.equal(out.kind, 'ignore', JSON.stringify(holders));
  }
});

test('a holder report on someone else’s channel is ignored', () => {
  const out = parsePageRequest({ channel: 'other', holders: HOLDERS });
  assert.equal(out.kind, 'ignore');
});
