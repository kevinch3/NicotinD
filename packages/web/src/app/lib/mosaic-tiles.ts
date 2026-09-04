import type { LibraryFilter } from '@nicotind/core';
import type { Track } from '../services/player.service';
import type { ListeningStats, PlaylistSummary, RecentPlay, Song } from '../services/api/api-types';
import type { PreservedTrackMeta } from './preserve-store';
import { toTrack } from './track-utils';
import { VIBE_PRESETS } from './vibe-presets';

/**
 * The mosaic home's data model: every landing source flattened into one list of
 * tiles, each carrying the single action it performs. Pure and DOM-free — the
 * component owns the render loop, this owns what there is to render.
 *
 * The one rule the whole surface rests on: **every tile starts a radio.** The
 * classic landing used four different playback verbs depending on which shelf a
 * cover sat in; here `MosaicAction` has three shapes and all three are radio
 * starts. See docs/web-ui.md.
 */

export type MosaicTileKind = 'song' | 'playlist' | 'vibe' | 'genre' | 'downloads';

/**
 * What tapping a tile does.
 *
 * The first three are the online surface, and all three are radio starts —
 * the rule the whole mosaic is built on. The last two exist only offline,
 * where **radio is not a thing that can happen**: every radio provider fetches
 * its next tracks from the server. So offline a tile plays out of the
 * downloaded set instead, and exactly one tile navigates to that set.
 */
export type MosaicAction =
  | { type: 'song'; track: Track }
  | { type: 'playlist'; playlistId: string }
  | { type: 'filter'; filter: LibraryFilter }
  /** Offline: play this track with the whole downloaded set as its queue. */
  | { type: 'offline'; track: Track }
  /** Offline: the one tile that navigates rather than plays. */
  | { type: 'route'; path: string };

export interface MosaicTile {
  /** Stable identity across reloads — also the dedupe key and the jitter seed. */
  key: string;
  kind: MosaicTileKind;
  title: string;
  subtitle: string;
  /** 0..1; drives tile size through `tileSize`. */
  score: number;
  action: MosaicAction;
  /** Cover *id* (never a URL) for song and playlist tiles. */
  coverArt?: string;
  /** Tailwind `from-*`/`to-*` pair for vibe tiles. */
  gradient?: string;
  emoji?: string;
}

