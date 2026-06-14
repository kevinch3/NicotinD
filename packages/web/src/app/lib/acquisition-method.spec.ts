import { methodBadge } from './acquisition-method';

describe('methodBadge', () => {
  it('returns distinct labels for each known method', () => {
    expect(methodBadge('slskd').label).toBe('Soulseek');
    expect(methodBadge('ytdlp').label).toBe('YouTube');
    expect(methodBadge('spotdl').label).toBe('Spotify');
    expect(methodBadge('archive').label).toBe('archive.org');
  });

  it('falls back to the unknown badge for null/undefined/unrecognized', () => {
    expect(methodBadge('unknown').label).toBe('Unknown source');
    expect(methodBadge(null).label).toBe('Unknown source');
    expect(methodBadge(undefined).label).toBe('Unknown source');
  });

  it('provides a glyph for every method', () => {
    for (const m of ['slskd', 'ytdlp', 'spotdl', 'archive', 'unknown'] as const) {
      expect(methodBadge(m).glyph.length).toBeGreaterThan(0);
    }
  });
});
