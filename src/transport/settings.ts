// Transport-mode settings, persisted in storage.local (mirrors iid.ts). Two
// modes, matching the desktop:
//   * AUTO   — the SW probes the predefined loopback port set (WEB3_AUTO_PORTS)
//              and connects to the first that answers as an AirNox v2 server; the
//              desktop binds the first of that set it can, so we discover it.
//   * MANUAL — a pinned loopback port the user sets in the popup, equal to the
//              desktop's manual port.
// Loopback only: a remote desktop host is not supported.

import browser from 'webextension-polyfill';

import { DEFAULT_WS_PORT, WEB3_AUTO_PORTS } from '../protocol/envelope';

export type TransportMode = 'auto' | 'manual';

export interface TransportSettings {
  mode: TransportMode;
  manualPort: number;
}

const MODE_KEY = 'airnox_transport_mode';
const PORT_KEY = 'airnox_manual_port';

// An unprivileged TCP port (the desktop binds 127.0.0.1 only and rejects sub-1024
// ports that would need elevation).
const isValidPort = (p: unknown): p is number =>
  typeof p === 'number' && Number.isInteger(p) && p > 1024 && p <= 65535;

export async function getTransportSettings(): Promise<TransportSettings> {
  const stored = await browser.storage.local.get([MODE_KEY, PORT_KEY]);
  // Unknown / absent mode → AUTO (the zero-config default; never a silent
  // fallback to a guessed remote endpoint).
  const mode: TransportMode = stored[MODE_KEY] === 'manual' ? 'manual' : 'auto';
  const manualPort = isValidPort(stored[PORT_KEY])
    ? stored[PORT_KEY]
    : DEFAULT_WS_PORT;
  return { mode, manualPort };
}

export async function setTransportSettings(
  s: TransportSettings
): Promise<void> {
  await browser.storage.local.set({
    [MODE_KEY]: s.mode,
    [PORT_KEY]: s.manualPort,
  });
}

// The ordered loopback ports the transport should try for `settings`: the single
// pinned port in MANUAL, the predefined set in AUTO.
export function candidatePorts(settings: TransportSettings): number[] {
  return settings.mode === 'manual'
    ? [settings.manualPort]
    : [...WEB3_AUTO_PORTS];
}
