import { describe, expect, it } from 'bun:test';
import { kebab, shotPath } from './shot';

describe('kebab', () => {
  it('lowercases and dashes non-alphanumerics', () => {
    expect(kebab('Now Playing')).toBe('now-playing');
    expect(kebab('BPM analyzed!')).toBe('bpm-analyzed');
    expect(kebab('  Saved   Offline  ')).toBe('saved-offline');
  });

  it('collapses runs and trims leading/trailing dashes', () => {
    expect(kebab('--archive.org lane--')).toBe('archive-org-lane');
    expect(kebab('A/B__C')).toBe('a-b-c');
  });
});

describe('shotPath', () => {
  it('builds screenshots/mobile/<flow>/NN-label.png', () => {
    expect(shotPath('player-analysis', 1, 'player bar')).toBe(
      'screenshots/mobile/player-analysis/01-player-bar.png',
    );
    expect(shotPath('downloads-acquire', 7, 'Recently Added')).toBe(
      'screenshots/mobile/downloads-acquire/07-recently-added.png',
    );
  });

  it('zero-pads the step so filenames sort in capture order', () => {
    expect(shotPath('f', 0, 'x')).toMatch(/\/00-x\.png$/);
    expect(shotPath('f', 12, 'x')).toMatch(/\/12-x\.png$/);
    // Lexical order matches numeric order for single/double-digit steps.
    expect(shotPath('f', 2, 'x') < shotPath('f', 10, 'x')).toBe(true);
  });

  it('kebab-cases the flow segment too', () => {
    expect(shotPath('Player Analysis', 3, 'queue')).toBe(
      'screenshots/mobile/player-analysis/03-queue.png',
    );
  });
});
