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
