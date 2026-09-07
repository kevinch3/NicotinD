import { describe, expect, it } from 'bun:test';
import { classify, extractTemplateLiterals, FEED_MODULES } from './check-feed-eligibility.js';

describe('extractTemplateLiterals', () => {
  it('returns each backtick literal with its start line, nesting interpolations', () => {
    const src = [
      "const a = 'not me';",
      'const sql = `SELECT 1 FROM t WHERE x = ${fn(`inner`)} ORDER BY RANDOM()`;',
      '// `a comment with a backtick`',
      'const b = `two',
      'lines`;',
    ].join('\n');
    const lits = extractTemplateLiterals(src);
    expect(lits.map((l) => l.line)).toEqual([2, 4]);
    expect(lits[0]!.text).toContain('ORDER BY RANDOM()');
    expect(lits[0]!.text).toContain('${fn(`inner`)}');
    expect(lits[1]!.text).toBe('two\nlines');
  });

  it('ignores a backtick inside a block comment or a quoted string', () => {
    const src = '/* `x` */ const s = "`"; const t = `real`;';
    expect(extractTemplateLiterals(src).map((l) => l.text)).toEqual(['real']);
  });
});

describe('classify — the real fragments', () => {
  it('a radio pool pass through the predicate is feed-ok', () => {
    expect(
      classify(
        '${RADIO_SONG_SELECT} WHERE s.bpm BETWEEN ? AND ? AND ${eligible}\n ORDER BY RANDOM() LIMIT 100',
        true,
      ),
    ).toBe('feed-ok');
  });

  it('/random as it shipped — hand-rolled hidden/landed — is a bypass', () => {
    expect(
      classify(
        '${SONG_SELECT}\n WHERE s.hidden = 0 AND s.landed_at IS NOT NULL AND (a.hidden IS NULL OR a.hidden = 0)\n ORDER BY RANDOM() LIMIT ?',
        false,
      ),
    ).toBe('feed-bypass');
  });

  it('the Songs tab pages rather than samples: a listing, out of scope', () => {
    expect(classify('${SONG_SELECT} ${where} LIMIT ? OFFSET ?', false)).toBe('listing');
    expect(
      classify('${SONG_SELECT} WHERE s.album_id = ? AND s.hidden = 0 ORDER BY s.track', false),
    ).toBe('listing');
  });

  it('inside a feed module every song select is a feed, sampled or not', () => {
    expect(classify('${RADIO_SONG_SELECT} WHERE s.id = ?', true)).toBe('feed-bypass');
    expect(
      classify('${RADIO_SONG_SELECT} WHERE s.id = ? AND ${feedEligibilitySql({ tier: 2 })}', true),
    ).toBe('feed-ok');
  });

  it('a SELECT prefix with no WHERE of its own is a fragment, judged where it is used', () => {
    expect(
      classify(
        '\n  SELECT s.id, s.album_id, a.name AS album_name\n  FROM library_songs s\n  LEFT JOIN library_albums a ON a.id = s.album_id\n',
        true,
      ),
    ).toBe('select-fragment');
    // RADIO_SONG_SELECT carries correlated subselects with their own WHEREs.
    expect(
      classify(
        'SELECT s.id, (SELECT GROUP_CONCAT(genre) FROM (SELECT genre FROM library_song_genres WHERE song_id = s.id)) AS g FROM library_songs s LEFT JOIN library_albums a ON a.id = s.album_id',
        true,
      ),
    ).toBe('select-fragment');
  });

  it('a sampled select whose ORDER BY has a leading expression still counts as sampling', () => {
    expect(
      classify(
        '${RADIO_SONG_SELECT} WHERE s.hidden = 0 ORDER BY (s.genre IS NULL), RANDOM() LIMIT 1',
        false,
      ),
    ).toBe('feed-bypass');
  });

  it('a literal with no song select is not examined', () => {
    expect(classify('SELECT id FROM library_albums ORDER BY RANDOM()', true)).toBe(
      'not-a-song-select',
    );
    expect(classify('${eligible}', true)).toBe('not-a-song-select');
  });
});

describe('FEED_MODULES', () => {
  it('names the modules that exist to recommend', () => {
    expect(FEED_MODULES).toContain('packages/api/src/routes/radio.ts');
    expect(FEED_MODULES.some((m) => m.endsWith('/recommendation/'))).toBe(true);
  });
});
