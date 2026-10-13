import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { importAuthKey } from '../src/transport/auth_handshake';
import { PairEphemeral } from '../src/transport/pair_handshake';
import {
  PairingDeps,
  PairingFlow,
  PairingOutcome,
} from '../src/transport/pairing_flow';
import { PairRelayAnswer } from '../src/protocol/bridge';
import {
  ErrorCode,
  ProtocolVersion,
  Response,
  SYS_PAIR_BEGIN,
  SYS_PAIR_FINISH,
} from '../src/protocol/envelope';

// The pairing flow against a stub desktop that answers with the desktop app's
// exact bodies: sys_pair_begin {epk, nc, origin?} -> {epk, ns}, then
// sys_pair_finish {mac} -> {mac}, every byte string standard base64 with
// padding. With the vectors' fixed keys and nonces the frames the flow writes
// must be the vectors' to the byte.

interface Vector {
  iid: string;
  client_private: string;
  client_public: string;
  server_public: string;
  client_nonce: string;
  server_nonce: string;
  port: number;
  version: ProtocolVersion;
  code: string;
  secret: string;
  mac_cli: string;
  mac_srv: string;
}

const KAT = JSON.parse(
  readFileSync(path.join(__dirname, 'testdata', 'pair_vectors.json'), 'utf8')
) as { vectors: Vector[]; code_from_entropy: { grouped: string }[] };

const V = KAT.vectors[0];
const GROUPED = KAT.code_from_entropy[0].grouped; // V.code as the desktop shows it

const hex = (s: string): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  }
  return out;
};
const b64 = (h: string): string => Buffer.from(hex(h)).toString('base64');

const fixedEphemeral = async (): Promise<PairEphemeral> => ({
  privateKey: await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'OKP',
      crv: 'X25519',
      d: Buffer.from(hex(V.client_private)).toString('base64url'),
      x: Buffer.from(hex(V.client_public)).toString('base64url'),
    },
    { name: 'X25519' },
    false,
    ['deriveBits']
  ),
  publicKey: hex(V.client_public),
});

type Call = { method: string; params: Record<string, string> };
type Handler = (call: Call) => PairRelayAnswer | Promise<PairRelayAnswer>;

const answer = (
  body: { result: unknown } | { error: { code: number; message: string } },
  over: { v?: unknown; port?: number; iid?: string } = {}
): PairRelayAnswer => ({
  iid: over.iid ?? V.iid,
  port: over.port ?? V.port,
  response: {
    v: over.v ?? V.version,
    iid: over.iid ?? V.iid,
    rid: 'rid',
    ok: 'result' in body,
    ...body,
  } as Response,
});

const BEGIN_OK = answer({
  result: { epk: b64(V.server_public), ns: b64(V.server_nonce) },
});
const FINISH_OK = answer({ result: { mac: b64(V.mac_srv) } });
const fail = (code: number, message = 'refused'): PairRelayAnswer =>
  answer({ error: { code, message } });

// A stub desktop: each frame is recorded and answered by the next handler.
function harness(handlers: Handler[]): {
  flow: PairingFlow;
  calls: Call[];
  saved: { iid: string; key: CryptoKey }[];
  deps: PairingDeps;
} {
  const calls: Call[] = [];
  const saved: { iid: string; key: CryptoKey }[] = [];
  const deps: PairingDeps = {
    relay: async (method, params) => {
      const call = { method, params };
      calls.push(call);
      const h = handlers.shift();
      assert.ok(h, `an unexpected frame: ${method}`);
      return h(call);
    },
    saveKey: (iid, key) => {
      saved.push({ iid, key });
      return Promise.resolve();
    },
    ephemeral: fixedEphemeral,
    nonce: () => hex(V.client_nonce),
  };
  return { flow: new PairingFlow(deps), calls, saved, deps };
}

const PROBE = new TextEncoder().encode('probe');
const signs = async (k: CryptoKey): Promise<string> =>
  Buffer.from(await crypto.subtle.sign('HMAC', k, PROBE)).toString('hex');

test('a pairing writes the desktop’s exact frames and keeps the derived key', async () => {
  const h = harness([() => BEGIN_OK, () => FINISH_OK]);
  assert.deepEqual(await h.flow.begin(), { kind: 'enter-code' });
  assert.deepEqual(h.calls[0], {
    method: SYS_PAIR_BEGIN,
    params: { epk: b64(V.client_public), nc: b64(V.client_nonce) },
  });
  // Typed as a person would: lower case, grouped.
  assert.deepEqual(await h.flow.submit(GROUPED.toLowerCase()), {
    kind: 'paired',
  });
  assert.deepEqual(h.calls[1], {
    method: SYS_PAIR_FINISH,
    params: { mac: b64(V.mac_cli) },
  });
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].iid, V.iid);
  assert.equal(h.saved[0].key.extractable, false);
  assert.equal(
    await signs(h.saved[0].key),
    await signs(await importAuthKey(hex(V.secret)))
  );
  // One finish per begin.
  assert.deepEqual(await h.flow.submit(GROUPED), {
    kind: 'failed',
    failure: 'no-attempt',
  });
});

