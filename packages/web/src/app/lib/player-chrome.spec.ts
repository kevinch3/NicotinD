import { describe, it, expect, afterEach } from 'vitest';
import {
  miniPlayerSlideClass,
  MAIN_BOTTOM_PAD_CLASS,
  TOAST_STACK_BOTTOM_CLASS,
  UPDATE_BANNER_HEIGHT_VAR,
  miniPlayerReservation,
  updateBannerReservation,
  bottomChromeInset,
  measureBottomChromeInset,
  topChromeInset,
  measureTopChromeInset,
} from './player-chrome';

describe('miniPlayerSlideClass', () => {
  it('is fully visible and interactive when a track is loaded', () => {
    const cls = miniPlayerSlideClass(true);
    expect(cls).toContain('translate-y-0');
    expect(cls).not.toContain('pointer-events-none');
  });

  it('hidden state clears its own height PLUS the mobile tab bar', () => {
    // Regression: a plain translate-y-full left the opaque z-50 bar parked on
    // top of the z-40 tab bar (the player anchors 3.5rem above the viewport
    // bottom on mobile), hiding the nav until the user started playback.
    const cls = miniPlayerSlideClass(false);
    expect(cls).toContain('translate-y-[calc(100%+3.5rem+env(safe-area-inset-bottom))]');
  });

  it('hidden state uses a plain full translate on desktop (player anchors at bottom-0)', () => {
    expect(miniPlayerSlideClass(false)).toContain('md:translate-y-full');
  });

  it('hidden state is pointer-inert so it never swallows taps meant for the nav', () => {
    expect(miniPlayerSlideClass(false)).toContain('pointer-events-none');
  });
});

describe('MAIN_BOTTOM_PAD_CLASS', () => {
  it('reserves the tab bar (phone) plus the published mini player height', () => {
    expect(MAIN_BOTTOM_PAD_CLASS).toContain(
      'pb-[calc(3.5rem+env(safe-area-inset-bottom)+var(--mini-player-h,0px))]',
    );
    expect(MAIN_BOTTOM_PAD_CLASS).toContain('md:pb-[var(--mini-player-h,0px)]');
  });

  it('carries no guessed player height (the 8rem constant the bar outgrew, #1694)', () => {
    expect(MAIN_BOTTOM_PAD_CLASS).not.toMatch(/8rem|md:pb-20/);
  });
});

