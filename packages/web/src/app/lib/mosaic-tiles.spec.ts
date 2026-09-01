import { describe, expect, it } from 'vitest';
import {
  SCORE_WEIGHTS,
  assignSongsToSlots,
  buildMosaicTiles,
  dedupeTiles,
  jitter,
  ownPlayShare,
  playWeights,
  scoreSong,
  tileSize,
  type MosaicSources,
  type MosaicTile,
} from './mosaic-tiles';
import type { ListeningStats, PlaylistSummary, RecentPlay, Song } from '../services/api/api-types';

const song = (over: Partial<Song> = {}): Song => ({
  id: 's1',
  title: 'Track',
  artist: 'Artist',
  album: 'Album',
  albumId: 'al1',
  path: '/a.flac',
  bitRate: 320,
  size: 1000,
  created: '2026-01-01',
  ...over,
});

const stats = (over: Partial<ListeningStats> = {}): ListeningStats => ({
  period: 'all',
  from: 0,
  to: 1,
  totals: { plays: 0, distinctSongs: 0, distinctArtists: 0, msPlayed: 0 },
  topSongs: [],
  topArtists: [],
  topAlbums: [],
  topGenres: [],
  clock: new Array(24).fill(0),
  ...over,
});

const emptySources = (over: Partial<MosaicSources> = {}): MosaicSources => ({
  resume: null,
  keepVibe: [],
  tasteBreakers: [],
  recentPlays: [],
  playlists: [],
  genres: [],
  stats: null,
  ...over,
});

