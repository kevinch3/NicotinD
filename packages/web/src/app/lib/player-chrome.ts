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
 * The mini player's measured height, published by `PlayerComponent` on `<html>`
 * (`0px` while no track is loaded, or on TV where the bar is not rendered).
 */
export const MINI_PLAYER_HEIGHT_VAR = '--mini-player-h';

/**
 * `<main data-scroll-root>` bottom padding so the fixed chrome never covers the
 * last item at maximum scroll: the tab bar (its own `3.5rem + safe-area`, phone
 * only) plus the mini player's *measured* height. The player's height used to be
 * a constant here (4.5rem) and the bar outgrew it — grab notch and mobile
 * scrubber made it ~98px, so 26px of every view stayed under it (#1694). No
 * deficit term: the shell grows by `--vp-deficit` and the chrome is anchored to
 * the shell's bottom, so `<main>`'s bottom and the chrome's move together.
 */
export const MAIN_BOTTOM_PAD_CLASS =
  'pb-[calc(3.5rem+env(safe-area-inset-bottom)+var(--mini-player-h,0px))] md:pb-[var(--mini-player-h,0px)]';

/**
 * The update strip's measured height, published by `UpdateBannerComponent` on
 * `<html>` (`0px` while it is hidden). It sits on the viewport bottom at z-50,
 * outside `[data-bottom-chrome]`, so only this variable tells the toast stack
 * where it ends.
 */
export const UPDATE_BANNER_HEIGHT_VAR = '--update-banner-h';

/**
 * The toast stack's anchor: 0.5rem above the top of the bottom chrome on phones
 * (tab bar + measured mini player, on the player's own deficit-adjusted
 * anchor), 1rem above the desktop player — or above the update strip, when it
 * is taller (#1699). Toasts are z-[60], above both, so a constant offset (5rem)
 * that the bar outgrew covered its controls. TV adds its overscan floor in
 * styles.css (`html.tv-build [data-testid='toast-stack']`).
 */
export const TOAST_STACK_BOTTOM_CLASS =
  'bottom-[calc(max(3.5rem+env(safe-area-inset-bottom)+var(--mini-player-h,0px),var(--update-banner-h,0px))+0.5rem-var(--vp-deficit))] md:bottom-[calc(max(var(--mini-player-h,0px),var(--update-banner-h,0px))+1rem-var(--vp-deficit))]';

/** The value `PlayerComponent` publishes as {@link MINI_PLAYER_HEIGHT_VAR}. */
export function miniPlayerReservation(hasTrack: boolean, measuredHeight: number): string {
  return `${hasTrack && measuredHeight > 0 ? Math.ceil(measuredHeight) : 0}px`;
}

/** The value `UpdateBannerComponent` publishes as {@link UPDATE_BANNER_HEIGHT_VAR}. */
export const updateBannerReservation = miniPlayerReservation;

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

/**
 * Marks a full-screen overlay that paints over the app chrome (Now Playing,
 * `fixed inset-0 z-[60]`, opaque). A popup opened from inside one reserves
 * neither the bottom chrome nor the header: both are still in the layout, and
 * still measured, but nobody can see or reach them. Reserving them anyway put
 * the Now Playing ⋯ menu 150px off the bottom and flipped it up under the
 * status bar (#1714).
 */
export const COVERS_CHROME_ATTR = 'data-covers-chrome';

function insideChromeCover(from: Element | null | undefined): boolean {
  return !!from?.closest(`[${COVERS_CHROME_ATTR}]`);
}

/**
 * Measures the live `[data-bottom-chrome]` layers in the document and returns
 * their `bottomChromeInset` — the one DOM-reading entry point shared by
 * `BottomChromeSafeDirective` (modal backdrops), `MenuPanelComponent` and
 * `EntityMenuHostComponent` (menus), so they never drift on how the chrome is
 * found or measured. `from` is the popup's own element: inside a
 * `[data-covers-chrome]` overlay there is no chrome to reserve.
 */
export function measureBottomChromeInset(from?: Element | null): number {
  if (insideChromeCover(from)) return 0;
  return bottomChromeInset(
    Array.from(document.querySelectorAll<HTMLElement>('[data-bottom-chrome]')).map((el) => {
      const rect = el.getBoundingClientRect();
      return { top: rect.top, height: rect.height };
    }),
    window.innerHeight,
  );
}

/**
 * The top-edge twin of {@link bottomChromeInset}: how far the sticky app header
 * (tagged `data-top-chrome`) reaches down into the viewport. A modal reserves it
 * instead of trusting z-index — on iOS the header's `backdrop-filter` layer
 * painted over a `z-50` modal and buried its close button (#1522). A header
 * that is hidden (`height` 0) or scrolled above the viewport reserves nothing.
 */
export function topChromeInset(rects: ChromeRect[]): number {
  const bottoms = rects
    .filter((r) => r.height > 0 && r.top + r.height > 0)
    .map((r) => r.top + r.height);
  return bottoms.length ? Math.max(...bottoms) : 0;
}

/**
 * Measures `[data-top-chrome]` and floors it at the status-bar safe area, so a
 * route that collapses the header (the phone mosaic home) still keeps a modal
 * out from under the notch. `env()` only resolves through a real style, hence
 * the probe; jsdom resolves it to nothing, i.e. 0. The probe reads `--safe-top`
 * (styles.css: `env(safe-area-inset-top)`), which an e2e can override to stand
 * in for a notch Chromium cannot produce. Inside a `[data-covers-chrome]`
 * overlay the header is hidden, so only the safe area counts.
 */
export function measureTopChromeInset(from?: Element | null): number {
  const header = insideChromeCover(from)
    ? 0
    : topChromeInset(
        Array.from(document.querySelectorAll<HTMLElement>('[data-top-chrome]')).map((el) => {
          const rect = el.getBoundingClientRect();
          return { top: rect.top, height: rect.height };
        }),
      );
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;padding-top:var(--safe-top,env(safe-area-inset-top,0px))';
  document.body.appendChild(probe);
  const safeArea = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return Math.max(header, safeArea);
}
