/**
 * Picks which lyrics scroll container the shell's auto-scroll effect should
 * target: the in-place `NowPlayingLyricsPanelComponent`'s container, or the
 * fullscreen `NowPlayingKaraokeFullscreenComponent`'s browse-mode list —
 * whichever surface is actually visible. Pulled out as a pure function (no
 * Angular `viewChild()`/DI involved) specifically so this branching is
 * unit-testable: the JIT vitest harness this project runs on doesn't resolve
 * `viewChild()` queries at all (confirmed with a minimal inline-template
 * repro, unrelated to this component), so a test exercising the real
 * `ElementRef` refs can only ever pass in a real browser/e2e — but the
 * *decision* of which ref to use doesn't need one.
 */
export function resolveLyricsScrollContainer(
  karaokeFullscreen: boolean,
  refs: { lyricsPanelEl: HTMLElement | null; karaokeEl: HTMLElement | null },
): HTMLElement | null {
  return karaokeFullscreen ? refs.karaokeEl : refs.lyricsPanelEl;
}
