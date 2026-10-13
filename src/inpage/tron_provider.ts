// The TronLink / TronWeb shim logic — the request routing + connect state behind
// window.tronLink / window.tron / window.tronWeb, plus the TronWeb.trx convenience
// methods (trx.signMessageV2 / sign / sendRawTransaction). It holds NO keys: the
// desktop signs + enforces permissions; this only marshals tron_* requests over
// the injected Transport, caches the granted account, and shapes the trx methods
// to the desktop contract. Decoupled from the postMessage wiring (tron_inpage.ts)
// for testability — mirror of evm_provider.ts.

import { TRON_MAINNET_CHAIN_URN } from '../protocol/chains';
import { ErrorCode, Namespace } from '../protocol/envelope';
import { base58Decode } from './base58';
import { bytesToHex0x } from './encoding';
import { Emitter } from './emitter';
import { expectString } from './expect_string';
import { isUnauthorized, rpcError } from './rpc_error';
import { Transport } from './transport';

export interface TronRequestArguments {
  readonly method: string;
  readonly params?: unknown;
}

// TronWeb's `defaultAddress` shape: { base58, hex, name }. Before connect every
// field is `false` — TronWeb's "no account" sentinel, which dApps test for
// (e.g. `if (!tronWeb.defaultAddress.base58)`).
export interface TronDefaultAddress {
  base58: string | false;
  hex: string | false;
  name: string | false;
}

// A TronWeb transaction object (the shape trx.sign / sendRawTransaction pass
// around). The desktop is authoritative — it decodes `raw_data_hex` itself and
// never trusts the decoded `raw_data` — so the shim treats it as an opaque
// carrier and only appends to `signature[]` on sign. Indexed to tolerate the
// other fields TronWeb attaches (txID, raw_data, visible, …).
export interface TronTransaction {
  signature?: string[];
  [key: string]: unknown;
}

