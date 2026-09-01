import type { LibraryFilter } from '@nicotind/core';
import type { Track } from '../services/player.service';
import type { ListeningStats, PlaylistSummary, RecentPlay, Song } from '../services/api/api-types';
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

export type MosaicTileKind = 'resume' | 'song' | 'playlist' | 'vibe' | 'genre';

/** What tapping a tile does. Three shapes, all of them a radio start. */
export type MosaicAction =
  | { type: 'song'; track: Track }
  | { type: 'playlist'; playlistId: string }
  | { type: 'filter'; filter: LibraryFilter };

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
  resume: Track | null;
  /** "Keep the vibe" — list-seeded radio over the recent plays. */
  keepVibe: Song[];
  /** "Taste breakers" — random library picks. */
  tasteBreakers: Song[];
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
  /** The resume tile is always the largest — it is the one-tap continue. */
  resume: 1,
  /** Vibes have no comparable signal, so they sit at a fixed band. */
  vibe: 0.78,
  genreBase: 0.4,
  genreShare: 0.35,
  playlistBase: 0.45,
  playlistShare: 0.3,
} as const;

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

const recentToTrack = (p: RecentPlay): Track =>
  toTrack({
    id: p.songId,
    title: p.title ?? 'Unknown title',
    artist: p.artist ?? 'Unknown artist',
    album: p.album ?? undefined,
    coverArt: p.coverArt ?? undefined,
    duration: p.duration ?? undefined,
  });

/**
 * Flatten every source into one deduped tile list.
 *
 * Dedupe is load-bearing, not defensive: the three song lanes genuinely
 * overlap — a track can be recently played AND a taste breaker AND a keep-the-
 * vibe pick — and packing the same song two or three times would show it as
 * separate tiles that all do the same thing. Highest score wins, so the resume
 * tile survives a collision with its own recent-play row.
 */
export function buildMosaicTiles(sources: MosaicSources): MosaicTile[] {
  const w = playWeights(sources.stats);
  const tiles: MosaicTile[] = [];

  if (sources.resume) {
    const t = sources.resume;
    tiles.push({
      key: `song:${t.id}`,
      kind: 'resume',
      title: t.title,
      subtitle: t.artist,
      score: SCORE_WEIGHTS.resume,
      action: { type: 'song', track: t },
      coverArt: t.coverArt,
    });
  }

  const pushSong = (s: Song): void => {
    const key = `song:${s.id}`;
    tiles.push({
      key,
      kind: 'song',
      title: s.title,
      subtitle: s.artist,
      score: scoreSong(key, s.id, s.artist, s.popularity, w),
      action: { type: 'song', track: toTrack(s) },
      coverArt: s.coverArt,
    });
  };
  for (const s of sources.keepVibe) pushSong(s);
  for (const s of sources.tasteBreakers) pushSong(s);

  for (const p of sources.recentPlays) {
    const key = `song:${p.songId}`;
    tiles.push({
      key,
      kind: 'song',
      title: p.title ?? 'Unknown title',
      subtitle: p.artist ?? 'Unknown artist',
      // A recent play carries no popularity — the history row is a snapshot,
      // not a library read — so it always takes the unknown-popularity branch.
      score: scoreSong(key, p.songId, p.artist, undefined, w),
      action: { type: 'song', track: recentToTrack(p) },
      coverArt: p.coverArt ?? undefined,
    });
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

/** Collapse tiles sharing a key, keeping the highest-scoring one. */
export function dedupeTiles(tiles: readonly MosaicTile[]): MosaicTile[] {
  const best = new Map<string, MosaicTile>();
  for (const t of tiles) {
    const prev = best.get(t.key);
    if (!prev || t.score > prev.score) best.set(t.key, t);
  }
  return [...best.values()];
}
