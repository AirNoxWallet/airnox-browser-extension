import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAPP_NAMESPACES, isDappNamespace } from '../src/protocol/envelope';

// A web page may address only the dApp namespaces. `sys` is the
// extension<->desktop control plane and must never be reachable from a page (it
// would otherwise be an unauthenticated wallet-status / version oracle). Both
// the content script and the SW gate on this allowlist.

test('the four dApp namespaces are accepted', () => {
  assert.deepEqual([...DAPP_NAMESPACES], ['evm', 'wstd', 'tonconnect', 'tron']);
  for (const ns of DAPP_NAMESPACES) {
    assert.equal(isDappNamespace(ns), true);
  }
});

test('the sys control-plane namespace is refused from a page', () => {
  assert.equal(isDappNamespace('sys'), false);
});

test('unknown / malformed namespace values are refused (fail closed)', () => {
  for (const bad of [
    '',
    'SYS',
    'evm ',
    'eth',
    'admin',
    undefined,
    null,
    42,
    {},
    ['evm'],
  ]) {
    assert.equal(isDappNamespace(bad), false);
  }
});
