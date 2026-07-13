/**
 * Automated system-shelf materialization: turn the code-defined `RECIPES` into
 * `kind='curated'` playlists and refresh them on a weekly cadence. Reuses the
 * pure selection/ordering engine (`runRecipe`) and the same idempotent upsert
 * the curated seed script uses — so automated shelves and hand-seeded curated
 * shelves share one write path and both appear in "Made for you" unchanged.
 *
 * The in-process weekly guard (`maybeRefreshAutoPlaylists`) is driven from the
 * windowed processor's tick; a `library_sync_state` marker ensures at most one
 * refresh per ISO week.
 */
import type { Database } from 'bun:sqlite';
import { RECIPES, runRecipe, weekSeedFor, type PlaylistRecipe, type OrderableRow } from './playlist-recipe.js';
import { expandGenreWhere } from './curated-playlists.js';
import { createLogger } from '@nicotind/core';

const log = createLogger('auto-playlists');
const WEEK_MARKER = 'auto_playlists_week';

interface CuratedMeta {
  name: string;
  description: string;
  slug: string;
}

/** Candidate row shape returned by the per-recipe query. */
interface RecipeRow {
  id: string;
  artist: string;
  artistId: string;
  bpm: number | null;
  key: string | null;
  year: number | null;
  duration: number;
  energy: number | null;
  valence: number | null;
  danceability: number | null;
  instrumental: number | null;
  acousticness: number | null;
  created: string | null;
}

function toOrderable(r: RecipeRow): OrderableRow {
  const addedAt = r.created ? Date.parse(r.created) : undefined;
  return {
    id: r.id,
    artist: r.artist,
    artistId: r.artistId,
    bpm: r.bpm ?? undefined,
    key: r.key ?? undefined,
    year: r.year ?? undefined,
    duration: r.duration,
    energy: r.energy ?? undefined,
    valence: r.valence ?? undefined,
    danceability: r.danceability ?? undefined,
    instrumental: r.instrumental ?? undefined,
    acousticness: r.acousticness ?? undefined,
    addedAt: Number.isNaN(addedAt) ? undefined : addedAt,
  };
}

/**
 * Idempotent upsert of a single `kind='curated'` playlist and its ordered song
 * ids. Matches an existing playlist by (kind='curated', name); replaces its
 * songs and refreshes cover/description so re-running is safe (no duplicates,
 * stable id/URL). Extracted so the seed script and the recipe runner share it.
 * Must run inside a caller-provided transaction.
 */
export function upsertCuratedPlaylist(
  db: Database,
  ownerId: string,
  meta: CuratedMeta,
  songIds: string[],
  now: number,
): void {
  const existing = db
    .query<{ id: string }, [string]>("SELECT id FROM playlists WHERE kind = 'curated' AND name = ?")
    .get(meta.name);
  const id = existing?.id ?? crypto.randomUUID();
  const coverArt = `/playlist-covers/${meta.slug}.svg`;
  if (existing) {
    db.run(`UPDATE playlists SET description = ?, cover_art = ?, modified_at = ? WHERE id = ?`, [
      meta.description,
      coverArt,
      now,
      id,
    ]);
    db.run(`DELETE FROM playlist_songs WHERE playlist_id = ?`, [id]);
  } else {
    db.run(
      `INSERT INTO playlists (id, user_id, name, description, cover_art, kind, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, 'curated', ?, ?)`,
      [id, ownerId, meta.name, meta.description, coverArt, now, now],
    );
  }
  const insert = db.prepare(
    `INSERT INTO playlist_songs (playlist_id, song_id, position, added_at) VALUES (?, ?, ?, ?)`,
  );
  songIds.forEach((songId, i) => insert.run(id, songId, i, now));
}

/** First admin — the provenance owner for curated rows (visibility is by kind). */
function firstAdminId(db: Database): string | null {
  const admin = db
    .query<{ id: string }, []>(
      "SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1",
    )
    .get();
  return admin?.id ?? null;
}

/** Query candidate rows for a recipe (hidden excluded), mapped to OrderableRow. */
function candidatesFor(db: Database, recipe: PlaylistRecipe): OrderableRow[] {
  const rows = db
    .query<RecipeRow, []>(
      `SELECT s.id AS id, s.artist AS artist, s.artist_id AS artistId,
              s.bpm AS bpm, s.key AS key, s.year AS year, s.duration AS duration,
              s.energy AS energy, s.valence AS valence, s.danceability AS danceability,
              s.instrumental AS instrumental, s.acousticness AS acousticness,
              s.created AS created
         FROM library_songs s
        WHERE s.hidden = 0 AND s.landed_at IS NOT NULL AND (${expandGenreWhere(recipe.where)})`,
    )
    .all();
  return rows.map(toOrderable);
}

export interface RefreshResult {
  slug: string;
  name: string;
  count: number;
}

/**
 * Materialize every recipe for the ISO week containing `now`. With `apply`,
 * writes each shelf in its own transaction (idempotent upsert); without, only
 * computes counts (dry run). Returns per-recipe counts for logging/tests.
 */
export function refreshAutoPlaylists(
  db: Database,
  now: number,
  opts: { apply: boolean } = { apply: true },
): RefreshResult[] {
  const weekSeed = weekSeedFor(now);
  const plans = RECIPES.map((recipe) => ({
    recipe,
    songIds: runRecipe(recipe, candidatesFor(db, recipe), weekSeed),
  }));

  if (opts.apply) {
    const ownerId = firstAdminId(db);
    if (!ownerId) throw new Error('No admin user found — cannot materialize automated playlists.');
    const writeOne = db.transaction((recipe: PlaylistRecipe, songIds: string[]) => {
      upsertCuratedPlaylist(
        db,
        ownerId,
        { name: recipe.name, description: recipe.description, slug: recipe.slug },
        songIds,
        now,
      );
    });
    // Zero-candidate recipes (e.g. perceptual-feature shelves before the
    // enrichment backfill has run) don't CREATE empty shelves. An already-
    // materialized shelf still updates — even to empty — so tracks that left
    // the library drain out on refresh.
    for (const { recipe, songIds } of plans) {
      const exists = db
        .query<{ id: string }, [string]>(
          "SELECT id FROM playlists WHERE kind = 'curated' AND name = ?",
        )
        .get(recipe.name);
      if (songIds.length > 0 || exists) writeOne(recipe, songIds);
    }
  }

  return plans.map(({ recipe, songIds }) => ({
    slug: recipe.slug,
    name: recipe.name,
    count: songIds.length,
  }));
}

function readMarker(db: Database, key: string): string | null {
  const row = db
    .query<{ value: string }, [string]>('SELECT value FROM library_sync_state WHERE key = ?')
    .get(key);
  return row?.value ?? null;
}

function writeMarker(db: Database, key: string, value: string, now: number): void {
  db.run(
    `INSERT INTO library_sync_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, now],
  );
}

/**
 * Refresh automated shelves at most once per ISO week. No-op (returns false)
 * when the current week's marker is already set or there is no admin owner. Safe
 * to call every processor tick. Returns true when a refresh was performed.
 */
export function maybeRefreshAutoPlaylists(db: Database, now: number): boolean {
  const week = String(weekSeedFor(now));
  if (readMarker(db, WEEK_MARKER) === week) return false;
  if (!firstAdminId(db)) return false;
  try {
    const results = refreshAutoPlaylists(db, now, { apply: true });
    writeMarker(db, WEEK_MARKER, week, now);
    log.info({ week, shelves: results.length }, 'auto-playlists refreshed');
    return true;
  } catch (err) {
    log.error({ err }, 'auto-playlists refresh failed');
    return false;
  }
}
