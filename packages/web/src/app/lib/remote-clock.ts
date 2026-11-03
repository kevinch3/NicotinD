/**
 * The remote output's playhead between its progress reports.
 *
 * A controller shows where ANOTHER device is in the track by extrapolating the
 * last reported position on the wall clock. That used to run on
 * `requestAnimationFrame` in two components at once — 60–120 signal writes a
 * second each, for a bar the local player itself only moves on `timeupdate`
 * (about 4 Hz) — and kept running after the socket dropped, because a dead
 * socket leaves `remoteIsPlaying` true. `RemotePlaybackService.remoteClock`
 * now owns one timer at the local player's own cadence.
 */

/** Tick interval for the remote clock: the cadence of a local `timeupdate`. */
export const REMOTE_CLOCK_TICK_MS = 250;

/**
 * Position `nowMs` reaches from a report of `position` seconds taken at
 * `reportedAtMs`, clamped to `duration` when that is known (> 0).
 */
export function remoteClockAt(
  position: number,
  reportedAtMs: number,
  duration: number,
  nowMs: number,
): number {
  const t = position + Math.max(0, nowMs - reportedAtMs) / 1000;
  return duration > 0 ? Math.min(t, duration) : t;
}
