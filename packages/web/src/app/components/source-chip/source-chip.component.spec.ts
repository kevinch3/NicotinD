import { describe, it, expect } from 'vitest';
import { sourceChipToneClass } from './source-chip.component';

// The chip's colour must be theme-aware so it stays legible on light themes
// (daylight/warm-paper/eink). Regression guard: no raw Tailwind palette tints
// (e.g. text-indigo-300) that render near-invisible on light backgrounds.
describe('sourceChipToneClass', () => {
  it('maps each known source to its theme-aware tone class', () => {
    expect(sourceChipToneClass('soulseek')).toBe('chip-tone-soulseek');
    expect(sourceChipToneClass('archive')).toBe('chip-tone-archive');
    expect(sourceChipToneClass('spotify')).toBe('chip-tone-spotify');
  });

  it('falls back to neutral theme tokens for an unknown source', () => {
    expect(sourceChipToneClass('mystery' as never)).toBe(
      'bg-theme-surface-2 text-theme-muted',
    );
  });

  it('never emits raw Tailwind palette tints (theme-blind colours)', () => {
    for (const source of ['soulseek', 'archive', 'spotify'] as const) {
      expect(sourceChipToneClass(source)).not.toMatch(/-\d{3}\b/);
    }
  });

  it('falls back to neutral tone for link-intent hosts without a dedicated tone', () => {
    expect(sourceChipToneClass('youtube')).toBe('bg-theme-surface-2 text-theme-muted');
    expect(sourceChipToneClass('soundcloud')).toBe('bg-theme-surface-2 text-theme-muted');
    expect(sourceChipToneClass('bandcamp')).toBe('bg-theme-surface-2 text-theme-muted');
    expect(sourceChipToneClass('link')).toBe('bg-theme-surface-2 text-theme-muted');
  });
});
