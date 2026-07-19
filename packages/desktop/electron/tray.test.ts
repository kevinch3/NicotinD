import { describe, expect, it } from 'bun:test';
import { shouldHideOnClose } from './should-hide-on-close.js';

describe('shouldHideOnClose', () => {
  it('hides the window on Linux when no quit is in progress', () => {
    expect(shouldHideOnClose('linux', false)).toBe(true);
  });

  it('hides the window on Windows when no quit is in progress', () => {
    expect(shouldHideOnClose('win32', false)).toBe(true);
  });

  it('never hides on macOS (preserves the click-to-dock convention)', () => {
    expect(shouldHideOnClose('darwin', false)).toBe(false);
  });

  it('does not hide on Linux once a quit is in progress (lets the close fire normally)', () => {
    expect(shouldHideOnClose('linux', true)).toBe(false);
  });

  it('does not hide on macOS even with a quit in progress (consistency)', () => {
    expect(shouldHideOnClose('darwin', true)).toBe(false);
  });
});
