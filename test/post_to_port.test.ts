import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postToPort } from '../src/background/post_to_port';
import { PortEvent, PortResult } from '../src/protocol/bridge';

const RESULT: PortResult = { kind: 'rpc-result', id: '1', ok: true };
const EVENT: PortEvent = { kind: 'event', ns: 'evm', event: 'accountsChanged' };

test('postToPort delivers the frame to a live port', () => {
  const sent: unknown[] = [];
  postToPort({ postMessage: (f) => sent.push(f) }, RESULT);
  assert.deepEqual(sent, [RESULT]);
});

test('postToPort swallows a disconnected-port throw (no unhandled rejection)', () => {
  const deadPort = {
    postMessage: (): void => {
      throw new Error('Attempting to use a disconnected port object');
    },
  };
  // The tab/page is gone; there is nothing to deliver and this must NOT throw
  // (handleRpc runs as `void handleRpc(...)`, so a throw here becomes an
  // unhandled rejection).
  assert.doesNotThrow(() => postToPort(deadPort, RESULT));
  assert.doesNotThrow(() => postToPort(deadPort, EVENT));
});