describe('TOAST_STACK_BOTTOM_CLASS', () => {
  it('anchors on a phone above the tab bar plus the measured mini player, or the update strip', () => {
    // The mini player's own anchor (tab bar, deficit-adjusted) plus its height and a gap.
    expect(TOAST_STACK_BOTTOM_CLASS).toContain(
      'bottom-[calc(max(3.5rem+env(safe-area-inset-bottom)+var(--mini-player-h,0px),var(--update-banner-h,0px))+0.5rem-var(--vp-deficit))]',
    );
  });

  it('anchors on desktop above the measured player or the update strip, on their deficit-adjusted anchor', () => {
    // With no track the strip is the only chrome: a 0px player alone parked the toast on it.
    expect(TOAST_STACK_BOTTOM_CLASS).toContain(
      'md:bottom-[calc(max(var(--mini-player-h,0px),var(--update-banner-h,0px))+1rem-var(--vp-deficit))]',
    );
  });

  it('reads the variable the update strip publishes', () => {
    expect(TOAST_STACK_BOTTOM_CLASS.split(UPDATE_BANNER_HEIGHT_VAR)).toHaveLength(3);
  });

  it('carries no guessed player height (the 5rem / bottom-24 constants the bar outgrew, #1699)', () => {
    expect(TOAST_STACK_BOTTOM_CLASS).not.toMatch(/calc\(5rem|md:bottom-24\b/);
  });
});

describe('updateBannerReservation', () => {
  it('is the measured strip height while it shows, and 0px while hidden', () => {
    expect(updateBannerReservation(true, 52.4)).toBe('53px');
    expect(updateBannerReservation(false, 52.4)).toBe('0px');
  });
});

describe('miniPlayerReservation', () => {
  it('is the measured height, rounded up so a fractional bar never shaves a pixel', () => {
    expect(miniPlayerReservation(true, 97.6)).toBe('98px');
  });

  it('is 0px while no track is loaded (the bar is slid off-screen)', () => {
    expect(miniPlayerReservation(false, 98)).toBe('0px');
  });

  it('is 0px when nothing was measured (TV renders no bar)', () => {
    expect(miniPlayerReservation(true, 0)).toBe('0px');
  });
});

describe('bottomChromeInset', () => {
  const VH = 800;

  it('is 0 when no chrome is present (e.g. desktop, idle)', () => {
    expect(bottomChromeInset([], VH)).toBe(0);
  });

  it('measures a single visible chrome layer from its top to the viewport bottom', () => {
    // mini-player 72px tall, anchored at the bottom → top = 728
    expect(bottomChromeInset([{ top: 728, height: 72 }], VH)).toBe(72);
  });

  it('takes the highest top edge when the player stacks above the tab bar', () => {
    // tab bar (56px, top 744) + mini-player above it (72px, top 672)
    const inset = bottomChromeInset(
      [
        { top: 744, height: 56 },
        { top: 672, height: 72 },
      ],
      VH,
    );
    expect(inset).toBe(VH - 672); // 128 — clears both layers
  });

  it('ignores a hidden (height 0) layer — the desktop tab bar is display:none', () => {
    expect(
      bottomChromeInset(
        [
          { top: 0, height: 0 },
          { top: 720, height: 80 },
        ],
        VH,
      ),
    ).toBe(80);
  });

  it('ignores a layer slid off-screen — the mini-player when no track is loaded', () => {
    // hidden mini-player translated fully below the viewport (top ≥ VH)
    expect(bottomChromeInset([{ top: 900, height: 72 }], VH)).toBe(0);
  });
});

describe('measureBottomChromeInset', () => {
  afterEach(() => {
    document.querySelectorAll('[data-bottom-chrome]').forEach((el) => el.remove());
  });

  function addChromeLayer(top: number, height: number): void {
    const el = document.createElement('div');
    el.setAttribute('data-bottom-chrome', '');
    el.getBoundingClientRect = () =>
      ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect;
    document.body.appendChild(el);
  }

  it('is 0 when no [data-bottom-chrome] layer exists', () => {
    expect(measureBottomChromeInset()).toBe(0);
  });

  it('measures the live rects of every tagged chrome layer', () => {
    const vh = window.innerHeight;
    addChromeLayer(vh - 56, 56); // tab bar
    addChromeLayer(vh - 128, 72); // mini-player stacked above it
    expect(measureBottomChromeInset()).toBe(128);
  });
  // #1714: Now Playing paints over the chrome. Reserving it there pushed the ⋯
  // menu 150px off the bottom and flipped it up under the status bar.
  it('reserves nothing for a popup inside a [data-covers-chrome] overlay', () => {
    const vh = window.innerHeight;
    addChromeLayer(vh - 56, 56);
    const overlay = document.createElement('div');
    overlay.setAttribute('data-covers-chrome', '');
    const menu = document.createElement('div');
    overlay.appendChild(menu);
    document.body.appendChild(overlay);
    expect(measureBottomChromeInset(menu)).toBe(0);
    expect(measureBottomChromeInset(document.body)).toBe(56);
    overlay.remove();
  });
});

// The sticky app header painted OVER modal panels on iOS, burying the close
// button (#1522). Modals reserve it the way they reserve the bottom chrome.
describe('topChromeInset', () => {
  it('is 0 when no chrome is present (the header collapses on the mosaic home)', () => {
    expect(topChromeInset([])).toBe(0);
  });

  it('is the bottom edge of the header pinned at the top', () => {
    expect(topChromeInset([{ top: 0, height: 83 }])).toBe(83);
  });

  it('ignores a hidden (height 0) layer', () => {
    expect(topChromeInset([{ top: 0, height: 0 }])).toBe(0);
  });

  it('ignores a header scrolled away above the viewport', () => {
    expect(topChromeInset([{ top: -120, height: 83 }])).toBe(0);
  });
});

describe('measureTopChromeInset', () => {
  afterEach(() => {
    document.querySelectorAll('[data-top-chrome]').forEach((el) => el.remove());
  });

  it('measures the live rect of the tagged header', () => {
    const el = document.createElement('header');
    el.setAttribute('data-top-chrome', '');
    el.getBoundingClientRect = () =>
      ({ top: 0, height: 83, bottom: 83, left: 0, right: 0, width: 0, x: 0, y: 0 }) as DOMRect;
    document.body.appendChild(el);
    expect(measureTopChromeInset()).toBe(83);
  });

  it('is 0 when no [data-top-chrome] layer exists', () => {
    expect(measureTopChromeInset()).toBe(0);
  });
  it('ignores the header for a popup inside a [data-covers-chrome] overlay', () => {
    const el = document.createElement('header');
    el.setAttribute('data-top-chrome', '');
    el.getBoundingClientRect = () =>
      ({ top: 0, height: 83, bottom: 83, left: 0, right: 0, width: 0, x: 0, y: 0 }) as DOMRect;
    document.body.appendChild(el);
    const overlay = document.createElement('div');
    overlay.setAttribute('data-covers-chrome', '');
    const menu = document.createElement('div');
    overlay.appendChild(menu);
    document.body.appendChild(overlay);
    expect(measureTopChromeInset(menu)).toBe(0);
    expect(measureTopChromeInset(document.body)).toBe(83);
    overlay.remove();
  });
});
