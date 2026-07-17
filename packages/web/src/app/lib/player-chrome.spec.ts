import { describe, it, expect } from 'vitest';
import { miniPlayerSlideClass, mainBottomPadClass, bottomChromeInset } from './player-chrome';

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

describe('mainBottomPadClass', () => {
  it('reserves tab bar + mini-player space when a track is loaded', () => {
    const cls = mainBottomPadClass(true);
    expect(cls).toContain('pb-[calc(8rem+env(safe-area-inset-bottom))]');
    expect(cls).toContain('md:pb-20');
  });

  it('reserves only tab bar space when idle (none on desktop)', () => {
    const cls = mainBottomPadClass(false);
    expect(cls).toContain('pb-[calc(3.5rem+env(safe-area-inset-bottom))]');
    expect(cls).toContain('md:pb-0');
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
