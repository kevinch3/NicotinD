import { describe, it, expect } from 'vitest';
import { miniPlayerSlideClass, mainBottomPadClass } from './player-chrome';

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
