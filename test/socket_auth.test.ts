import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { importAuthKey } from '../src/transport/auth_handshake';
import { HandshakeDeps, authenticate } from '../src/transport/socket_auth';
import {
  AuthMethod,
  ErrorCode,
  ProtocolVersion,
  Response,
  SYS_AUTH_BEGIN,
  SYS_AUTH_FINISH,
} from '../src/protocol/envelope';

// The socket handshake against a scripted desktop, with the desktop's own
// known-answer vectors: the nonces, the port and the version each vector names,
// the proofs it lists. A desktop that answers with the vector's `mac_srv` is the
// paired desktop; the extension must send exactly the vector's `mac_cli`.

interface Vector {
  name: string;
  secret: string;
  iid: string;
  client_nonce: string;
  server_nonce: string;
  port: number;
  version: ProtocolVersion;
  server_mac: string;
  client_mac: string;
}

const KAT = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'testdata', 'auth_handshake_vectors.json'),
    'utf8'
  )
) as { vectors: Vector[] };

const FIRST = KAT.vectors[0];
// The vector on another port, with a version that is not this extension's: the
// transcript must take the desktop's version off the answer's envelope.
const OTHER = KAT.vectors.find((v) => v.port === 30114) as Vector;

const hex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'hex'));
const b64 = (s: string): string => Buffer.from(s, 'hex').toString('base64');

type Sent = { method: AuthMethod; params: Record<string, string> };

// A desktop that answers each frame from `script`, recording what it was sent.
function desktop(
  script: Partial<Record<AuthMethod, (p: Record<string, string>) => object>>,
  v: ProtocolVersion
): { sent: Sent[]; request: HandshakeDeps['request'] } {
  const sent: Sent[] = [];
  return {
    sent,
    request: (method, params) => {
      sent.push({ method, params });
      const answer = script[method];
      assert.ok(answer, `the desktop was not expecting ${method}`);
      return Promise.resolve({
        v,
        iid: 'x',
        rid: 'r',
        ...answer(params),
      } as Response);
    },
  };
}

const ok = (result: object) => ({ ok: true, result });
const err = (code: number, message = 'refused') => ({
  ok: false,
  error: { code, message },
});

// The paired desktop of vector `vec`: its begin answer, and a finish that
// accepts exactly the vector's client proof.
const pairedDesktop = (vec: Vector) =>
  desktop(
    {
      [SYS_AUTH_BEGIN]: () =>
        ok({ ns: b64(vec.server_nonce), mac: b64(vec.server_mac) }),
      [SYS_AUTH_FINISH]: (p) =>
        p.mac === b64(vec.client_mac)
          ? ok({ authenticated: true })
          : err(ErrorCode.Unauthorized, 'the handshake did not verify'),
    },
    vec.version
  );

async function depsFor(
  vec: Vector,
  request: HandshakeDeps['request'],
  extra: Partial<HandshakeDeps> = {}
): Promise<HandshakeDeps> {
  return {
    request,
    key: await importAuthKey(hex(vec.secret)),
    iid: vec.iid,
    port: vec.port,
    nonce: () => hex(vec.client_nonce),
    ...extra,
  };
}

test('the paired desktop: begin with our nonce, its proof checked, our proof is the vector’s', async () => {
  for (const vec of [FIRST, OTHER]) {
    const d = pairedDesktop(vec);
    const out = await authenticate(await depsFor(vec, d.request));
    assert.deepEqual(out, { kind: 'authenticated' }, vec.name);
    assert.deepEqual(d.sent, [
      { method: SYS_AUTH_BEGIN, params: { nc: b64(vec.client_nonce) } },
      { method: SYS_AUTH_FINISH, params: { mac: b64(vec.client_mac) } },
    ]);
  }
});

test('the begin names the dApp that waits on it, and only a short enough one', async () => {
  const origin = 'https://app.example';
  let d = pairedDesktop(FIRST);
  await authenticate(await depsFor(FIRST, d.request, { origin }));
  assert.deepEqual(d.sent[0].params, { nc: b64(FIRST.client_nonce), origin });

  for (const skipped of ['', 'https://' + 'a'.repeat(250)]) {
    d = pairedDesktop(FIRST);
    await authenticate(await depsFor(FIRST, d.request, { origin: skipped }));
    assert.deepEqual(d.sent[0].params, { nc: b64(FIRST.client_nonce) });
  }
  // 256 bytes exactly still goes.
  const at = 'https://' + 'a'.repeat(248);
  d = pairedDesktop(FIRST);
  await authenticate(await depsFor(FIRST, d.request, { origin: at }));
  assert.equal(d.sent[0].params.origin, at);
});

test('a desktop proof that does not verify is a possible interception: our proof never goes out', async () => {
  const flipped = hex(FIRST.server_mac);
  flipped[31] ^= 1;
  const cases: Array<[string, Partial<HandshakeDeps>, string]> = [
    ['a flipped bit', {}, Buffer.from(flipped).toString('hex')],
    // The real desktop's proof relayed from another port.
    ['another port', { port: FIRST.port + 1 }, FIRST.server_mac],
    ['another instance', { iid: OTHER.iid }, FIRST.server_mac],
  ];
  for (const [name, extra, mac] of cases) {
    const d = desktop(
      {
        [SYS_AUTH_BEGIN]: () =>
          ok({ ns: b64(FIRST.server_nonce), mac: b64(mac) }),
      },
      FIRST.version
    );
    const out = await authenticate(await depsFor(FIRST, d.request, extra));
    assert.deepEqual(out, { kind: 'failed', failure: 'interception' }, name);
    assert.equal(d.sent.length, 1, `${name}: only the begin went out`);
  }
});

