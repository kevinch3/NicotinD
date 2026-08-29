/**
 * Song-metadata mutation (issue #722) — the fourth instance of the shape
 * services/library-deletion.ts (#232), services/artist-identity-mutate.ts
 * (#339) and services/song-genre-mutate.ts (#677) established: an MCP curator
 * tool must run the *same* tested write an HTTP request runs, never a second
 * copy of the logic in routes/mcp.ts.
 *
 * The fix mechanism is a pure file-tag rewrite + incremental rescan — this
 * module NEVER renames or moves the file. `songId` is path-derived, so a tag
 * write keeps playlists/likes/play-history/genres intact; the name-derived
 * album id re-minting on rescan is the point (a fake YouTube single-album
 * dissolves, merging into the real album when the cleaned name collides).
 * Post-landing fixes that move files are forbidden — see the retag-vs-override
 * doctrine in docs/download-review.md.
 *
 * Deps are explicit params rather than a closure, and `recordAudit` stays
 * caller-side — the HTTP route audits as the logged-in curator, the MCP tool
 * as `agent:<tokenId>` with a `(via MCP agent)` suffix.
 */
import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { AudioTags } from './audio-tags.js';
import { writeAudioTags } from './audio-tags.js';
import { buildIdentifyApplyTags } from './identify.js';
import { expandDir, resolveSongPath, isUnderMusicDir } from './song-path.js';

export interface SongMetadataMutateDeps {
  musicDir?: string;
  scanIncremental?: (relPaths: string[]) => Promise<void>;
  /** Injectable for tests; defaults to the real tag writer. */
  writeTags?: typeof writeAudioTags;
}

export interface SongMetadataMutateBody {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  year?: number;
}

/** The subset of a song row a mutation can be verified against. */
export interface SongMetadataSnapshot {
  title: string;
  artist: string;
  album: string | null;
  year: number | null;
}

export type SongMetadataMutateResult =
  | {
      ok: true;
      old: SongMetadataSnapshot;
      /**
       * What the row ACTUALLY carries after the rescan — read back, never the
       * echoed request. Falls back to the request only when `verified` is false
       * (no rescanner wired, so there was nothing to read back through).
       */
      applied: AudioTags;
      rescanned: boolean;
      /** Whether every requested field was confirmed present on the row. */
      verified: boolean;
    }
  | {
      ok: false;
      error: string;
      status: 400 | 404 | 500 | 503;
      /** Set on a verification failure so the caller can see the divergence. */
      requested?: SongMetadataMutateBody;
      actual?: Partial<SongMetadataSnapshot>;
    };

interface SongRow {
  path: string;
  title: string;
  artist: string;
  album: string | null;
  year: number | null;
}

export async function mutateSongMetadata(
  db: Database,
  deps: SongMetadataMutateDeps,
  songId: string,
  body: SongMetadataMutateBody,
): Promise<SongMetadataMutateResult> {
  // Same guard as identify/apply: add/replace only, never clear a tag —
  // empty/placeholder strings and out-of-range years are dropped, not written.
  const tags = buildIdentifyApplyTags(body);
  if (!tags) return { ok: false, error: 'No applicable fields', status: 400 };

  const song = db
    .query<SongRow, [string]>(
      `SELECT s.path, s.title, s.artist, a.name AS album, s.year
       FROM library_songs s LEFT JOIN library_albums a ON a.id = s.album_id
       WHERE s.id = ?`,
    )
    .get(songId);
  if (!song) return { ok: false, error: 'Song not found', status: 404 };
  if (!deps.musicDir) return { ok: false, error: 'Music directory not configured', status: 503 };

  const md = expandDir(deps.musicDir);
  const abs = resolveSongPath(md, song.path);
  if (!isUnderMusicDir(md, abs) || !existsSync(abs)) {
    return { ok: false, error: 'Song file not found', status: 404 };
  }

  const ok = await (deps.writeTags ?? writeAudioTags)(abs, tags);
  if (!ok) return { ok: false, error: 'Failed to write tags', status: 500 };

  const old = { title: song.title, artist: song.artist, album: song.album, year: song.year };
  if (!deps.scanIncremental) {
    // Nothing to read back through — report the request and say so, rather
    // than claiming a verification we did not perform.
    return { ok: true, old, applied: tags, rescanned: false, verified: false };
  }
  await deps.scanIncremental([relative(md, abs)]);

  // Read the row back. `applied` echoing the request made a silently-lost write
  // indistinguishable from success: ffmpeg exits 0, the tag lands on disk, and
  // the rescan then drops the file (issue #776), leaving the DB untouched while
  // the caller is told it worked. Anything automating retags — an MCP agent, the
  // bulk normalize of #775 — would report a clean run having changed nothing.
  const after = readSnapshot(db, songId);
  if (!after) return { ok: false, error: 'Song not found after rescan', status: 404 };

  const diverged: Partial<SongMetadataSnapshot> = {};
  if (tags.title !== undefined && after.title !== tags.title) diverged.title = after.title;
  if (tags.artist !== undefined && after.artist !== tags.artist) diverged.artist = after.artist;
  if (tags.album !== undefined && after.album !== tags.album) diverged.album = after.album;
  if (tags.year !== undefined && after.year !== tags.year) diverged.year = after.year;

  if (Object.keys(diverged).length > 0) {
    return {
      ok: false,
      error: 'Tag write did not persist',
      status: 500,
      requested: body,
      actual: diverged,
    };
  }

  return {
    ok: true,
    old,
    // Read back, not echoed.
    applied: { ...tags, ...pickApplied(after, tags) },
    rescanned: true,
    verified: true,
  };
}

function readSnapshot(db: Database, songId: string): SongMetadataSnapshot | null {
  return (
    db
      .query<SongMetadataSnapshot, [string]>(
        `SELECT s.title, s.artist, a.name AS album, s.year
         FROM library_songs s LEFT JOIN library_albums a ON a.id = s.album_id
         WHERE s.id = ?`,
      )
      .get(songId) ?? null
  );
}

/** The verified values for exactly the fields the caller asked to change. */
function pickApplied(after: SongMetadataSnapshot, tags: AudioTags): Partial<AudioTags> {
  const out: Partial<AudioTags> = {};
  if (tags.title !== undefined) out.title = after.title;
  if (tags.artist !== undefined) out.artist = after.artist;
  if (tags.album !== undefined && after.album !== null) out.album = after.album;
  if (tags.year !== undefined && after.year !== null) out.year = after.year;
  return out;
}
