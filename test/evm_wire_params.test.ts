import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toWireParams } from '../src/protocol/evm_wire_params';

// The desktop reads NAMED keys for the methods it confirms and refuses anything
// else with 1100. Until this mapping existed every eth_sendTransaction reached a
// real desktop as `transaction params must be an object`.
test('eth_sendTransaction unwraps the positional transaction object', () => {
  const tx = { from: '0xaa', to: '0xbb', value: '0x0', data: '0x095ea7b3' };
  assert.deepEqual(toWireParams('eth_sendTransaction', [tx]), tx);
});

test('personal_sign names [message, address]', () => {
  assert.deepEqual(toWireParams('personal_sign', ['0x68656c6c6f', '0xaa']), {
    address: '0xaa',
    message: '0x68656c6c6f',
  });
});

// The wire carries personal_sign's message as 0x-hex bytes: the desktop's
// signing service hex-decodes it and refuses anything
// else with "personal_sign message is not valid hex", AFTER the user pressed
// Sign. EIP-1193 dApps commonly pass the challenge as plain UTF-8 text, as
// MetaMask accepts it; testnet.soniclabs.com's faucet does, and could not claim
// through this wallet at all. A plain-text message is
// therefore sent as the hex of its UTF-8 bytes — the same bytes MetaMask signs.
test('personal_sign sends a plain-text message as the hex of its UTF-8 bytes', () => {
  const challenge =
    'Please sign following text to obtain 10 Sonic tokens:\n\n0x08a45d90';
  assert.deepEqual(toWireParams('personal_sign', [challenge, '0xaa']), {
    address: '0xaa',
    message: '0x' + Buffer.from(challenge, 'utf8').toString('hex'),
  });
});

test('personal_sign encodes non-ASCII text as UTF-8, not UTF-16', () => {
  assert.deepEqual(toWireParams('personal_sign', ['h\u00e9 \u2713', '0xaa']), {
    address: '0xaa',
    message: '0x68c3a920e29c93',
  });
});

// A string that IS a 0x byte string is the dApp's bytes, as MetaMask reads it;
// anything that only looks like one (odd length, a non-hex digit) is text.
test('personal_sign keeps a 0x-hex message as bytes and reads look-alikes as text', () => {
  assert.equal(
    (
      toWireParams('personal_sign', ['0xDEADbeef', '0xaa']) as {
        message: string;
      }
    ).message,
    '0xDEADbeef'
  );
  assert.equal(
    (toWireParams('personal_sign', ['0x', '0xaa']) as { message: string })
      .message,
    '0x'
  );
  assert.equal(
    (toWireParams('personal_sign', ['0xabc', '0xaa']) as { message: string })
      .message,
    '0x307861626' + '3'
  );
  assert.equal(
    (toWireParams('personal_sign', ['0xmsg', '0xaa']) as { message: string })
      .message,
    '0x30786d7367'
  );
});

// A non-string message is not ours to stringify: the desktop refuses it by name.
test('personal_sign leaves a non-string message for the desktop to refuse', () => {
  assert.deepEqual(toWireParams('personal_sign', [42, '0xaa']), {
    address: '0xaa',
    message: 42,
  });
});

test('eth_signTypedData_v4 names [address, typedData]', () => {
  assert.deepEqual(
    toWireParams('eth_signTypedData_v4', ['0xaa', '{"domain":{}}']),
    { address: '0xaa', typedData: '{"domain":{}}' }
  );
});

test('eth_signTypedData_v4 serialises typed data handed over as an object', () => {
  const typed = { domain: { chainId: 1 }, message: { a: 1 } };
  assert.deepEqual(toWireParams('eth_signTypedData_v4', ['0xaa', typed]), {
    address: '0xaa',
    typedData: JSON.stringify(typed),
  });
});

// EIP-3326 / EIP-3085 are positional on the wire too: the desktop's switch-chain
// and add-chain handlers read params[0]. Reshaping them would break what works.
test('the chain methods keep their positional shape', () => {
  const args = [{ chainId: '0xaa36a7' }];
  assert.equal(toWireParams('wallet_switchEthereumChain', args), args);
  assert.equal(toWireParams('wallet_addEthereumChain', args), args);
});

test('EIP-747 wallet_watchAsset is already an object and is untouched', () => {
  const asset = { type: 'ERC20', options: { address: '0xcc' } };
  assert.equal(toWireParams('wallet_watchAsset', asset), asset);
});

test('an unnamed method is not given an invented shape', () => {
  const args = ['a', 'b'];
  assert.equal(toWireParams('eth_getBalance', args), args);
});

// A malformed call must be refused BY THE DESKTOP, with its own error code,
// rather than turned into a plausible-looking frame here.
test('a malformed call passes through for the desktop to refuse', () => {
  assert.deepEqual(toWireParams('eth_sendTransaction', []), []);
  assert.equal(toWireParams('eth_sendTransaction', undefined), undefined);
  assert.deepEqual(toWireParams('personal_sign', ['0x68656c6c6f']), [
    '0x68656c6c6f',
  ]);
});
