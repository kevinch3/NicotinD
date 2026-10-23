import { describe, expect, it } from 'bun:test';
import {
  COVER_MOTIFS,
  DEMO_ALBUMS,
  DEMO_LYRICS_TRACK,
  DEMO_MIN_ALBUM_TRACKS,
  coverSvg,
  demoLyricsLrc,
  demoSlug,
  demoTracks,
  renderTone,
  toneSpec,
  toPcm16,
} from './index.js';
import { parseLrc } from '../lrc.js';

const allTracks = DEMO_ALBUMS.flatMap(demoTracks);

describe('demo catalog', () => {
  it('has both pools, so the acquire flow always has something to find', () => {
    expect(DEMO_ALBUMS.some((a) => a.pool === 'library')).toBe(true);
    expect(DEMO_ALBUMS.some((a) => a.pool === 'acquirable')).toBe(true);
  });

  it('gives every track a unique seed and every album a unique slug', () => {
    expect(new Set(allTracks.map((t) => t.seed)).size).toBe(allTracks.length);
    const slugs = DEMO_ALBUMS.map((a) => `${demoSlug(a.artist)}/${demoSlug(a.title)}`);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('gives every album enough tracks to be classified an album, not an EP', () => {
    for (const a of DEMO_ALBUMS)
      expect(a.tracks.length).toBeGreaterThanOrEqual(DEMO_MIN_ALBUM_TRACKS);
  });

  it('shows every cover motif at least once', () => {
    expect(new Set(DEMO_ALBUMS.map((a) => a.cover)).size).toBe(COVER_MOTIFS.length);
  });

  it('slugs are ASCII-safe for paths and URLs', () => {
    expect(demoSlug('Orbit Café')).toBe('orbit-cafe');
    expect(demoSlug('Juniper & Coal')).toBe('juniper-and-coal');
  });

  it('keeps every track inside the 45–90 s demo length band', () => {
    for (const t of allTracks) {
      expect(t.tone.durationSec).toBeGreaterThan(40);
      expect(t.tone.durationSec).toBeLessThan(95);
    }
  });

  it('times every lyric line inside the song it belongs to', () => {
    const track = allTracks.find(
      (t) => t.artist === DEMO_LYRICS_TRACK.artist && t.title === DEMO_LYRICS_TRACK.title,
    );
    expect(track).toBeDefined();
    const lines = parseLrc(demoLyricsLrc(track!.tone));
    expect(lines.length).toBe(10);
    for (const line of lines) expect(line.timeMs).toBeLessThan(track!.tone.durationSec * 1000);
  });
});

describe('demo tones', () => {
  it('is a pure function of the seed', () => {
    expect(toneSpec('a', 'Funk')).toEqual(toneSpec('a', 'Funk'));
    const a = renderTone(toneSpec('a', 'Funk'), 8000);
    const b = renderTone(toneSpec('a', 'Funk'), 8000);
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    expect(toneSpec('a', 'Funk')).not.toEqual(toneSpec('b', 'Funk'));
  });

  it('renders exactly the duration the metadata claims', () => {
    // The player refuses a browser duration far from the API one, so the length
    // in the spec is a contract, not an estimate.
    const spec = toneSpec('length', 'Indie Pop');
    expect(renderTone(spec, 8000).length).toBe(Math.round(spec.durationSec * 8000));
  });

  it('reports the tempo it renders, inside the genre band', () => {
    expect(toneSpec('x', 'Ambient').bpm).toBeLessThanOrEqual(72);
    expect(toneSpec('x', 'Indie Pop').bpm).toBeGreaterThanOrEqual(104);
  });

  it('is audible, never clipped, and fades in from silence', () => {
    for (const genre of ['Folk', 'Synthwave', 'Ambient'] as const) {
      const samples = renderTone(toneSpec(`audible-${genre}`, genre), 8000);
      let peak = 0;
      let sumSq = 0;
      for (const s of samples) {
        expect(Number.isFinite(s)).toBe(true);
        peak = Math.max(peak, Math.abs(s));
        sumSq += s * s;
      }
      expect(peak).toBeLessThanOrEqual(0.71);
      expect(Math.sqrt(sumSq / samples.length)).toBeGreaterThan(0.03);
      expect(samples[0]).toBe(0);
    }
  });

  it('converts to 16-bit PCM without wrapping', () => {
    expect(Array.from(toPcm16(new Float32Array([0, 1, -1, 2])))).toEqual([0, 32767, -32767, 32767]);
  });
});

describe('demo covers', () => {
  it('is deterministic per album and differs between albums', () => {
    const a = coverSvg({ artist: 'Brass Comet', title: 'Orbit Café' });
    expect(a).toBe(coverSvg({ artist: 'Brass Comet', title: 'Orbit Café' }));
    expect(a).not.toBe(coverSvg({ artist: 'Lumen Fields', title: 'Tidal Memory' }));
  });

  it('gives each sleeve its own gradient id, so inline covers on one page do not share a fill', () => {
    const id = (svg: string) => /linearGradient id="([^"]+)"/.exec(svg)?.[1];
    const a = coverSvg({ artist: 'Brass Comet', title: 'Orbit Café' });
    const b = coverSvg({ artist: 'Lumen Fields', title: 'Tidal Memory' });
    expect(id(a)).toBeDefined();
    expect(id(a)).not.toBe(id(b));
    expect(a).toContain(`url(#${id(a)})`);
  });

  it('escapes names so an ampersand cannot break the SVG', () => {
    const svg = coverSvg({ artist: 'Juniper & Coal', title: 'A <b> "c"' });
    expect(svg).toContain('Juniper &amp; Coal');
    expect(svg).toContain('A &lt;b&gt; &quot;c&quot;');
    expect(svg).not.toContain('& Coal');
  });
});