test('the transcript takes the version from the answer’s envelope and the port the frame went out on', async () => {
  // Another minor in the answer's `v`: the desktop's confirmation (made over
  // the version it runs) no longer verifies, as the vectors' binding shows.
  const h = harness([
    () =>
      answer(
        { result: { epk: b64(V.server_public), ns: b64(V.server_nonce) } },
        { v: { ...V.version, minor: V.version.minor + 1 } }
      ),
    () => FINISH_OK,
  ]);
  await h.flow.begin();
  const out = await h.flow.submit(V.code);
  assert.deepEqual(out, { kind: 'failed', failure: 'interception' });
  assert.notEqual(h.calls[1].params.mac, b64(V.mac_cli));
  assert.equal(h.saved.length, 0);

  const p = harness([
    () =>
      answer(
        { result: { epk: b64(V.server_public), ns: b64(V.server_nonce) } },
        { port: V.port + 1 }
      ),
    () => answer({ result: { mac: b64(V.mac_srv) } }, { port: V.port + 1 }),
  ]);
  await p.flow.begin();
  assert.deepEqual(await p.flow.submit(V.code), {
    kind: 'failed',
    failure: 'interception',
  });
  assert.notEqual(p.calls[1].params.mac, b64(V.mac_cli));
});

test('the dApp that started a pairing rides as a label hint, and an over-long one is left out', async () => {
  const h = harness([() => BEGIN_OK]);
  await h.flow.begin('https://app.example');
  assert.equal(h.calls[0].params.origin, 'https://app.example');

  const long = harness([() => BEGIN_OK]);
  await long.flow.begin(`https://${'a'.repeat(250)}`);
  assert.equal('origin' in long.calls[0].params, false);
});

test('a typo is caught here: nothing is sent and the attempt stays', async () => {
  const h = harness([() => BEGIN_OK, () => FINISH_OK]);
  await h.flow.begin();
  const typo = `${V.code.slice(0, 15)}G`;
  assert.deepEqual(await h.flow.submit(typo), {
    kind: 'bad-code',
    reason: 'check',
  });
  assert.deepEqual(await h.flow.submit('5PCT'), {
    kind: 'bad-code',
    reason: 'length',
  });
  assert.deepEqual(await h.flow.submit(`${V.code.slice(0, 15)}U`), {
    kind: 'bad-code',
    reason: 'character',
  });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(await h.flow.submit(V.code), { kind: 'paired' });
});

test('a desktop confirmation that does not verify is an interception: nothing kept, the attempt is spent', async () => {
  const bad = hex(V.mac_srv);
  bad[0] ^= 1;
  const h = harness([
    () => BEGIN_OK,
    () => answer({ result: { mac: Buffer.from(bad).toString('base64') } }),
  ]);
  await h.flow.begin();
  assert.deepEqual(await h.flow.submit(V.code), {
    kind: 'failed',
    failure: 'interception',
  });
  assert.equal(h.saved.length, 0);
  assert.deepEqual(await h.flow.submit(V.code), {
    kind: 'failed',
    failure: 'no-attempt',
  });
});

test('a code the desktop refuses spends the attempt; Try again begins anew with a fresh key', async () => {
  let ephemerals = 0;
  const h = harness([
    () => BEGIN_OK,
    () => fail(ErrorCode.Unauthorized, 'the code did not match'),
    () => BEGIN_OK,
  ]);
  h.deps.ephemeral = () => {
    ephemerals += 1;
    return fixedEphemeral();
  };
  await h.flow.begin();
  assert.deepEqual(await h.flow.submit(V.code), {
    kind: 'failed',
    failure: 'refused',
    message: 'the code did not match',
  });
  assert.equal(h.saved.length, 0);
  assert.deepEqual(await h.flow.submit(V.code), {
    kind: 'failed',
    failure: 'no-attempt',
  });
  assert.deepEqual(await h.flow.begin(), { kind: 'enter-code' });
  assert.equal(h.calls[2].method, SYS_PAIR_BEGIN);
  assert.equal(ephemerals, 2);
});

test('each sys_pair_begin error names its cause, and leaves no attempt', async () => {
  const table: [number, string][] = [
    [ErrorCode.MalformedRequest, 'malformed'],
    [ErrorCode.RequestPending, 'busy'],
    [ErrorCode.NotPaired, 'cooldown'],
    [ErrorCode.WalletLocked, 'locked'],
    [ErrorCode.UserRejected, 'unlock-skipped'],
    [ErrorCode.Internal, 'desktop-error'],
    [ErrorCode.UnsupportedMethod, 'unsupported'],
    [ErrorCode.VersionIncompatible, 'incompatible'],
    [ErrorCode.Disconnected, 'desktop-error'],
  ];
  for (const [code, failure] of table) {
    const h = harness([() => fail(code, `message ${code}`)]);
    assert.deepEqual(
      await h.flow.begin(),
      { kind: 'failed', failure, message: `message ${code}` },
      String(code)
    );
    assert.deepEqual(await h.flow.submit(V.code), {
      kind: 'failed',
      failure: 'no-attempt',
    });
    assert.equal(h.calls.length, 1, String(code));
  }
});

