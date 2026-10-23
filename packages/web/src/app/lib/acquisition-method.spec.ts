import { methodBadge } from './acquisition-method';

describe('methodBadge', () => {
  it('returns distinct labels for each known method', () => {
    expect(methodBadge('slskd').label).toBe('Soulseek');
    expect(methodBadge('ytdlp').label).toBe('YouTube');
    expect(methodBadge('spotdl').label).toBe('Spotify');
    expect(methodBadge('archive').label).toBe('archive.org');
    expect(methodBadge('import').label).toBe('Imported');
  });

  it('falls back to the unknown badge for null/undefined/unrecognized', () => {
    expect(methodBadge('unknown').label).toBe('Unknown source');
    expect(methodBadge(null).label).toBe('Unknown source');
    expect(methodBadge(undefined).label).toBe('Unknown source');
  });

  it('names a third-party addon by its manifest name instead of "Unknown source"', () => {
    const badge = methodBadge('unknown', 'Demo Source');
    expect(badge.label).toBe('Demo Source');
    expect(badge.glyph).toBe('🧩');
    expect(methodBadge(null, 'Demo Source').label).toBe('Demo Source');
  });

  it('keeps a first-party badge even when a source name is passed', () => {
    expect(methodBadge('slskd', 'Soulseek (addon)').label).toBe('Soulseek');
  });

  it('is "Unknown source" only when there is no name to show', () => {
    expect(methodBadge('unknown', null).label).toBe('Unknown source');
    expect(methodBadge('unknown', '').label).toBe('Unknown source');
  });

  it('provides a glyph for every method', () => {
    for (const m of ['slskd', 'ytdlp', 'spotdl', 'archive', 'import', 'unknown'] as const) {
      expect(methodBadge(m).glyph.length).toBeGreaterThan(0);
    }
  });

  // §H2: Soulseek is a P2P network, not a link source — its glyph must not be the
  // chain link (the URL-based backends already avoid it).
  it('does not use a link glyph for the (non-URL) Soulseek method', () => {
    expect(methodBadge('slskd').glyph).not.toBe('🔗');
  });
});
