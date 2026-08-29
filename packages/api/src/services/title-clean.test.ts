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

// Issue #775: remaster labels were absent from the vocabulary entirely, so
// several hundred rows kept them. Adding `remastered` to CORE alone is not
// enough — "(Remastered 2009)" tokenises to `remastered` + `2009`, and the bare
// year made the segment non-junk. Year-like tokens, `version` and `edition`
// therefore count as MODIFIERs.
describe('cleanDisplayTitle — remaster labels', () => {
  it('strips a bare remaster segment', () => {
    expect(cleanDisplayTitle('About a Girl (Remastered)').cleaned).toBe('About a Girl');
  });

  it('strips a remaster tail carrying a year', () => {
    expect(cleanDisplayTitle('Help! - Remastered 2009').cleaned).toBe('Help!');
  });

  it('strips a year + remaster + version tail', () => {
    expect(cleanDisplayTitle('Asturias - 2006 Remastered Version').cleaned).toBe('Asturias');
  });

  it("strips the stylised Remaster'd", () => {
    expect(cleanDisplayTitle("Sunshine (Remaster'd)").cleaned).toBe('Sunshine');
  });

  it('leaves a bare year alone — a year is only ever a modifier', () => {
    expect(cleanDisplayTitle('Nineteen (1999)').cleaned).toBe('Nineteen (1999)');
    expect(cleanDisplayTitle('Summer - 2003').cleaned).toBe('Summer - 2003');
  });

  it('leaves an edition marker that may carry bonus tracks', () => {
    expect(cleanDisplayTitle('Fallen (Deluxe Edition)').cleaned).toBe('Fallen (Deluxe Edition)');
    expect(cleanDisplayTitle('Fallen (Deluxe Edition / Remastered 2023)').cleaned).toBe(
      'Fallen (Deluxe Edition / Remastered 2023)',
    );
  });

  // The load-bearing regression: these four are distinguished ONLY by the
  // suffix. Stripping the whole tail would collapse them into four identical
  // titles, and a later dedupe pass would read them as duplicates.
  it('keeps the Evanescence variants distinct', () => {
    const variants = [
      'Bring Me To Life - Remastered 2023',
      'Bring Me To Life - Demo / Remastered 2023',
      'Bring Me To Life - AOL Session / 2003 / Remastered',
      "Bring Me To Life - Live On Triple M's Garage Session / 2020 / Remastered 2023",
    ].map((t) => cleanDisplayTitle(t).cleaned);

    expect(variants[0]).toBe('Bring Me To Life');
    expect(variants[1]).toBe('Bring Me To Life - Demo / Remastered 2023');
    expect(variants[2]).toBe('Bring Me To Life - AOL Session / 2003 / Remastered');
    expect(variants[3]).toBe(
      "Bring Me To Life - Live On Triple M's Garage Session / 2020 / Remastered 2023",
    );
    expect(new Set(variants).size).toBe(4);
  });
});