// Decode a TRON base58check address ("T...") to its 41-prefixed hex — TronWeb's
// `hex` form. base58Decode yields the 25-byte base58check (a 21-byte body +
// 4-byte checksum); the hex address is the 21-byte body (0x41 mainnet prefix +
// 20-byte hash). Returns null on a malformed address (defensive — the desktop
// only returns valid base58check addresses).
function base58ToTronHex(addr: string): string | null {
  let raw: Uint8Array;
  try {
    raw = base58Decode(addr);
  } catch {
    return null;
  }
  if (raw.length !== 25 || raw[0] !== 0x41) {
    return null;
  }
  let hex = '';
  for (let i = 0; i < 21; i++) {
    hex += raw[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export class AirNoxTronProvider extends Emitter {
  // The connected account (the first granted base58 "T..." address) or null
  // before connect. The single source of truth for `ready` + `defaultAddress`.
  private address: string | null = null;

  constructor(private readonly transport: Transport) {
    super();
    // Desktop pushes (accountsChanged on an eligibility change) update the cached
    // account so `defaultAddress` stays correct after connect.
    this.transport.onEvent((ns, event, data, chain) =>
      this.handleEvent(ns, event, data, chain)
    );
  }

  // The TIP-1193-style request shared by window.tron / window.tronLink.request.
  // Forwards every tron_* method to the desktop over the 'tron' namespace; caches
  // the granted account on a successful tron_requestAccounts. The desktop holds
  // the keys + the permission gate — a rejection rejects this promise.
  async request(args: TronRequestArguments): Promise<unknown> {
    if (!args || typeof args.method !== 'string') {
      throw rpcError(ErrorCode.MalformedRequest, 'request requires a method');
    }
    const { method, params } = args;
    const result = await this.roundTrip(method, params);
    // tron_requestAccounts is the only account-granting method (TronLink dApps
    // read the connected account back via tronWeb.defaultAddress, not an RPC), so
    // it is the only one that updates the cached account.
    if (method === 'tron_requestAccounts') {
      this.absorbAccounts(result);
    }
    return result;
  }

  // TronWeb's `ready` flag — true once an account is connected.
  get ready(): boolean {
    return this.address !== null;
  }

  // The connected base58 address, or null before connect.
  get connectedAddress(): string | null {
    return this.address;
  }

  // TronWeb's `defaultAddress` value (base58 + 41-hex, or the `false` sentinels).
  defaultAddress(): TronDefaultAddress {
    if (!this.address) {
      return { base58: false, hex: false, name: false };
    }
    const hex = base58ToTronHex(this.address);
    return { base58: this.address, hex: hex ?? false, name: false };
  }

  // tronWeb.trx.signMessageV2(message): sign a personal message. TronWeb's
  // hashMessage byte-frames a string as UTF-8 (and raw bytes as-is); the desktop
  // then computes the TIP-191 digest over those bytes, so we forward the bytes as
  // `0x`-hex (the form the desktop decodes). Returns the `0x`-hex signature string
  // (TronWeb's signMessageV2 return value). The signer is the connected account.
  async signMessageV2(message: string | Uint8Array): Promise<string> {
    const address = this.requireConnected();
    const bytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message;
    const sig = await this.roundTrip('tron_signMessageV2', {
      address,
      message: bytesToHex0x(bytes),
    });
    return expectString(sig, 'tron_signMessageV2');
  }

  // tronWeb.trx.sign(transaction): sign an unsigned TronWeb tx. The desktop
  // decodes the AUTHORITATIVE raw_data_hex itself (never the dApp's pre-decoded
  // raw_data), confirms + signs, and returns the BARE 65-byte hex signature; the
  // EXTENSION assembles the signed tx (TronWeb-faithful — trx.sign returns the tx
  // with the signature appended to its `signature[]`). The transaction rides the
  // wire JSON-stringified (the desktop's sign contract takes a string payload).
  async sign(transaction: TronTransaction): Promise<TronTransaction> {
    if (!transaction || typeof transaction !== 'object') {
      throw rpcError(
        ErrorCode.MalformedRequest,
        'trx.sign requires a transaction object'
      );
    }
    const address = this.requireConnected();
    const sig = await this.roundTrip('tron_signTransaction', {
      address,
      transaction: JSON.stringify(transaction),
    });
    const sigHex = expectString(sig, 'tron_signTransaction');
    const existing = Array.isArray(transaction.signature)
      ? transaction.signature
      : [];
    return { ...transaction, signature: [...existing, sigHex] };
  }

  // tronWeb.trx.sendRawTransaction(signedTransaction): broadcast an already-signed
  // tx. The desktop relays it to the user's TronGrid node and returns the node's
  // response object VERBATIM — acceptance ({result:true,txid}) or rejection
  // ({result:false,code,message}) alike, since TronWeb's sendRawTransaction
  // returns the result object and the dApp inspects `.result` itself (only a
  // transport failure rejects this promise). The signed tx rides as an OBJECT
  // (the desktop's broadcast contract takes the tx object, not a string).
  async sendRawTransaction(
    signedTransaction: TronTransaction
  ): Promise<unknown> {
    if (!signedTransaction || typeof signedTransaction !== 'object') {
      throw rpcError(
        ErrorCode.MalformedRequest,
        'trx.sendRawTransaction requires a signed transaction object'
      );
    }
    return this.roundTrip('tron_sendRawTransaction', {
      transaction: signedTransaction,
    });
  }

  // One desktop round-trip on the TRON mainnet chain. A 4100 answer means the
  // desktop no longer grants this origin the account cached here (see
  // isUnauthorized — e.g. a session-only grant ended by a desktop restart):
  // forget it, then let the refusal reach the dApp unchanged. Mirror of the EVM
  // provider's roundTrip, for the same reasons: the whole cache goes, and no
  // other code clears it.
  private async roundTrip(method: string, params: unknown): Promise<unknown> {
    try {
      return await this.transport.send(
        'tron',
        method,
        params,
        TRON_MAINNET_CHAIN_URN
      );
    } catch (e) {
      if (isUnauthorized(e)) {
        this.forgetAccount();
      }
      throw e;
    }
  }

  // Drop the connected account — `ready` goes false and `defaultAddress` back to
  // TronWeb's `false` sentinels — and say so with the accountsChanged([]) a
  // desktop push of an empty set raises, only when there was an account to
  // forget.
  private forgetAccount(): void {
    if (this.address === null) {
      return;
    }
    this.address = null;
    this.emit('accountsChanged', []);
  }

  // The connected account, or a thrown error — the trx.* methods need a signer,
  // and the desktop would reject an unauthorized address anyway.
  private requireConnected(): string {
    if (!this.address) {
      throw rpcError(
        ErrorCode.Unauthorized,
        'no connected TRON account; call tron_requestAccounts first'
      );
    }
    return this.address;
  }

  // Cache the connected account (the first granted address) from a
  // tron_requestAccounts result + fire the connect / accountsChanged events
  // (window.tron is a TIP-1193 provider, so dApps listen via .on).
  private absorbAccounts(result: unknown): void {
    const accounts = Array.isArray(result)
      ? result.filter((a): a is string => typeof a === 'string')
      : [];
    const next = accounts.length > 0 ? accounts[0] : null;
    const wasConnected = this.address !== null;
    const changed = next !== this.address;
    this.address = next;
    if (!wasConnected && next !== null) {
      this.emit('connect', { address: next });
    }
    if (changed) {
      this.emit('accountsChanged', [...accounts]);
    }
  }

  // A desktop accountsChanged push: update the cached account (so defaultAddress
  // stays correct) and re-emit, deduped — a no-op push must not surface a
  // spurious event. The shim serves TRON mainnet only (roundTrip), so a push
  // tagged with another TRON chain is about a grant it does not hold. An empty
  // or missing chain (a push not tied to one, a pre-chain desktop) is not a
  // mismatch.
  private handleEvent(
    ns: Namespace,
    event: string,
    data: unknown,
    chain?: string
  ): void {
    if (ns !== 'tron') {
      return; // a push for another chain's provider on the shared window
    }
    if (chain && chain !== TRON_MAINNET_CHAIN_URN) {
      return;
    }
    if (event !== 'accountsChanged') {
      return;
    }
    const accounts = Array.isArray(data)
      ? data.filter((a): a is string => typeof a === 'string')
      : [];
    const next = accounts.length > 0 ? accounts[0] : null;
    if (next === this.address) {
      return;
    }
    this.address = next;
    this.emit('accountsChanged', [...accounts]);
  }
}
