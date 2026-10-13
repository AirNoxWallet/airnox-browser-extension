import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_TO_PAGE, PAGE_TO_CONTENT } from '../src/protocol/bridge';
import { ErrorCode } from '../src/protocol/envelope';
import { PostMessageTransport } from '../src/inpage/transport';
import { ProviderRpcError } from '../src/inpage/rpc_error';

// PostMessageTransport reads the main-world `window` in its constructor. Node has
// none, so stub it: capture the 'message' listener, record outbound postMessages,
// and deliver inbound frames as if from the page (source === window).
type MessageListener = (event: { source: unknown; data: unknown }) => void;

class WindowStub {
  private listener?: MessageListener;
  readonly sent: Array<{ id?: string; ns?: string; method?: string }> = [];

  addEventListener(type: string, cb: MessageListener): void {
    if (type === 'message') {
      this.listener = cb;
    }
  }
  postMessage(msg: { id?: string; ns?: string; method?: string }): void {
    this.sent.push(msg);
  }
  deliver(data: unknown): void {
    this.listener?.({ source: this, data });
  }
}

// Run `fn` with `globalThis.window` set to `stub`, restoring it afterwards so the
// stub never leaks into other test files (which expect no window).
function withWindow<T>(stub: WindowStub, fn: () => T): T {
  const g = globalThis as { window?: unknown };
  const prev = g.window;
  g.window = stub;
  try {
    return fn();
  } finally {
    g.window = prev;
  }
}

test('a push is delivered to EVERY registered event handler (shared transport)', () => {
  const stub = new WindowStub();
  withWindow(stub, () => {
    const t = new PostMessageTransport();
    const a: string[] = [];
    const b: string[] = [];
    t.onEvent((ns, event) => a.push(`${ns}:${event}`));
    t.onEvent((ns, event) => b.push(`${ns}:${event}`));

    stub.deliver({
      channel: CONTENT_TO_PAGE,
      ns: 'evm',
      event: 'accountsChanged',
      data: [],
    });

    // Both handlers fire — this is what lets one transport serve all providers.
    assert.deepEqual(a, ['evm:accountsChanged']);
    assert.deepEqual(b, ['evm:accountsChanged']);
  });
});

test('a ns-less push is dropped (fail closed)', () => {
  const stub = new WindowStub();
  withWindow(stub, () => {
    const t = new PostMessageTransport();
    let count = 0;
    t.onEvent(() => count++);
    stub.deliver({ channel: CONTENT_TO_PAGE, event: 'accountsChanged' });
    assert.equal(count, 0);
  });
});

test('a response resolves the send with the matching id', async () => {
  const stub = new WindowStub();
  const result = await withWindow(stub, () => {
    const t = new PostMessageTransport();
    const pending = t.send('evm', 'eth_chainId', []);
    const id = stub.sent[0].id;
    assert.equal(stub.sent[0].ns, 'evm');
    stub.deliver({ channel: CONTENT_TO_PAGE, id, ok: true, result: '0x1' });
    return pending;
  });
  assert.equal(result, '0x1');
});

test('a wire error rejects the send with the ProviderRpcError code', async () => {
  const stub = new WindowStub();
  await withWindow(stub, async () => {
    const t = new PostMessageTransport();
    const pending = t.send('evm', 'eth_requestAccounts', []);
    const id = stub.sent[0].id;
    stub.deliver({
      channel: CONTENT_TO_PAGE,
      id,
      ok: false,
      error: { code: ErrorCode.UserRejected, message: 'user rejected' },
    });
    await assert.rejects(
      () => pending,
      (e: unknown) => {
        assert.equal((e as ProviderRpcError).code, ErrorCode.UserRejected);
        return true;
      }
    );
  });
});

test('a disconnect rejects all in-flight requests', async () => {
  const stub = new WindowStub();
  await withWindow(stub, async () => {
    const t = new PostMessageTransport();
    const a = t.send('evm', 'eth_call', []);
    const b = t.send('wstd', 'standard:connect', {});
    stub.deliver({ channel: CONTENT_TO_PAGE, disconnect: true });
    await assert.rejects(
      () => a,
      (e: unknown) => {
        assert.equal((e as ProviderRpcError).code, ErrorCode.Disconnected);
        assert.equal((e as Error).message, 'AirNox extension disconnected');
        return true;
      }
    );
    await assert.rejects(
      () => b,
      (e: unknown) => {
        assert.equal((e as ProviderRpcError).code, ErrorCode.Disconnected);
        return true;
      }
    );
  });
});

test('the send frame is tagged for the content script', () => {
  const stub = new WindowStub();
  withWindow(stub, () => {
    const t = new PostMessageTransport();
    void t.send('tron', 'tron_requestAccounts', undefined);
    const sent = stub.sent[0] as { channel?: string; method?: string };
    assert.equal(sent.channel, PAGE_TO_CONTENT);
    assert.equal(sent.method, 'tron_requestAccounts');
  });
});
