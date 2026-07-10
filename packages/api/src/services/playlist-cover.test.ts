import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { playlistCoverSvg, wrapTitle, escapeXml, COVER_SIZE } from './playlist-cover.js';
import { CURATED_PLAYLISTS } from './curated-playlists.js';
import { RECIPES } from './playlist-recipe.js';

describe('wrapTitle', () => {
  it('keeps a short title on one line', () => {
    expect(wrapTitle('Pop Party')).toEqual(['Pop Party']);
  });

  it('wraps a longer title across lines without splitting words', () => {
    const lines = wrapTitle('Acoustic & Folk Calm');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe('Acoustic & Folk Calm');
  });

  it('truncates with an ellipsis past the line cap', () => {
    const lines = wrapTitle('one two three four five six seven eight', 6, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith('…')).toBe(true);
  });
});

describe('escapeXml', () => {
  it('escapes XML-significant characters', () => {
    expect(escapeXml('Rock & <Roll>')).toBe('Rock &amp; &lt;Roll&gt;');
  });
});

describe('playlistCoverSvg', () => {
  const svg = playlistCoverSvg({ title: 'Latin Beats', palette: { from: '#ff2d73', to: '#ff8a3d' } });

  it('embeds both palette stops', () => {
    expect(svg).toContain('#ff2d73');
    expect(svg).toContain('#ff8a3d');
  });

  it('renders the title text', () => {
    expect(svg).toContain('Latin Beats');
  });

  it('is a square SVG at the canvas size', () => {
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain(`viewBox="0 0 ${COVER_SIZE} ${COVER_SIZE}"`);
  });

  it('escapes an ampersand in the title', () => {
    const amp = playlistCoverSvg({ title: 'Cumbia & Sol', palette: { from: '#000', to: '#fff' } });
    expect(amp).toContain('Cumbia &amp; Sol');
    expect(amp).not.toContain('Cumbia & Sol');
  });

  it('is deterministic for the same input', () => {
    expect(playlistCoverSvg({ title: 'Latin Beats', palette: { from: '#ff2d73', to: '#ff8a3d' } })).toBe(
      svg,
    );
  });
});

describe('committed cover assets', () => {
  // Regression guard: a recipe/def added without re-running
  // scripts/generate-playlist-covers.ts leaves cover_art pointing at a 404 (a
  // real bug — the four perceptual-shelf recipes shipped without covers).
  const coversDir = resolve(import.meta.dir, '../../../web/public/playlist-covers');

  it('has a committed SVG for every curated def and recipe slug', () => {
    const slugs = [...CURATED_PLAYLISTS, ...RECIPES].map((def) => def.slug);
    const missing = slugs.filter((slug) => !existsSync(resolve(coversDir, `${slug}.svg`)));
    expect(missing).toEqual([]);
  });
});
