import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PortLike, PortRelay } from '../src/content/port_relay';
import { PortFrame, PortHello } from '../src/protocol/bridge';

// A fake runtime port that records posted frames and lets the test fire the
// onMessage / onDisconnect callbacks (standing in for the SW / Chrome).
class FakePort implements PortLike {
  posted: unknown[] = [];
  private msgCb?: (frame: PortFrame) => void;
  private discCb?: () => void;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  onMessage = {
    addListener: (cb: (frame: PortFrame) => void): void => {
      this.msgCb = cb;
    },
  };
  onDisconnect = {
    addListener: (cb: () => void): void => {
      this.discCb = cb;
    },
  };

  fireMessage(frame: PortFrame): void {
    this.msgCb?.(frame);
  }
  fireDisconnect(): void {
    this.discCb?.();
  }
}

const HELLO: PortHello = { kind: 'hello', origin: 'https://a.app' };

test('PortRelay: ensure() connects lazily, sends hello, then forwards + receives', () => {
  const ports: FakePort[] = [];
  const frames: PortFrame[] = [];
  let disconnects = 0;
  const relay = new PortRelay(
    () => {
      const p = new FakePort();
      ports.push(p);
      return p;
    },
    (f) => frames.push(f),
    () => {
      disconnects += 1;
    },
    () => HELLO
  );

  relay.ensure();
  assert.equal(ports.length, 1);
  assert.deepEqual(ports[0].posted[0], HELLO); // hello sent on connect

  assert.equal(relay.send({ kind: 'rpc', id: '1' }), true);
  assert.deepEqual(ports[0].posted[1], { kind: 'rpc', id: '1' });

  // An incoming frame reaches the onFrame handler.
  ports[0].fireMessage({ kind: 'rpc-result', id: '1', ok: true });
  assert.equal(frames.length, 1);
  assert.equal(disconnects, 0);
});

test('PortRelay: reconnects on disconnect + re-sends hello (MV3 SW eviction)', () => {
  const ports: FakePort[] = [];
  let disconnects = 0;
  const relay = new PortRelay(
    () => {
      const p = new FakePort();
      ports.push(p);
      return p;
    },
    () => undefined,
    () => {
      disconnects += 1;
    },
    () => HELLO
  );

  relay.ensure();
  // The service worker is evicted → the port disconnects.
  ports[0].fireDisconnect();
  assert.equal(disconnects, 1); // the page is told to reject in-flight requests

  // The next send must RECONNECT (a fresh port), re-send hello, then forward —
  // this is exactly the path that was broken (a dead port silently dropped it).
  assert.equal(relay.send({ kind: 'rpc', id: '2' }), true);
  assert.equal(ports.length, 2); // a new port was created
  assert.deepEqual(ports[1].posted[0], HELLO); // hello re-registered the origin
  assert.deepEqual(ports[1].posted[1], { kind: 'rpc', id: '2' });
});

test('PortRelay: send() returns false when the extension context is invalidated', () => {
  let frames = 0;
  const relay = new PortRelay(
    () => {
      throw new Error('Extension context invalidated');
    },
    () => {
      frames += 1;
    },
    () => undefined,
    () => HELLO
  );

  assert.equal(relay.send({ kind: 'rpc', id: '3' }), false);
  assert.equal(frames, 0);
  // ensure() also yields null (no live port) without throwing.
  assert.equal(relay.ensure(), null);
});
