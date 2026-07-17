/**
 * Geometry contract between the fixed bottom chrome layers: the mini-player
 * (z-50) and the mobile bottom tab bar (z-40, h-14 + iOS home-indicator inset).
 *
 * Why this is centralized: on mobile the mini-player is anchored one tab-bar
 * height above the viewport bottom, but `translate-y-full` only slides it down
 * by its *own* height — which is taller than the tab bar. A plain full
 * translate therefore parked the opaque, higher-z-index bar exactly on top of
 * the tab bar whenever no track was loaded (fresh session, queue ran out,
 * queue cleared), hiding the nav and swallowing its taps until the user
 * managed to start playback. The hidden state must clear its own height PLUS
 * the tab bar, and be pointer-inert while off-screen.
 *
 * Keep these strings literal — Tailwind generates arbitrary-value utilities by
 * scanning source text, so building them dynamically would drop the CSS.
 */

/** Mini-player slide state: fully visible, or pushed below the tab bar + inert. */
export function miniPlayerSlideClass(hasTrack: boolean): string {
  return hasTrack
    ? 'translate-y-0'
    : 'translate-y-[calc(100%+3.5rem+env(safe-area-inset-bottom))] md:translate-y-full pointer-events-none';
}

/**
 * `<main>` bottom padding so the fixed chrome never covers the last list item:
 * tab bar only when idle, tab bar + mini-player when a track is loaded
 * (desktop has no tab bar, only the player).
 */
export function mainBottomPadClass(hasTrack: boolean): string {
  return hasTrack
    ? 'pb-[calc(8rem+env(safe-area-inset-bottom))] md:pb-20'
    : 'pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0';
}

/** A fixed chrome layer's viewport rect (the subset a popup needs to avoid it). */
export interface ChromeRect {
  top: number;
  height: number;
}

/**
 * Height of the fixed bottom chrome (mini-player + mobile tab bar) that actually
 * overlaps the bottom of the viewport, so a popup can reserve that space and
 * never open *under* it (the mobile "track menu hidden behind the player" bug).
 *
 * Fed the measured rects of the chrome layers (tagged `data-bottom-chrome`), it
 * ignores layers that are hidden (`height` 0 — e.g. the desktop-only-absent tab
 * bar) or slid off-screen (`top` at/below the viewport bottom — the mini-player
 * when no track is loaded), then returns the distance from the highest
 * still-overlapping chrome edge down to the viewport bottom. Measuring rather
 * than recomputing the rem/safe-area/breakpoint math keeps this in lockstep with
 * whatever the chrome actually renders.
 */
export function bottomChromeInset(rects: ChromeRect[], viewportHeight: number): number {
  const tops = rects.filter((r) => r.height > 0 && r.top < viewportHeight).map((r) => r.top);
  if (!tops.length) return 0;
  return Math.max(0, viewportHeight - Math.min(...tops));
}