test('each sys_pair_finish error names its cause and keeps nothing', async () => {
  const table: [number, string, string][] = [
    [ErrorCode.Unauthorized, 'refused', 'the pairing code expired'],
    [
      ErrorCode.Unauthorized,
      'refused',
      'no pairing is in progress for this instance',
    ],
    [ErrorCode.WalletLocked, 'locked', 'wallet is locked'],
    [ErrorCode.MalformedRequest, 'malformed', 'bad body'],
    [ErrorCode.Internal, 'desktop-error', 'internal'],
  ];
  for (const [code, failure, message] of table) {
    const h = harness([() => BEGIN_OK, () => fail(code, message)]);
    await h.flow.begin();
    assert.deepEqual(
      await h.flow.submit(V.code),
      { kind: 'failed', failure, message },
      message
    );
    assert.equal(h.saved.length, 0, message);
  }
});

test('a malformed begin answer is refused before anything is derived', async () => {
  const good = { epk: b64(V.server_public), ns: b64(V.server_nonce) };
  const unpadded = good.epk.replace(/=+$/, '');
  const bodies: [string, unknown, unknown?][] = [
    ['no result', undefined],
    ['no epk', { ns: good.ns }],
    ['no ns', { epk: good.epk }],
    ['a short epk', { ...good, epk: Buffer.alloc(31).toString('base64') }],
    ['a long ns', { ...good, ns: Buffer.alloc(17).toString('base64') }],
    ['unpadded base64', { ...good, epk: unpadded }],
    ['url-safe base64', { ...good, epk: good.epk.replace(/\+/g, '-') }],
    ['a numeric epk', { ...good, epk: 7 }],
    ['no version', good, null],
    ['a version past u16', good, { wallet: 2, major: 2, minor: 70000 }],
  ];
  for (const [name, result, v] of bodies) {
    const h = harness([
      () =>
        answer(
          { result },
          v === undefined ? {} : { v: v === null ? undefined : v }
        ),
    ]);
    if (v === null) {
      // `answer` fills a missing version in; take it out again.
      h.deps.relay = () => {
        const a = answer({ result });
        delete (a.response as { v?: unknown }).v;
        return Promise.resolve(a);
      };
      h.flow = new PairingFlow(h.deps);
    }
    assert.deepEqual(
      await h.flow.begin(),
      { kind: 'failed', failure: 'bad-answer' },
      name
    );
  }
});

test('a desktop key of small order is refused and no confirmation leaves', async () => {
  const h = harness([
    () =>
      answer({
        result: {
          epk: Buffer.alloc(32).toString('base64'),
          ns: b64(V.server_nonce),
        },
      }),
  ]);
  await h.flow.begin();
  assert.deepEqual(await h.flow.submit(V.code), {
    kind: 'failed',
    failure: 'bad-answer',
  });
  assert.equal(h.calls.length, 1);
});

test('a finish answered over another socket or for another instance keeps nothing', async () => {
  for (const over of [
    { port: V.port + 1 },
    { iid: `${V.iid.slice(0, 35)}0` },
  ]) {
    const h = harness([
      () => BEGIN_OK,
      () => answer({ result: { mac: b64(V.mac_srv) } }, over),
    ]);
    await h.flow.begin();
    assert.deepEqual(await h.flow.submit(V.code), {
      kind: 'failed',
      failure: 'connection-changed',
    });
    assert.equal(h.saved.length, 0);
  }
});

test('a malformed finish answer keeps nothing', async () => {
  for (const result of [undefined, {}, { mac: 'AAAA' }, { mac: 5 }]) {
    const h = harness([() => BEGIN_OK, () => answer({ result })]);
    await h.flow.begin();
    assert.deepEqual(await h.flow.submit(V.code), {
      kind: 'failed',
      failure: 'bad-answer',
    });
    assert.equal(h.saved.length, 0);
  }
});

test('a transport failure is "unreachable", and a failed finish spends the attempt', async () => {
  const down = harness([
    () => {
      throw new Error('cannot reach the AirNox Wallet desktop app');
    },
  ]);
  assert.deepEqual(await down.flow.begin(), {
    kind: 'failed',
    failure: 'unreachable',
  });

  const drop = harness([
    () => BEGIN_OK,
    () => {
      throw new Error('transport disconnected');
    },
  ]);
  await drop.flow.begin();
  assert.deepEqual(await drop.flow.submit(V.code), {
    kind: 'failed',
    failure: 'unreachable',
  });
  assert.deepEqual(await drop.flow.submit(V.code), {
    kind: 'failed',
    failure: 'no-attempt',
  });
});

test('a key that cannot be stored is reported, never claimed as paired', async () => {
  const h = harness([() => BEGIN_OK, () => FINISH_OK]);
  h.deps.saveKey = () => Promise.reject(new Error('quota'));
  await h.flow.begin();
  const out: PairingOutcome = await h.flow.submit(V.code);
  assert.deepEqual(out, { kind: 'failed', failure: 'not-saved' });
});