export interface MosaicSources {
  /** "Keep the vibe" — the list-seeded radio pool over the recent plays; `LANE_MIX` draws from it. */
  keepVibe: Song[];
  /** "Taste breakers" — random library picks; they fill whatever the drawn lanes leave. */
  tasteBreakers: Song[];
  /** The recent-plays pool, newest first; `LANE_MIX` draws from it. */
  recentPlays: RecentPlay[];
  /** Curated playlists only (the Tastemakers shelf's source). */
  playlists: PlaylistSummary[];
  genres: Array<{ value: string; songCount: number }>;
  /** The caller's own listening aggregates; null when history is off or empty. */
  stats: ListeningStats | null;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * The weights that decide what the eye lands on first. This block is the
 * mosaic's personality and is meant to be tuned by hand.
 *
 * Two facts constrain any choice here:
 *
 *  - **`popularity` is mostly absent.** Prod coverage is ~3%, and roughly half
 *    the library can never score at all (no recording-MBID tag — a permanent,
 *    ledgered miss, not a backlog). So it cannot be the primary term today, and
 *    substituting a constant for it would flatten every tile to one size.
 *  - **Absent is not zero.** `normalizePopularity` maps a real zero-listen
 *    recording to 0, so `?? 0` conflates "nobody listened" with "we never
 *    looked". Unknown popularity redistributes its weight onto the caller's own
 *    plays plus a stable per-key jitter, rather than being defaulted.
 */
export const SCORE_WEIGHTS = {
  /** Song floor, before any signal is added. */
  songBase: 0.35,
  /** Applied to `popularity` when it is known. */
  songPopularity: 0.4,
  /** Applied to the caller's own play share when popularity is known. */
  songPlaysWithPopularity: 0.25,
  /** Applied to the caller's own play share when popularity is unknown. */
  songPlaysWithoutPopularity: 0.45,
  /** Applied to the per-key hash when popularity is unknown. */
  songJitter: 0.2,
  /** Vibes have no comparable signal, so they sit at a fixed band. */
  vibe: 0.78,
  genreBase: 0.4,
  genreShare: 0.35,
  playlistBase: 0.45,
  playlistShare: 0.3,
  /** Offline floor. Popularity and play stats both need the server. */
  offlineBase: 0.4,
  /** Most-recently downloaded reads largest — the only ranking left offline. */
  offlineRecency: 0.3,
  offlineJitter: 0.2,
  /** The offline "Downloads" tile, prominent because it is the way out. */
  downloads: 0.9,
} as const;

/**
 * The recipe: how the home cell's song slots are split between the three song
 * lanes. The second hand-tuned block beside `SCORE_WEIGHTS`.
 *
 * The first cut filled every lane to the brim — twenty recent plays, ten
 * keep-the-vibe variations, twenty-four random picks — which made more than
 * half the song tiles "your last session", and made the wall the same on every
 * visit, because history barely moves between two mornings. The remedy is a
 * draw, not a smaller fetch: a lane still fetches its whole `pool`, and shows
 * `tiles` of it chosen uniformly at random per visit. So each recent play has
 * `tiles / pool` odds of being on the wall today, no two visits compose the
 * same wall, and the plays that lost the draw still seed the vibe. Taste
 * breakers fill the rest of `songSlots`, skipping anything either pool holds —
 * a recent play that lost its draw must not walk back in as "random", or the
 * caps would be a fiction — so a fresh install with no history still gets a
 * full field of random picks.
 */
export const LANE_MIX = {
  /** Song tiles the home cell holds, across the three song lanes. */
  songSlots: 54,
  /** Recently played: `tiles` of the newest `pool` plays. */
  recent: { pool: 20, tiles: 10 },
  /** Keep the vibe: `tiles` of `pool` variations, seeded by the whole recent pool. */
  keepVibe: { pool: 20, tiles: 10 },
} as const;

/**
 * `n` of `items`, drawn uniformly without replacement (a partial Fisher–Yates),
 * in draw order. The rng is a parameter so a spec can seed it: the draw is
 * *meant* to differ between visits, but a test must be able to say which ten
 * it expects. `shuffleArray` in player.service takes no rng, which is why this
 * is not it.
 */
export function drawFrom<T>(items: readonly T[], n: number, rng: () => number): T[] {
  const pool = [...items];
  const count = Math.max(0, Math.min(n, pool.length));
  for (let i = 0; i < count; i++) {
    const j = i + Math.min(pool.length - 1 - i, Math.floor(rng() * (pool.length - i)));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * FNV-1a over the tile key → 0..1. Deterministic, so a tile is the same size on
 * every visit; `Math.random()` here would resize the whole mosaic on reload.
 */
export function jitter(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

export interface PlayWeights {
  /** songId → plays as a share of the most-played song. */
  bySong: Map<string, number>;
  /** lowercased artist → plays as a share of the most-played artist. */
  byArtist: Map<string, number>;
  /** lowercased genre → plays as a share of the most-played genre. */
  byGenre: Map<string, number>;
}

const shareMap = <T>(
  rows: readonly T[],
  key: (r: T) => string,
  plays: (r: T) => number,
): Map<string, number> => {
  const max = rows.reduce((m, r) => Math.max(m, plays(r)), 0);
  const out = new Map<string, number>();
  if (max <= 0) return out;
  for (const r of rows) out.set(key(r), clamp01(plays(r) / max));
  return out;
};

/**
 * Normalize the listening aggregates into lookup maps. `topSongs` is capped at
 * ten server-side, which is why the artist map matters: it is what gives the
 * other ~70 song tiles any personal signal at all.
 */
export function playWeights(stats: ListeningStats | null): PlayWeights {
  if (!stats) return { bySong: new Map(), byArtist: new Map(), byGenre: new Map() };
  return {
    bySong: shareMap(
      stats.topSongs,
      (r) => r.songId,
      (r) => r.plays,
    ),
    byArtist: shareMap(
      stats.topArtists,
      (r) => r.artist.toLowerCase(),
      (r) => r.plays,
    ),
    byGenre: shareMap(
      stats.topGenres,
      (r) => r.genre.toLowerCase(),
      (r) => r.plays,
    ),
  };
}

/** The caller's own affinity for one song: exact play share, else its artist's, else none. */
export function ownPlayShare(
  songId: string,
  artist: string | null | undefined,
  w: PlayWeights,
): number {
  const exact = w.bySong.get(songId);
  if (exact !== undefined) return exact;
  if (artist) return w.byArtist.get(artist.toLowerCase()) ?? 0;
  return 0;
}

/**
 * Score one song tile. `popularity` is read with a typeof guard, never `?? 0`
 * — see the note on SCORE_WEIGHTS for why absent and zero are different facts.
 */
export function scoreSong(
  key: string,
  songId: string,
  artist: string | null | undefined,
  popularity: number | undefined,
  w: PlayWeights,
): number {
  const plays = ownPlayShare(songId, artist, w);
  const k = SCORE_WEIGHTS;
  if (typeof popularity === 'number') {
    return clamp01(
      k.songBase + k.songPopularity * clamp01(popularity) + k.songPlaysWithPopularity * plays,
    );
  }
  return clamp01(k.songBase + k.songPlaysWithoutPopularity * plays + k.songJitter * jitter(key));
}

/**
 * Score → rendered pixel size, scaled to the stage rather than a fixed range:
 * the same constants must work on a 390px phone and a 1400px desktop. At a
 * 620px short side this reproduces the original 93–242px band.
 */
export function tileSize(score: number, stageMin: number): number {
  return Math.round(stageMin * (0.15 + clamp01(score) * 0.24));
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/** One library song as a mosaic tile — the shape both the home patch and the
 *  discovery cells build from. */
export function songToTile(s: Song, w: PlayWeights): MosaicTile {
  const key = `song:${s.id}`;
  return {
    key,
    kind: 'song',
    title: s.title,
    subtitle: s.artist,
    score: scoreSong(key, s.id, s.artist, s.popularity, w),
    action: { type: 'song', track: toTrack(s) },
    coverArt: s.coverArt,
  };
}

const recentToTrack = (p: RecentPlay): Track =>
  toTrack({
    id: p.songId,
    title: p.title ?? 'Unknown title',
    artist: p.artist ?? 'Unknown artist',
    album: p.album ?? undefined,
    coverArt: p.coverArt ?? undefined,
    duration: p.duration ?? undefined,
  });

/** One recent play as a mosaic tile. */
function recentToTile(p: RecentPlay, w: PlayWeights): MosaicTile {
  const key = `song:${p.songId}`;
  return {
    key,
    kind: 'song',
    title: p.title ?? 'Unknown title',
    subtitle: p.artist ?? 'Unknown artist',
    // A recent play carries no popularity — the history row is a snapshot,
    // not a library read — so it always takes the unknown-popularity branch.
    score: scoreSong(key, p.songId, p.artist, undefined, w),
    action: { type: 'song', track: recentToTrack(p) },
    coverArt: p.coverArt ?? undefined,
  };
}

/**
 * Flatten every source into one deduped tile list, the song lanes drawn by
 * `LANE_MIX`. `rng` is injectable so a spec can seed the draw; production
 * takes the default.
 *
 * The breakers' `held` set is the lane-level dedupe, done up front: a song
 * either pool holds is skipped rather than collapsed later, so the slot count
 * comes out right. `dedupeTiles` at the end still guards the remainder — two
 * lanes can in principle hand back one id, and packing it twice would show two
 * tiles that do exactly the same thing.
 */
export function buildMosaicTiles(
  sources: MosaicSources,
  rng: () => number = Math.random,
): MosaicTile[] {
  const w = playWeights(sources.stats);
  const tiles: MosaicTile[] = [];

  const recent = drawFrom(sources.recentPlays, LANE_MIX.recent.tiles, rng);
  const keepVibe = drawFrom(sources.keepVibe, LANE_MIX.keepVibe.tiles, rng);
  for (const p of recent) tiles.push(recentToTile(p, w));
  for (const s of keepVibe) tiles.push(songToTile(s, w));

  // Breakers fill what the two draws left, and never re-admit a song either
  // *pool* holds: a recent play that lost its draw must not walk back in as
  // "random", or `LANE_MIX`'s caps would be a fiction.
  const held = new Set<string>(sources.recentPlays.map((p) => p.songId));
  for (const s of sources.keepVibe) held.add(s.id);
  let room = LANE_MIX.songSlots - recent.length - keepVibe.length;
  for (const s of sources.tasteBreakers) {
    if (room <= 0) break;
    if (held.has(s.id)) continue;
    held.add(s.id);
    tiles.push(songToTile(s, w));
    room--;
  }

  const maxPlaylistSongs = sources.playlists.reduce((m, p) => Math.max(m, p.songCount), 0);
  for (const p of sources.playlists) {
    const share = maxPlaylistSongs > 0 ? p.songCount / maxPlaylistSongs : 0;
    tiles.push({
      key: `playlist:${p.id}`,
      kind: 'playlist',
      title: p.name,
      subtitle: `${p.songCount} songs`,
      score: clamp01(SCORE_WEIGHTS.playlistBase + SCORE_WEIGHTS.playlistShare * share),
      action: { type: 'playlist', playlistId: p.id },
      coverArt: undefined,
    });
  }

  for (const preset of VIBE_PRESETS) {
    tiles.push({
      key: `vibe:${preset.id}`,
      kind: 'vibe',
      title: preset.label,
      subtitle: 'radio',
      score: SCORE_WEIGHTS.vibe,
      action: { type: 'filter', filter: preset.filter },
      gradient: preset.gradient,
      emoji: preset.emoji,
    });
  }

  const maxGenreSongs = sources.genres.reduce((m, g) => Math.max(m, g.songCount), 0);
  for (const g of sources.genres) {
    const byCount = maxGenreSongs > 0 ? g.songCount / maxGenreSongs : 0;
    const byPlays = w.byGenre.get(g.value.toLowerCase()) ?? 0;
    tiles.push({
      key: `genre:${g.value}`,
      kind: 'genre',
      title: g.value,
      subtitle: `${g.songCount} songs`,
      score: clamp01(
        SCORE_WEIGHTS.genreBase + SCORE_WEIGHTS.genreShare * Math.max(byCount, byPlays),
      ),
      action: { type: 'filter', filter: { genres: [g.value] } },
    });
  }

  return dedupeTiles(tiles);
}

/**
 * Fill an already-packed slot geometry with a fresh batch of songs — the
 * discovery cells' content mapping.
 *
 * The torus repeats the home patch's *geometry*, but repeating its *content*
 * is what made exploring feel like a loop. Every cell but home substitutes its
 * own batch into the same slots, best score into the biggest slot, so tile
 * size keeps meaning "hotter" out in the field. Surplus slots (a batch smaller
 * than the patch) are simply left unassigned and the renderer skips them.
 */
export function assignSongsToSlots(
  slots: ReadonlyArray<{ id: number; size: number }>,
  songs: readonly Song[],
  w: PlayWeights,
): Map<number, MosaicTile> {
  const tiles = dedupeTiles(songs.map((s) => songToTile(s, w)));
  tiles.sort((a, b) => b.score - a.score);
  const bySize = [...slots].sort((a, b) => b.size - a.size);
  const out = new Map<number, MosaicTile>();
  for (let k = 0; k < bySize.length && k < tiles.length; k++) out.set(bySize[k].id, tiles[k]);
  return out;
}

/**
 * The mosaic with no network: the downloaded set, plus the one tile that
 * navigates to it.
 *
 * Radio is deliberately absent. Every radio provider fetches its next tracks
 * from the server, so offline the only honest verb is "play what is on this
 * device" — `playWithContext` over the whole downloaded set, the same verb and
 * context the Library's offline Songs tab uses.
 *
 * Covers are omitted rather than pointed at `/api/cover/:id`: that request
 * cannot succeed offline, and a face with no `coverArt` already falls back to
 * the deterministic placeholder gradient. Reading the cover blobs out of
 * IndexedDB per tile would put object-URL lifetimes inside a recycling pool,
 * which is where leaks live — a fallback surface is not worth that.
 *
 * Sizing has no popularity and no play stats to work with (both are server
 * reads), so it ranks on what the device itself knows: how recently each track
 * was downloaded, plus the usual stable jitter so the field stays varied.
 */
export function buildOfflineTiles(
  tracks: readonly PreservedTrackMeta[],
  downloadsPath: string,
): MosaicTile[] {
  if (tracks.length === 0) return [];

  const byRecency = [...tracks].sort((a, b) => b.preservedAt - a.preservedAt);
  const recency = new Map(
    byRecency.map((t, i) => [t.id, tracks.length > 1 ? 1 - i / (tracks.length - 1) : 1]),
  );

  const k = SCORE_WEIGHTS;
  const tiles: MosaicTile[] = tracks.map((t) => {
    const key = `song:${t.id}`;
    return {
      key,
      kind: 'song' as const,
      title: t.title,
      subtitle: t.artist,
      score: clamp01(
        k.offlineBase + k.offlineRecency * (recency.get(t.id) ?? 0) + k.offlineJitter * jitter(key),
      ),
      action: { type: 'offline' as const, track: toTrack(t) },
    };
  });

  tiles.push({
    key: 'downloads',
    kind: 'downloads',
    title: 'Downloads',
    subtitle: `${tracks.length} on this device`,
    score: k.downloads,
    action: { type: 'route', path: downloadsPath },
    gradient: 'from-slate-500 to-slate-700',
    emoji: '⬇️',
  });

  return dedupeTiles(tiles);
}

/** Collapse tiles sharing a key, keeping the highest-scoring one. */
export function dedupeTiles(tiles: readonly MosaicTile[]): MosaicTile[] {
  const best = new Map<string, MosaicTile>();
  for (const t of tiles) {
    const prev = best.get(t.key);
    if (!prev || t.score > prev.score) best.set(t.key, t);
  }
  return [...best.values()];
}