test('the transcript takes the version off the answer’s envelope, not this extension’s', async () => {
  // The first vector's proof, answered under another version: it must not pass.
  const d = desktop(
    {
      [SYS_AUTH_BEGIN]: () =>
        ok({ ns: b64(FIRST.server_nonce), mac: b64(FIRST.server_mac) }),
    },
    { ...FIRST.version, minor: FIRST.version.minor + 2 }
  );
  const out = await authenticate(await depsFor(FIRST, d.request));
  assert.deepEqual(out, { kind: 'failed', failure: 'interception' });
});

test('each begin refusal the desktop names leaves the socket usable, with its reason', async () => {
  const table: Array<[number, string]> = [
    [ErrorCode.WalletLocked, 'locked'],
    [ErrorCode.NotPaired, 'not-paired'],
    [ErrorCode.UserRejected, 'unlock-skipped'],
    [ErrorCode.Internal, 'desktop-error'],
    [ErrorCode.UnsupportedMethod, 'unsupported'],
    [ErrorCode.VersionIncompatible, 'incompatible'],
  ];
  for (const [code, reason] of table) {
    const d = desktop(
      { [SYS_AUTH_BEGIN]: () => err(code, `m${code}`) },
      FIRST.version
    );
    const out = await authenticate(await depsFor(FIRST, d.request));
    assert.deepEqual(out, {
      kind: 'refused',
      reason,
      error: { code, message: `m${code}` },
    });
    assert.equal(d.sent.length, 1);
  }
});

test('any other begin refusal means the two sides disagree about the socket', async () => {
  for (const code of [ErrorCode.MalformedRequest, ErrorCode.Unauthorized, 7]) {
    const d = desktop({ [SYS_AUTH_BEGIN]: () => err(code) }, FIRST.version);
    const out = await authenticate(await depsFor(FIRST, d.request));
    assert.equal(out.kind, 'failed');
    assert.equal(out.kind === 'failed' && out.failure, 'bad-answer');
  }
});

test('a begin answer that is not the wire’s shape fails before any proof is checked or sent', async () => {
  const ns = b64(FIRST.server_nonce);
  const mac = b64(FIRST.server_mac);
  const bad: Array<[string, object, ProtocolVersion | undefined]> = [
    ['short nonce', { ns: b64('00'.repeat(15)), mac }, FIRST.version],
    ['short mac', { ns, mac: b64('00'.repeat(31)) }, FIRST.version],
    ['unpadded mac', { ns, mac: mac.replace(/=+$/, '') }, FIRST.version],
    ['numeric nonce', { ns: 7, mac }, FIRST.version],
    ['no version', { ns, mac }, undefined],
  ];
  for (const [name, result, v] of bad) {
    const d = desktop(
      { [SYS_AUTH_BEGIN]: () => ok(result) },
      v as ProtocolVersion
    );
    const out = await authenticate(await depsFor(FIRST, d.request));
    assert.deepEqual(out, { kind: 'failed', failure: 'bad-answer' }, name);
    assert.equal(d.sent.length, 1, name);
  }
});

test('the finish: locked or unpaired meanwhile is a refusal; a refused proof or anything else fails', async () => {
  const finishWith = (answer: object) =>
    desktop(
      {
        [SYS_AUTH_BEGIN]: () =>
          ok({ ns: b64(FIRST.server_nonce), mac: b64(FIRST.server_mac) }),
        [SYS_AUTH_FINISH]: () => answer,
      },
      FIRST.version
    );
  const run = async (answer: object) =>
    authenticate(await depsFor(FIRST, finishWith(answer).request));

  assert.deepEqual(await run(err(ErrorCode.WalletLocked, 'l')), {
    kind: 'refused',
    reason: 'locked',
    error: { code: ErrorCode.WalletLocked, message: 'l' },
  });
  assert.deepEqual(await run(err(ErrorCode.NotPaired, 'n')), {
    kind: 'refused',
    reason: 'not-paired',
    error: { code: ErrorCode.NotPaired, message: 'n' },
  });
  assert.deepEqual(await run(err(ErrorCode.Unauthorized, 'u')), {
    kind: 'failed',
    failure: 'proof-refused',
    error: { code: ErrorCode.Unauthorized, message: 'u' },
  });
  assert.deepEqual(await run(err(ErrorCode.MalformedRequest, 'x')), {
    kind: 'failed',
    failure: 'bad-answer',
    error: { code: ErrorCode.MalformedRequest, message: 'x' },
  });
  for (const result of [{}, { authenticated: 'true' }, { authenticated: 1 }]) {
    assert.deepEqual(await run(ok(result)), {
      kind: 'failed',
      failure: 'bad-answer',
    });
  }
});

test('a round trip that never answers rejects the handshake', async () => {
  const deps = await depsFor(FIRST, () =>
    Promise.reject(new Error('transport disconnected'))
  );
  await assert.rejects(authenticate(deps), /transport disconnected/);
});

test('without an injected nonce each begin carries a fresh 16-byte one', async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const d = desktop(
      { [SYS_AUTH_BEGIN]: () => err(ErrorCode.WalletLocked) },
      FIRST.version
    );
    await authenticate(await depsFor(FIRST, d.request, { nonce: undefined }));
    const nc = d.sent[0].params.nc;
    assert.equal(Buffer.from(nc, 'base64').length, 16);
    seen.add(nc);
  }
  assert.equal(seen.size, 3);
});
