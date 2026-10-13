// The TON Connect injected-bridge logic (window[jsBridgeKey].tonconnect). It
// holds NO keys: the desktop derives + signs + enforces permissions. Every call
// round-trips through the injected Transport on the `tonconnect` namespace;
// `disconnect` push events arrive via the same Transport.onEvent channel
// that carries the other providers' events. Decoupled from the postMessage wiring for
// testability — mirror of AirNoxEvmProvider.

import { TON_MAINNET_CHAIN_URN } from '../protocol/chains';
import { ErrorCode, Namespace } from '../protocol/envelope';
import {
  AppRequest,
  ConnectEvent,
  ConnectEventErrorCode,
  ConnectItemReply,
  ConnectRequest,
  DeviceInfo,
  SignDataResult,
  TonConnectBridge,
  WalletEvent,
  WalletResponse,
} from '../protocol/tonconnect';
import { AIRNOX_NAME } from './brand';
import { ProviderRpcError } from './rpc_error';
import { Transport } from './transport';

// The capability advert. `maxMessages: 4` is the honest limit — the desktop
// builds + signs 1..4 messages as ONE external message (a TON wallet body drives
// up to 4 ^InternalMessage refs). Per-message stateInit is still refused. SignData
// is supported for all three data kinds (text / binary / cell); the desktop
// renders each payload before signing (no blind signing).
export const DEFAULT_DEVICE_INFO: DeviceInfo = {
  platform: 'browser',
  appName: AIRNOX_NAME,
  appVersion: '0.1.0',
  maxProtocolVersion: 2,
  features: [
    { name: 'SendTransaction', maxMessages: 4 },
    { name: 'SignData', types: ['text', 'binary', 'cell'] },
  ],
};

// Map a desktop wire ErrorCode → a TON Connect error code. CONNECT_EVENT and
// SEND_TRANSACTION share the same numeric set for the codes we emit (0/1/100/
// 300/400), so one mapping serves both.
function mapTonError(code: number): number {
  // A wire code is any number; the enum names only the ones mapped here.
  /* eslint-disable @typescript-eslint/no-unsafe-enum-comparison */
  switch (code) {
    case ErrorCode.UserRejected:
      return 300; // USER_REJECTS_ERROR
    case ErrorCode.UnsupportedMethod:
      return 400; // METHOD_NOT_SUPPORTED
    case ErrorCode.MalformedRequest:
      return 1; // BAD_REQUEST_ERROR
    case ErrorCode.Unauthorized:
      return 100; // UNKNOWN_APP_ERROR (origin not connected on this chain)
    case ErrorCode.TransactionRejected:
      return 0; // UNKNOWN_ERROR: the wallet's filter refused it; 300 (USER_REJECTS_ERROR) would say the user did
    default:
      return 0; // UNKNOWN_ERROR (WalletLocked / Internal / …)
  }
  /* eslint-enable @typescript-eslint/no-unsafe-enum-comparison */
}

function wireCode(e: unknown): number {
  const code = (e as Partial<ProviderRpcError> | undefined)?.code;
  return typeof code === 'number' ? code : ErrorCode.Internal;
}

function wireMessage(e: unknown): string {
  const m = (e as Partial<Error> | undefined)?.message;
  return typeof m === 'string' && m.length > 0 ? m : 'unknown error';
}

export class AirNoxTonConnectBridge implements TonConnectBridge {
  // An extension, not an in-wallet browser.
  readonly isWalletBrowser = false;
  readonly protocolVersion = 2;
  readonly deviceInfo: DeviceInfo;

  // The bridge owns the ConnectEvent / DisconnectEvent `id` (a monotonic
  // counter); a send() WalletResponse echoes the request's own id instead.
  private nextId = 0;
  private readonly listeners = new Set<(event: WalletEvent) => void>();

  constructor(
    private readonly transport: Transport,
    private readonly chainUrn: string = TON_MAINNET_CHAIN_URN,
    deviceInfo: DeviceInfo = DEFAULT_DEVICE_INFO
  ) {
    this.deviceInfo = deviceInfo;
    // The desktop pushes a `disconnect` WalletEvent when the user disconnects
    // this origin; fan it out to every listen() subscriber. The payload is empty
    // ({}), so the event name is all we read.
    this.transport.onEvent((ns, event) => this.handleEvent(ns, event));
  }

  private handleEvent(ns: Namespace, event: string): void {
    if (ns !== 'tonconnect') {
      return; // a push for another chain's provider on the shared window
    }
    if (event !== 'disconnect') {
      return;
    }
    const ev: WalletEvent = {
      event: 'disconnect',
      id: this.nextId++,
      payload: {},
    };
    for (const cb of this.listeners) {
      cb(ev);
    }
  }

  async connect(
    _protocolVersion: number,
    message: ConnectRequest
  ): Promise<ConnectEvent> {
    // The ConnectRequest is dApp-supplied (untrusted); its `items` type is only a
    // hint. Validate the runtime shape EXPLICITLY and answer a spec connect_error
    // on a malformed request rather than rejecting with a raw TypeError.
    const parsed = this.connectParams(message);
    if (!parsed.ok) {
      return this.makeConnectError(
        ConnectEventErrorCode.BadRequest,
        'connect items are malformed'
      );
    }
    try {
      const result = await this.transport.send(
        'tonconnect',
        'tonConnect_connect',
        parsed.params,
        this.chainUrn
      );
      return this.connectSuccess(result);
    } catch (e) {
      return this.connectError(e);
    }
  }

