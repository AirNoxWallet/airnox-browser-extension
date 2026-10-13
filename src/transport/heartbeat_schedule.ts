// How often the service worker sys_pings the desktop, expressed as the period of
// the badge-heartbeat alarm. Pure arithmetic — the browser glue that reads and
// re-arms the alarm lives in background/background.ts.
//
// The desktop signer is started at the user's whim, so "not reachable" is the
// normal steady state of an idle browser, not a fault to be retried out of. Every
// heartbeat against an absent desktop opens (and loses) one socket per candidate
// port, and each of those makes Chrome write a net::ERR_CONNECTION_REFUSED line
// to the worker console from below the JS layer, where no handler can suppress
// it. A fixed one-minute cadence therefore turns an idle afternoon into a wall of
// console errors. So the heartbeat BACKS OFF geometrically while the desktop is
// down and snaps back to the fast cadence the moment it answers — the badge stays
// responsive when there is something to be responsive about.
//
// The escalation state is the alarm's own period, not a variable: the MV3 worker
// is evicted between ticks, so in-memory state would reset every time and never
// escalate at all, while alarm registrations survive eviction — and storing it
// would mean a new storage.local key with no migration path.

// The fast cadence, used whenever the desktop answers (and re-armed on any
// explicit user action, which is the likeliest prelude to the desktop starting).
export const PING_PERIOD_MIN_MINUTES = 1;
// The floor of the back-off. Eight minutes is ~1/8 of the noise of a fixed
// cadence while still finding a desktop the user started and walked away from.
export const PING_PERIOD_MAX_MINUTES = 8;

// The period the heartbeat alarm should carry for its NEXT tick, given the period
// it carries now and whether this tick reached the desktop. `current` is the
// alarm's periodInMinutes, which is absent if the alarm was never created.
export function nextPingPeriodMinutes(
  current: number | undefined,
  connected: boolean
): number {
  if (connected) {
    return PING_PERIOD_MIN_MINUTES;
  }
  // An absent / nonsensical period restarts the escalation rather than trusting
  // it: fail closed towards probing more often, never towards a silent badge.
  const base =
    typeof current === 'number' &&
    Number.isFinite(current) &&
    current > PING_PERIOD_MIN_MINUTES
      ? current
      : PING_PERIOD_MIN_MINUTES;
  return Math.min(base * 2, PING_PERIOD_MAX_MINUTES);
}
