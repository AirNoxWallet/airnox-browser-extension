import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectString, expectStringField } from '../src/inpage/expect_string';
import { ErrorCode } from '../src/protocol/envelope';

function code(e: unknown): number | undefined {
  return (e as { code?: number }).code;
}

test('expectString returns a string value unchanged', () => {
  assert.equal(expectString('0xsig', 'm'), '0xsig');
});

test('expectString throws Internal on a non-string, naming the method + what', () => {
  assert.throws(
    () => expectString(42, 'solana:signMessage', 'signature'),
    (e: unknown) => {
      assert.equal(code(e), ErrorCode.Internal);
      assert.match(
        (e as Error).message,
        /solana:signMessage: the wallet returned a non-string signature/
      );
      return true;
    }
  );
  // default `what` is "result"
  assert.throws(
    () => expectString(null, 'tron_sign'),
    (e: unknown) => /non-string result/.test((e as Error).message)
  );
});

test('expectStringField extracts a string field from an object result', () => {
  assert.equal(
    expectStringField({ bytes: 'b64', signature: 'sig' }, 'signature', 'm'),
    'sig'
  );
});

test('expectStringField throws Internal on a non-object result', () => {
  assert.throws(
    () => expectStringField('nope', 'signature', 'sui:signTransaction'),
    (e: unknown) => {
      assert.equal(code(e), ErrorCode.Internal);
      assert.match((e as Error).message, /non-object result/);
      return true;
    }
  );
});

test('expectStringField throws Internal on a missing / non-string field', () => {
  assert.throws(
    () => expectStringField({ bytes: 'b' }, 'signature', 'sui:signTransaction'),
    (e: unknown) => {
      assert.equal(code(e), ErrorCode.Internal);
      assert.match((e as Error).message, /non-string 'signature'/);
      return true;
    }
  );
});