  // Extract the wire params from a dApp-supplied ConnectRequest. The desktop
  // derives the app domain from the (unforgeable) origin, so the manifestUrl is
  // NOT forwarded — only the ton_proof payload when requested. `items` may be
  // absent (a bare ton_addr connect, no proof); when present it must be an array
  // of objects, and a ton_proof entry must carry a string payload. Returns the
  // params, or ok:false so connect() answers a BadRequest connect_error.
  private connectParams(
    message: ConnectRequest
  ): { ok: true; params: Record<string, string> } | { ok: false } {
    const items: unknown = message?.items;
    if (items === undefined || items === null) {
      return { ok: true, params: {} };
    }
    if (!Array.isArray(items)) {
      return { ok: false };
    }
    const list: readonly unknown[] = items;
    for (const item of list) {
      if (
        typeof item !== 'object' ||
        item === null ||
        (item as { name?: unknown }).name !== 'ton_proof'
      ) {
        continue;
      }
      const payload: unknown = (item as { payload?: unknown }).payload;
      if (typeof payload !== 'string') {
        return { ok: false }; // ton_proof requires a string payload
      }
      return { ok: true, params: { ton_proof: payload } };
    }
    return { ok: true, params: {} }; // no ton_proof item → no proof requested
  }

  async restoreConnection(): Promise<ConnectEvent> {
    try {
      const result = await this.transport.send(
        'tonconnect',
        'tonConnect_restoreConnection',
        {},
        this.chainUrn
      );
      return this.connectSuccess(result);
    } catch (e) {
      return this.connectError(e);
    }
  }

  private connectSuccess(result: unknown): ConnectEvent {
    const items =
      (result as { items?: ConnectItemReply[] } | undefined)?.items ?? [];
    return {
      event: 'connect',
      id: this.nextId++,
      payload: { items, device: this.deviceInfo },
    };
  }

  private connectError(e: unknown): ConnectEvent {
    return this.makeConnectError(mapTonError(wireCode(e)), wireMessage(e));
  }

  // Build a connect_error event with an explicit TON Connect error code (shared
  // by the wire-error path and the local BadRequest path).
  private makeConnectError(code: number, message: string): ConnectEvent {
    return {
      event: 'connect_error',
      id: this.nextId++,
      payload: { code, message },
    };
  }

  // sendTransaction / signData both carry their payload as params[0], a JSON
  // string. The AppRequest is dApp-supplied (untrusted), so its `[string]` type is
  // only a hint — validate the runtime shape EXPLICITLY rather than leaning on
  // JSON.parse happening to throw on a missing element. Returns the parsed value,
  // or a BadRequest WalletResponse to send back verbatim.
  private parsePayloadParam(
    message: AppRequest,
    label: string,
    id: string
  ): { ok: true; value: unknown } | { ok: false; response: WalletResponse } {
    const raw: unknown = message.params;
    if (!Array.isArray(raw) || typeof raw[0] !== 'string') {
      return {
        ok: false,
        response: {
          error: {
            code: 1,
            message: `${label} params must be a single JSON string`,
          },
          id,
        },
      };
    }
    try {
      return { ok: true, value: JSON.parse(raw[0]) };
    } catch {
      return {
        ok: false,
        response: {
          error: { code: 1, message: `${label} params is not valid JSON` },
          id,
        },
      };
    }
  }

  async send(message: AppRequest): Promise<WalletResponse> {
    const id = message && typeof message.id === 'string' ? message.id : '0';

    if (message?.method === 'sendTransaction') {
      const payload = this.parsePayloadParam(message, 'sendTransaction', id);
      if (!payload.ok) {
        return payload.response;
      }
      try {
        const result = await this.transport.send(
          'tonconnect',
          'tonConnect_sendTransaction',
          payload.value,
          this.chainUrn
        );
        // The desktop returns the signed external-message BoC (TON Connect's
        // sendTransaction result is the BoC, not a tx hash).
        const boc = (result as { boc?: string } | undefined)?.boc ?? '';
        return { result: boc, id };
      } catch (e) {
        return {
          error: { code: mapTonError(wireCode(e)), message: wireMessage(e) },
          id,
        };
      }
    }

    if (message?.method === 'signData') {
      const payload = this.parsePayloadParam(message, 'signData', id);
      if (!payload.ok) {
        return payload.response;
      }
      try {
        const result = await this.transport.send(
          'tonconnect',
          'tonConnect_signData',
          payload.value,
          this.chainUrn
        );
        // The desktop returns the full signData reply
        // {signature, address, timestamp, domain, payload} — the dApp verifies the
        // Ed25519 signature against it.
        return { result: result as SignDataResult, id };
      } catch (e) {
        return {
          error: { code: mapTonError(wireCode(e)), message: wireMessage(e) },
          id,
        };
      }
    }

    if (message?.method === 'disconnect') {
      try {
        await this.transport.send(
          'tonconnect',
          'tonConnect_disconnect',
          {},
          this.chainUrn
        );
        return { result: {}, id };
      } catch (e) {
        return {
          error: { code: mapTonError(wireCode(e)), message: wireMessage(e) },
          id,
        };
      }
    }

    // No other AppRequest methods are serviced (signMessage is not implemented).
    return { error: { code: 400, message: 'method not supported' }, id };
  }

  listen(callback: (event: WalletEvent) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  disconnect(): void {
    // The sync method returns void — fire-and-forget the wire disconnect.
    void this.transport
      .send('tonconnect', 'tonConnect_disconnect', {}, this.chainUrn)
      .catch(() => undefined);
  }
}