describe('jitter', () => {
  it('is deterministic, so a tile keeps its size across reloads', () => {
    expect(jitter('song:abc')).toBe(jitter('song:abc'));
  });

  it('stays in 0..1 and separates neighbouring keys', () => {
    const a = jitter('song:1');
    const b = jitter('song:2');
    for (const v of [a, b]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(a).not.toBeCloseTo(b, 2);
  });
});

describe('playWeights', () => {
  it('normalizes each list against its own maximum', () => {
    const w = playWeights(
      stats({
        topSongs: [
          { songId: 'a', title: null, artist: null, plays: 10 },
          { songId: 'b', title: null, artist: null, plays: 5 },
        ],
        topArtists: [{ artist: 'Björk', plays: 4 }],
      }),
    );
    expect(w.bySong.get('a')).toBe(1);
    expect(w.bySong.get('b')).toBe(0.5);
    expect(w.byArtist.get('björk')).toBe(1);
  });

  it('returns empty maps for absent stats rather than throwing', () => {
    const w = playWeights(null);
    expect(w.bySong.size).toBe(0);
    expect(w.byGenre.size).toBe(0);
  });

  it('survives an all-zero log without dividing by zero', () => {
    const w = playWeights(
      stats({ topSongs: [{ songId: 'a', title: null, artist: null, plays: 0 }] }),
    );
    expect(w.bySong.size).toBe(0);
  });
});

describe('ownPlayShare', () => {
  // topSongs is capped at ten server-side, so the artist proxy is what gives
  // the other ~70 song tiles any personal signal at all.
  const w = playWeights(
    stats({
      topSongs: [{ songId: 'exact', title: null, artist: null, plays: 8 }],
      topArtists: [{ artist: 'Known', plays: 6 }],
    }),
  );

  it('prefers the exact song count', () => {
    expect(ownPlayShare('exact', 'Known', w)).toBe(1);
  });

  it('falls back to the artist when the song is outside the top ten', () => {
    expect(ownPlayShare('other', 'Known', w)).toBe(1);
  });

  it('matches the artist case-insensitively', () => {
    expect(ownPlayShare('other', 'kNoWn', w)).toBe(1);
  });

  it('is zero when neither is known', () => {
    expect(ownPlayShare('other', 'Stranger', w)).toBe(0);
  });
});

describe('scoreSong', () => {
  const none = playWeights(null);

  it('uses the popularity branch when popularity is known', () => {
    const k = SCORE_WEIGHTS;
    expect(scoreSong('k', 's', 'A', 1, none)).toBeCloseTo(k.songBase + k.songPopularity);
  });

  // The distinction the whole scoring rests on: normalizePopularity maps a real
  // zero-listen recording to 0, so `?? 0` would conflate "nobody listened" with
  // "we never looked" — and a 0.5 default would flatten the mosaic instead.
  it('treats popularity 0 as a real value, not as unknown', () => {
    const known = scoreSong('k', 's', 'A', 0, none);
    const unknown = scoreSong('k', 's', 'A', undefined, none);
    expect(known).toBeCloseTo(SCORE_WEIGHTS.songBase);
    expect(unknown).not.toBeCloseTo(known);
  });

  it('falls back to plays plus jitter when popularity is absent', () => {
    const k = SCORE_WEIGHTS;
    const w = playWeights(
      stats({ topSongs: [{ songId: 's', title: null, artist: null, plays: 3 }] }),
    );
    expect(scoreSong('k', 's', 'A', undefined, w)).toBeCloseTo(
      k.songBase + k.songPlaysWithoutPopularity + k.songJitter * jitter('k'),
    );
  });

  it('never leaves 0..1', () => {
    const w = playWeights(
      stats({ topSongs: [{ songId: 's', title: null, artist: null, plays: 1 }] }),
    );
    for (const pop of [undefined, 0, 0.5, 1]) {
      const v = scoreSong('k', 's', 'A', pop, w);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('tileSize', () => {
  it('is monotonic in score', () => {
    expect(tileSize(0.9, 620)).toBeGreaterThan(tileSize(0.2, 620));
  });

  it('reproduces the reference 93–242px band at a 620px stage', () => {
    expect(tileSize(0, 620)).toBe(93);
    expect(tileSize(1, 620)).toBe(242);
  });

  it('scales with the stage, so one constant set works phone to desktop', () => {
    expect(tileSize(0.5, 390)).toBeLessThan(tileSize(0.5, 1200));
  });
});

describe('dedupeTiles', () => {
  const tile = (key: string, score: number): MosaicTile => ({
    key,
    kind: 'song',
    title: key,
    subtitle: '',
    score,
    action: { type: 'song', track: { id: key, title: key, artist: 'A' } },
  });

  it('keeps the highest-scoring tile for a key', () => {
    const out = dedupeTiles([tile('song:a', 0.2), tile('song:a', 0.9), tile('song:b', 0.5)]);
    expect(out).toHaveLength(2);
    expect(out.find((t) => t.key === 'song:a')?.score).toBe(0.9);
  });
});

describe('buildMosaicTiles', () => {
  it('always emits the eight vibe presets, even with an empty library', () => {
    const tiles = buildMosaicTiles(emptySources());
    expect(tiles.filter((t) => t.kind === 'vibe')).toHaveLength(8);
  });

  it('gives every tile a radio-start action — the surface has one verb', () => {
    const tiles = buildMosaicTiles(
      emptySources({
        resume: { id: 'r', title: 'Resume', artist: 'A' },
        tasteBreakers: [song({ id: 'tb' })],
        playlists: [
          {
            id: 'p1',
            name: 'Mix',
            description: null,
            songCount: 4,
            coverArt: null,
            kind: 'curated',
            createdAt: 0,
            modifiedAt: 0,
          } as PlaylistSummary,
        ],
        genres: [{ value: 'rock', songCount: 10 }],
      }),
    );
    expect(tiles.length).toBeGreaterThan(0);
    for (const t of tiles) {
      expect(['song', 'playlist', 'filter']).toContain(t.action.type);
    }
  });

  // The three song lanes genuinely overlap; packing the same song twice would
  // show it as separate tiles that do exactly the same thing.
  it('collapses a song appearing in several lanes into one tile', () => {
    const dup = song({ id: 'shared' });
    const tiles = buildMosaicTiles(emptySources({ keepVibe: [dup], tasteBreakers: [dup] }));
    expect(tiles.filter((t) => t.key === 'song:shared')).toHaveLength(1);
  });

  it('lets the resume tile win a collision with its own recent-play row', () => {
    const recent: RecentPlay = {
      songId: 'x',
      title: 'Track',
      artist: 'A',
      album: null,
      duration: null,
      coverArt: null,
      playedAt: 1,
    };
    const tiles = buildMosaicTiles(
      emptySources({ resume: { id: 'x', title: 'Track', artist: 'A' }, recentPlays: [recent] }),
    );
    const match = tiles.filter((t) => t.key === 'song:x');
    expect(match).toHaveLength(1);
    expect(match[0].kind).toBe('resume');
    expect(match[0].score).toBe(SCORE_WEIGHTS.resume);
  });

  it('carries popularity into the score when the API supplied it', () => {
    const hot = buildMosaicTiles(
      emptySources({ tasteBreakers: [song({ id: 'h', popularity: 1 })] }),
    );
    const cold = buildMosaicTiles(
      emptySources({ tasteBreakers: [song({ id: 'h', popularity: 0 })] }),
    );
    const scoreOf = (t: MosaicTile[]): number => t.find((x) => x.key === 'song:h')!.score;
    expect(scoreOf(hot)).toBeGreaterThan(scoreOf(cold));
  });

  it('scores a genre by song count or personal plays, whichever is stronger', () => {
    const tiles = buildMosaicTiles(
      emptySources({
        genres: [
          { value: 'rock', songCount: 100 },
          { value: 'jazz', songCount: 1 },
        ],
        stats: stats({ topGenres: [{ genre: 'jazz', plays: 50 }] }),
      }),
    );
    const jazz = tiles.find((t) => t.key === 'genre:jazz')!;
    const rock = tiles.find((t) => t.key === 'genre:rock')!;
    // Jazz is tiny by count but heavily played, so it holds its own.
    expect(jazz.score).toBeCloseTo(rock.score);
  });
});

describe('assignSongsToSlots', () => {
  const w = playWeights(null);
  const slots = [
    { id: 0, size: 100 },
    { id: 1, size: 200 },
    { id: 2, size: 150 },
  ];

  it('maps the highest score into the biggest slot, so size still means hotter', () => {
    const out = assignSongsToSlots(
      slots,
      [
        song({ id: 'cold', popularity: 0 }),
        song({ id: 'hot', popularity: 1 }),
        song({ id: 'mid', popularity: 0.5 }),
      ],
      w,
    );
    expect(out.get(1)!.key).toBe('song:hot');
    expect(out.get(2)!.key).toBe('song:mid');
    expect(out.get(0)!.key).toBe('song:cold');
  });

  it('dedupes a song the random batch returned twice', () => {
    const out = assignSongsToSlots(slots, [song({ id: 'a' }), song({ id: 'a' })], w);
    expect(out.size).toBe(1);
  });

  it('leaves surplus slots unassigned when the batch runs short', () => {
    const out = assignSongsToSlots(slots, [song({ id: 'only', popularity: 1 })], w);
    expect(out.size).toBe(1);
    // The one song still lands in the biggest slot, not an arbitrary one.
    expect(out.get(1)!.key).toBe('song:only');
  });

  it('returns an empty map for an empty batch', () => {
    expect(assignSongsToSlots(slots, [], w).size).toBe(0);
  });
});
