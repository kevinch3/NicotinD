import { describe, it, expect } from 'vitest';
import { shouldUseBrowserBack } from './nav-back';

describe('shouldUseBrowserBack', () => {
  it('returns false on initial app load (one NavigationEnd)', () => {
    expect(shouldUseBrowserBack(1)).toBe(false);
  });

  it('returns false with no navigations (deep-link before router settles)', () => {
    expect(shouldUseBrowserBack(0)).toBe(false);
  });

  it('returns true once the user has navigated within the app', () => {
    expect(shouldUseBrowserBack(2)).toBe(true);
    expect(shouldUseBrowserBack(5)).toBe(true);
  });
});
