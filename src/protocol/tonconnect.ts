// The TON Connect injected-bridge protocol types — a hand-mirror of the subset of
// @tonconnect/protocol v2 this wallet actually produces/consumes, the same way
// envelope.ts hand-mirrors the desktop wire protocol (the repo keeps a uuid-only
// runtime; we own the surface we emit). TON Connect protocol v2 is stable; if it
// bumps, update here. The authoritative consumer of this shape is the dApp-side
// @tonconnect/sdk InjectedProvider, which reads window[jsBridgeKey].tonconnect.

// connect_error codes (CONNECT_EVENT_ERROR_CODES) the SDK reads off a
// connect_error event.
export enum ConnectEventErrorCode {
  UnknownError = 0,
  BadRequest = 1,
  ManifestNotFound = 2,
  ManifestContentError = 3,
  UnknownApp = 100,
  UserRejects = 300,
  MethodNotSupported = 400,
}

// deviceInfo.features[] — we declare the SendTransaction the desktop supports
// (1..4 messages, signed as one external message; per-message stateInit is still
// refused) and the SignData kinds it signs (text / binary / cell — each rendered
// before signing, no blind signing). An honest capability declaration.
export interface SendTransactionFeature {
  name: 'SendTransaction';
  maxMessages: number;
}
// The data kinds the desktop's signData supports — all three (text / binary /
// cell), matching @tonconnect/protocol's SignDataType.
export type SignDataType = 'text' | 'binary' | 'cell';
export interface SignDataFeature {
  name: 'SignData';
  types: SignDataType[];
}
export type Feature = SendTransactionFeature | SignDataFeature;

export interface DeviceInfo {
  platform:
    | 'iphone'
    | 'ipad'
    | 'android'
    | 'windows'
    | 'mac'
    | 'linux'
    | 'browser';
  appName: string;
  appVersion: string;
  maxProtocolVersion: number;
  features: Feature[];
}

// ── connect() argument (dApp → bridge) ──
export interface TonAddressConnectItem {
  name: 'ton_addr';
  network?: string;
}
export interface TonProofConnectItem {
  name: 'ton_proof';
  payload: string;
}
export type ConnectItem = TonAddressConnectItem | TonProofConnectItem;
export interface ConnectRequest {
  manifestUrl: string;
  items: ConnectItem[];
}

// ── connect reply items (bridge → dApp) ──
export interface TonAddressItemReply {
  name: 'ton_addr';
  address: string;
  network: string;
  walletStateInit: string;
  publicKey: string;
}
export interface TonProofItemReply {
  name: 'ton_proof';
  proof: {
    timestamp: number;
    domain: { lengthBytes: number; value: string };
    payload: string;
    signature: string;
  };
}
export type ConnectItemReply = TonAddressItemReply | TonProofItemReply;

// ── ConnectEvent (the connect() / restoreConnection() return) ──
export interface ConnectEventSuccess {
  event: 'connect';
  id: number;
  payload: { items: ConnectItemReply[]; device: DeviceInfo };
}
export interface ConnectEventError {
  event: 'connect_error';
  id: number;
  payload: { code: number; message: string };
}
export type ConnectEvent = ConnectEventSuccess | ConnectEventError;

// ── send(AppRequest) → WalletResponse ──
export interface SendTransactionRpcRequest {
  method: 'sendTransaction';
  // params[0] is a JSON string of {valid_until?, network?, from?, messages:[...]}.
  params: [string];
  id: string;
}
// ── signData payload (the data the dApp asks the wallet to sign) ──
// A discriminated union mirroring @tonconnect/protocol's SignDataPayload; the
// optional network/from are dApp hints the desktop ignores (it derives the
// signing account from the granted connection).
export interface SignDataPayloadText {
  type: 'text';
  text: string;
  network?: string;
  from?: string;
}
export interface SignDataPayloadBinary {
  type: 'binary';
  bytes: string; // base64
  network?: string;
  from?: string;
}
export interface SignDataPayloadCell {
  type: 'cell';
  schema: string;
  cell: string; // base64 BoC
  network?: string;
  from?: string;
}
export type SignDataPayload =
  | SignDataPayloadText
  | SignDataPayloadBinary
  | SignDataPayloadCell;
export interface SignDataRpcRequest {
  method: 'signData';
  // params[0] is a JSON string of the SignDataPayload above (same single-element
  // tuple shape as sendTransaction).
  params: [string];
  id: string;
}
export interface DisconnectRpcRequest {
  method: 'disconnect';
  params: [];
  id: string;
}
export type AppRequest =
  | SendTransactionRpcRequest
  | SignDataRpcRequest
  | DisconnectRpcRequest;

// signData result — the desktop dispatcher's exact reply: the Ed25519 signature,
// the raw signing address, the signed-over timestamp + app domain, and the echoed
// payload. The dApp verifies the signature against these.
export interface SignDataResult {
  signature: string; // base64 Ed25519 signature
  address: string; // raw "<workchain>:<hex>" signing address
  timestamp: number; // unix seconds the signature was made over
  domain: string; // the origin-derived app domain (signed over)
  payload: SignDataPayload; // echo of the request payload
}

export interface WalletResponseSuccess {
  // sendTransaction → the signed external-message BoC (base64); disconnect → {};
  // signData → the SignDataResult.
  result: string | Record<string, never> | SignDataResult;
  id: string;
}
export interface WalletResponseError {
  error: { code: number; message: string; data?: unknown };
  id: string;
}
export type WalletResponse = WalletResponseSuccess | WalletResponseError;

// ── listen() push events ──
export interface DisconnectEvent {
  event: 'disconnect';
  id: number;
  payload: Record<string, never>;
}
export type WalletEvent = ConnectEvent | DisconnectEvent;

// The injected bridge object the SDK reads at window[jsBridgeKey].tonconnect.
export interface TonConnectBridge {
  deviceInfo: DeviceInfo;
  protocolVersion: number;
  isWalletBrowser: boolean;
  connect(
    protocolVersion: number,
    message: ConnectRequest
  ): Promise<ConnectEvent>;
  restoreConnection(): Promise<ConnectEvent>;
  send(message: AppRequest): Promise<WalletResponse>;
  listen(callback: (event: WalletEvent) => void): () => void;
  disconnect(): void;
}
