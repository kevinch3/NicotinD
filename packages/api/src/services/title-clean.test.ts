import { describe, expect, it } from 'bun:test';
import { cleanDisplayTitle } from './title-clean.js';

describe('cleanDisplayTitle', () => {
  const stripped: Array<[raw: string, cleaned: string, removed: string[]]> = [
    ['Pegao (Official Video)', 'Pegao', ['(Official Video)']],
    ['Sexy Movimiento (Visualizer)', 'Sexy Movimiento', ['(Visualizer)']],
    ['Metele Sazon (Official Music Video)', 'Metele Sazon', ['(Official Music Video)']],
    ['Dominicana (Official Audio)', 'Dominicana', ['(Official Audio)']],
    ['Mayor Que Yo 3 [Lyric Video]', 'Mayor Que Yo 3', ['[Lyric Video]']],
    ['Prrrum (Video Oficial)', 'Prrrum', ['(Video Oficial)']],
    ['Pa’ Que La Pases Bien (Audio Oficial)', 'Pa’ Que La Pases Bien', ['(Audio Oficial)']],
    ['Nunca me Faltes (Videoclip Oficial)', 'Nunca me Faltes', ['(Videoclip Oficial)']],
    ['En La Cama (Letra)', 'En La Cama', ['(Letra)']],
    ['Flow Natural (Lyrics)', 'Flow Natural', ['(Lyrics)']],
    ['Siente El Boom (HD)', 'Siente El Boom', ['(HD)']],
    ['Celebration (HQ)', 'Celebration', ['(HQ)']],
    ['Consolidate (4K)', 'Consolidate', ['(4K)']],
    ['Soy Una Gargola {Visualizer}', 'Soy Una Gargola', ['{Visualizer}']],
    // Accent-insensitive junk matching.
    ['Prrrum (Vídeo Oficial)', 'Prrrum', ['(Vídeo Oficial)']],
    // Trailing separator tails that are pure junk.
    ['Pegao - Official Video', 'Pegao', ['- Official Video']],
    ['Pegao | Official Video', 'Pegao', ['| Official Video']],
    // Multiple junk segments in one title.
    ['Metele Sazon (Video Oficial) (HD)', 'Metele Sazon', ['(Video Oficial)', '(HD)']],
  ];

  it.each(stripped)('strips %j', (raw, cleaned, removed) => {
    expect(cleanDisplayTitle(raw)).toEqual({ cleaned, removed });
  });

  const preserved = [
    'Domino (Space 92 Remix)',
    'No Te Veo (Live)',
    'Mi Gente (En Vivo)',
    'Amor (feat. CERES)',
    'Ella Y Yo (ft. Don Omar)',
    'Rakata (Salsa Version)',
    'Gasolina (Remastered 2009)',
    'Down (Acoustic)',
    // Label / edition brackets are not junk — a human decides.
    'Start Of Madness [Drumcode]',
    'Domino (Space 92 Remix) [Extended Mix]',
    // A `|` tail that is real content (an album name), not junk.
    'Pa’ Que La Pases Bien | El Fenomeno',
    // Mixed segment: junk words alongside non-junk words stays — conservative.
    'Pegao (Official Video Remix)',
  ];

  it.each(preserved)('preserves %j', (raw) => {
    expect(cleanDisplayTitle(raw)).toEqual({ cleaned: raw, removed: [] });
  });

  it('strips only the junk segment when mixed with a real qualifier', () => {
    expect(cleanDisplayTitle('Llamé Pa’ Verte (Bailando Sexy) (Visualizer)')).toEqual({
      cleaned: 'Llamé Pa’ Verte (Bailando Sexy)',
      removed: ['(Visualizer)'],
    });
    expect(cleanDisplayTitle('Amor (feat. CERES) [Lyric Video]')).toEqual({
      cleaned: 'Amor (feat. CERES)',
      removed: ['[Lyric Video]'],
    });
    expect(cleanDisplayTitle('Pegao (Official Video) (Remix)')).toEqual({
      cleaned: 'Pegao (Remix)',
      removed: ['(Official Video)'],
    });
  });

  it('never returns an empty title: an all-junk title comes back unchanged', () => {
    expect(cleanDisplayTitle('(Official Video)')).toEqual({
      cleaned: '(Official Video)',
      removed: [],
    });
  });

  it('is idempotent', () => {
    const once = cleanDisplayTitle('Pegao (Official Video)');
    expect(cleanDisplayTitle(once.cleaned)).toEqual({ cleaned: once.cleaned, removed: [] });
  });

  it('collapses the whitespace a removed middle segment leaves behind', () => {
    expect(cleanDisplayTitle('Pegao  (Official Video)  (Remix)').cleaned).toBe('Pegao (Remix)');
  });

  it('returns the input verbatim when there is nothing to strip', () => {
    expect(cleanDisplayTitle('Dancing Thing')).toEqual({ cleaned: 'Dancing Thing', removed: [] });
  });
});
