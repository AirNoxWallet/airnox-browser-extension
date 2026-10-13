// EIP-1193 argument arrays → the v2 wire's per-method `params` shape.
//
// The dApp-facing standards are positional: `eth_sendTransaction` takes
// `[txObject]`, `personal_sign` takes `[message, address]`. The desktop
// dispatcher is not — it reads NAMED keys off an object for the methods it
// confirms, and refuses anything else with 1100 MalformedRequest. Its own
// comments name this translation as ours to do ("The extension maps the
// positional [txObject] to this object", "The extension maps the EIP-1193 args
// to these keys"), and until this module existed nobody did it: every
// eth_sendTransaction from a page reached a real desktop as
// `transaction params must be an object` and could not be sent at all.
//
// Not every method translates. EIP-3326 / EIP-3085 are positional ON THE WIRE
// too — the desktop's switch-chain and add-chain handlers read `params[0]` — and
// EIP-747 `wallet_watchAsset` is already an object. Those pass through
// untouched, which is why the switch below names what it maps and returns the
// input for everything else rather than guessing a shape.
//
// Pure and wire-shaped, so it lives beside the rest of the mirror: the desktop
// is the source of truth for these keys and drift here is silent until it
// reaches a user.

// The transaction fields the dispatcher forwards. It is opaque about the rest —
// a dApp-supplied gas / nonce is intentionally ignored by the host — so the
// object rides through as the dApp wrote it.
const METHOD_SEND_TRANSACTION = 'eth_sendTransaction';
const METHOD_PERSONAL_SIGN = 'personal_sign';
const METHOD_SIGN_TYPED_DATA_V4 = 'eth_signTypedData_v4';

// A positional argument list, as EIP-1193 `request({ method, params })` carries.
function positional(params: unknown): unknown[] | null {
  return Array.isArray(params) ? params : null;
}

// `typedData` rides the wire JSON-STRINGIFIED (the dispatcher does not decode
// it; the confirmation dialog does). A dApp may hand us either form — the
// EIP-712 spec's own example passes a string, ethers passes an object — so a
// non-string is serialised here rather than sent as a shape the desktop will
// refuse. Anything unserialisable is left alone for the wire to reject loudly.
function asTypedDataString(value: unknown): unknown {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return value;
  }
}

// personal_sign's `message` rides the wire as 0x-hex BYTES: the desktop's
// signing service hex-decodes it and refuses anything
// else with "personal_sign message is not valid hex" — after the user already
// pressed Sign, so the dApp sees a rejection it cannot explain. dApps commonly
// pass the challenge as plain text, because MetaMask accepts it:
// testnet.soniclabs.com's faucet signs "Please sign following text to obtain
// 10 Sonic tokens: ..." and could not claim through this wallet.
// The rule is MetaMask's: a string that IS a 0x byte string is the
// dApp's bytes; any other string is text, signed as its UTF-8 bytes. Either way
// the EIP-191 digest covers the same bytes MetaMask would sign, so a dApp's
// ecrecover agrees. The confirmation dialog decodes the hex back to readable
// text, so the user still reads the
// challenge. "Byte string" means even-length hex: an odd-length "0xabc" names
// no whole bytes, so it is text too. A non-string is left for the desktop to
// refuse by name.
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

function asPersonalSignHex(message: unknown): unknown {
  if (typeof message !== 'string' || HEX_BYTES.test(message)) {
    return message;
  }
  let hex = '0x';
  for (const byte of new TextEncoder().encode(message)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

// Map one EVM request's params to the shape the desktop reads for that method.
// Anything this does not name is returned unchanged: a method whose wire shape
// IS positional must not be reshaped, and an unknown method is not ours to
// invent a shape for — the desktop refuses it by name.
//
// A malformed call (the wrong arity, a non-array where the standard says array)
// is also returned unchanged, so the refusal comes from the desktop with its
// own error code instead of from a guess here.
export function toWireParams(method: string, params: unknown): unknown {
  const args = positional(params);
  switch (method) {
    case METHOD_SEND_TRANSACTION: {
      if (args === null || args.length === 0) {
        return params;
      }
      return args[0];
    }
    case METHOD_PERSONAL_SIGN: {
      // EIP-191 order, and the order the e2e dApp uses: [message, address].
      if (args === null || args.length < 2) {
        return params;
      }
      return { address: args[1], message: asPersonalSignHex(args[0]) };
    }
    case METHOD_SIGN_TYPED_DATA_V4: {
      // EIP-712 order: [address, typedData].
      if (args === null || args.length < 2) {
        return params;
      }
      return { address: args[0], typedData: asTypedDataString(args[1]) };
    }
    default:
      return params;
  }
}
