/**
 * Download inbox triage (issue #411): the curator-facing surface for the
 * quarantine-hold review queue — list pending albums, approve (recorded
 * decision, no file changes), or discard (delete the album outright), and
 * (this file's second half) fingerprint-identify a mis-tagged track and
 * retag it in place before landing.
 * Mounted read-only-auth-gated at /api/review; see routes/review.ts for the
 * unrelated admin ServiceReview snapshot.
 */
import { join, normalize, relative } from 'node:path';
import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import type { IdentifyCapability, IdentifyOutcome, IdentifyResult } from '@nicotind/core';
import { getDatabase } from '../db.js';
import type { AuthEnv } from '../middleware/auth.js';
import { requireCurator } from '../middleware/current-user.js';
import { errorHandler } from '../middleware/error-handler.js';
import { recordAudit } from '../services/audit-log.js';
import { deleteAlbum } from '../services/library-deletion.js';
import type { ShareRescanScheduler } from '../services/share-rescan-scheduler.js';
import type { PluginRegistry } from '../services/plugins/registry.js';
import { normalizeTagValue, writeAudioTags, type AudioTags } from '../services/audio-tags.js';
import { fold } from '../services/search-tokens.js';
import { getProcessingSettings } from '../services/processing-settings.js';
import {
  loadReviewQueue,
  pendingReviewStats,
  recordReviewDecision,
  reviewHoldActive,
} from '../services/download-review-store.js';

export interface DownloadReviewDeps {
  musicDir?: string;
  shareRescan: ShareRescanScheduler;
  /** Late-bound processing nudge — landing a hold decision shouldn't wait for
   *  the next window tick. */
  kickEager?: () => Promise<void>;
  /** Plugin registry, consulted for an enabled `identify` capability. */
  plugins?: PluginRegistry | null;
  /** Incremental rescan hook, run after a retag lands new tags on disk. */
  scanIncremental?: (relPaths: string[]) => Promise<void>;
  /** Overridable for tests; defaults to services/audio-tags.js `writeAudioTags`. */
  writeTags?: (abs: string, tags: AudioTags) => Promise<boolean>;
}

// Same three-helper path-safety triad as routes/library.ts (~L1786-1789) /
// services/library-deletion.ts — kept as a local copy rather than an import
// since neither original exports them.
function expandDir(dir: string): string {
  if (dir.startsWith('~')) {
    return join(process.env.HOME ?? '/root', dir.slice(1));
  }
  return dir;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:\//.test(path);
}

function resolveSongPath(musicDir: string, songPath: string): string {
  const normalizedSongPath = songPath.replace(/\\/g, '/');
  if (isAbsolutePath(normalizedSongPath)) {
    return normalize(normalizedSongPath);
  }
  return normalize(join(musicDir, normalizedSongPath));
}

function isUnderMusicDir(musicDir: string, candidatePath: string): boolean {
  const rel = relative(musicDir, candidatePath);
  return rel !== '' && !rel.startsWith('..');
}

function identifyPlugin(deps: DownloadReviewDeps): IdentifyCapability | null {
  const hits = deps.plugins?.getEnabledWithCapability('identify') ?? [];
  const p = hits[0] as { identify?: IdentifyCapability } | undefined;
  return p?.identify ?? null;
}

/**
 * Groups successful fingerprint results by folded `(albumArtist ?? artist,
 * album)` and returns the majority pick, or null when there's no clear
 * winner — a lone match or a tie isn't enough to suggest a retag.
 */
export function voteAlbumIdentity(
  results: Array<IdentifyResult | null>,
): { artist: string; album: string; votes: number; total: number } | null {
  const successful = results.filter((r): r is IdentifyResult => r !== null && !!r.artist);
  const total = successful.length;
  if (total === 0) return null;

  const groups = new Map<string, { artist: string; album: string; votes: number }>();
  for (const r of successful) {
    const artist = r.artist ?? '';
    const album = r.album ?? '';
    const key = `${fold(artist)}\u0000${fold(album)}`;
    const existing = groups.get(key);
    if (existing) {
      existing.votes += 1;
    } else {
      groups.set(key, { artist, album, votes: 1 });
    }
  }

  let winner: { artist: string; album: string; votes: number } | null = null;
  for (const group of groups.values()) {
    if (!winner || group.votes > winner.votes) winner = group;
  }
  if (!winner) return null;
  if (winner.votes < 2 || winner.votes <= total / 2) return null;

  return { artist: winner.artist, album: winner.album, votes: winner.votes, total };
}

export function downloadReviewRoutes(deps: DownloadReviewDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  // Self-contained error mapping, mirroring library.ts, so requireCurator's
  // ForbiddenError maps to 403 even when this router is mounted bare (route
  // tests) without the app-level onError.
  app.onError(errorHandler);

  app.get('/queue', (c) => {
    requireCurator(c);
    const db = getDatabase();
    // With the toggle off, or before the bootstrap-exemption marker has armed
    // (issue #417 — see download-review-store.ts), `graduatePending` never
    // waits on a review decision, so surfacing quarantined albums here would
    // offer a real Discard for a "hold" that isn't actually in effect.
    if (!reviewHoldActive(db, getProcessingSettings(db).holdForReview)) {
      return c.json({ albums: [] });
    }
    return c.json({ albums: loadReviewQueue(db) });
  });

  app.get('/count', (c) => {
    requireCurator(c);
    const db = getDatabase();
    const { pending } = pendingReviewStats(db, getProcessingSettings(db).holdForReview);
    return c.json({ pending });
  });

  app.post('/albums/:id/approve', (c) => {
    const user = requireCurator(c);
    const db = getDatabase();
    const id = c.req.param('id');
    recordReviewDecision(db, id, 'approved', user.sub);
    recordAudit(db, user, 'download_review.approve', { targetKind: 'album', targetId: id });
    void deps.kickEager?.();
    return c.json({ ok: true });
  });

  app.post('/albums/:id/discard', async (c) => {
    const user = requireCurator(c);
    const db = getDatabase();
    const id = c.req.param('id');
    const result = await deleteAlbum(db, id, {
      musicDir: deps.musicDir,
      shareRescan: deps.shareRescan,
    });
    if (!result) return c.json({ error: 'Album not found' }, 404);
    recordReviewDecision(db, id, 'discarded', user.sub);
    recordAudit(db, user, 'download_review.discard', {
      targetKind: 'album',
      targetId: id,
      detail: result.albumRow ? `${result.albumRow.artist} — ${result.albumRow.name}` : undefined,
    });
    return c.json({ ok: true, deletedCount: result.deletedCount });
  });

  /**
   * One identify attempt, always as a typed outcome (issue #414). Falls back to
   * mapping a plain `identifyTrack` null onto `no-match` for a plugin that
   * doesn't implement the detailed variant.
   */
  async function identifyOne(plugin: IdentifyCapability, abs: string): Promise<IdentifyOutcome> {
    if (plugin.identifyTrackDetailed) return plugin.identifyTrackDetailed(abs);
    const result = await plugin.identifyTrack(abs);
    return result ? { kind: 'match', result } : { kind: 'no-match' };
  }

  // Fingerprint one track via the enabled `identify` plugin (AcoustID) — the
  // rescue path when tags are garbage or missing, so a curator can confirm
  // what a mis-tagged file actually is before retagging it.
  app.post('/songs/:id/identify', async (c) => {
    requireCurator(c);
    const db = getDatabase();
    const id = c.req.param('id');
    const song = db
      .query<{ path: string }, [string]>(`SELECT path FROM library_songs WHERE id = ?`)
      .get(id);
    if (!song) return c.json({ error: 'Song not found' }, 404);

    const plugin = identifyPlugin(deps);
    if (!plugin) return c.json({ error: 'AcoustID not available' }, 503);
    if (!deps.musicDir) return c.json({ error: 'Music directory not configured' }, 503);

    const md = expandDir(deps.musicDir);
    const abs = resolveSongPath(md, song.path);
    if (!isUnderMusicDir(md, abs) || !existsSync(abs)) {
      return c.json({ error: 'Song file not found' }, 404);
    }

    const outcome = await identifyOne(plugin, abs);
    // `result` stays on the payload (unchanged shape for any existing caller);
    // `outcome` is the addition that says *why* there is no result.
    return c.json({ result: outcome.kind === 'match' ? outcome.result : null, outcome });
  });

  // Fingerprint up to 5 quarantined tracks for an album sequentially (the
  // identify engine rate-limits itself) and surface a majority-vote guess for
  // the whole album alongside each track's own result.
  app.post('/albums/:id/identify', async (c) => {
    requireCurator(c);
    const db = getDatabase();
    const albumId = c.req.param('id');

    const plugin = identifyPlugin(deps);
    if (!plugin) return c.json({ error: 'AcoustID not available' }, 503);
    if (!deps.musicDir) return c.json({ error: 'Music directory not configured' }, 503);

    const md = expandDir(deps.musicDir);
    const songs = db
      .query<{ id: string; path: string }, [string]>(
        `SELECT id, path FROM library_songs WHERE album_id = ? AND landed_at IS NULL
         ORDER BY track ASC NULLS LAST LIMIT 5`,
      )
      .all(albumId);

    const perTrack: Array<{
      songId: string;
      result: IdentifyResult | null;
      outcome: IdentifyOutcome;
    }> = [];
    for (const song of songs) {
      const abs = resolveSongPath(md, song.path);
      if (!isUnderMusicDir(md, abs) || !existsSync(abs)) {
        // A row whose file vanished is its own triage signal, distinct from
        // "AcoustID has never heard of this recording".
        perTrack.push({ songId: song.id, result: null, outcome: { kind: 'file-missing' } });
        continue;
      }
      const outcome = await identifyOne(plugin, abs);
      perTrack.push({
        songId: song.id,
        result: outcome.kind === 'match' ? outcome.result : null,
        outcome,
      });
    }

    const vote = voteAlbumIdentity(perTrack.map((t) => t.result));
    return c.json({ perTrack, vote });
  });

  // Per-track retag (title/artist only) + incremental rescan, so a fingerprint
  // match (or a curator's own free-text fix) actually lands in the library
  // rather than only being suggested.
  app.post('/albums/:id/tracks', async (c) => {
    const user = requireCurator(c);
    const db = getDatabase();
    const albumId = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as {
      tracks?: Array<{ id: string; title?: string; artist?: string }>;
    } | null;
    const tracks = body?.tracks ?? [];

    const writeTags = deps.writeTags ?? writeAudioTags;
    const md = deps.musicDir ? expandDir(deps.musicDir) : null;

    let updated = 0;
    const failed: Array<{ id: string; error: string }> = [];
    const relPaths: string[] = [];

    for (const t of tracks) {
      // Scoped to *this album's still-quarantined* tracks — mirrors
      // /albums/:id/identify above — so a track id belonging to a different
      // album, or one that has already landed, can't be retagged from here.
      // Post-landing fixes go through metadata overrides (docs/download-review.md).
      const song = db
        .query<{ path: string }, [string, string]>(
          `SELECT path FROM library_songs WHERE id = ? AND album_id = ? AND landed_at IS NULL`,
        )
        .get(t.id, albumId);
      if (!song) {
        failed.push({ id: t.id, error: 'Not a quarantined track of this album' });
        continue;
      }
      if (!md) {
        failed.push({ id: t.id, error: 'Music directory not configured' });
        continue;
      }
      const abs = resolveSongPath(md, song.path);
      if (!isUnderMusicDir(md, abs) || !existsSync(abs)) {
        failed.push({ id: t.id, error: 'Song file not found' });
        continue;
      }

      const tags: AudioTags = {};
      const title = normalizeTagValue(t.title);
      if (title !== undefined) tags.title = title;
      const artist = normalizeTagValue(t.artist);
      if (artist !== undefined) tags.artist = artist;

      if (Object.keys(tags).length === 0) {
        failed.push({ id: t.id, error: 'No fields to update' });
        continue;
      }

      const ok = await writeTags(abs, tags);
      if (!ok) {
        failed.push({ id: t.id, error: 'Tag write failed' });
        continue;
      }
      updated += 1;
      relPaths.push(relative(md, abs));
    }

    let rescanned = false;
    if (deps.scanIncremental && relPaths.length > 0) {
      await deps.scanIncremental(relPaths);
      rescanned = true;
    }

    // Skip the audit entry when nothing actually changed — an all-failed
    // request (bad ids, no fields, missing files) is noise, not a curator action.
    if (updated > 0) {
      recordAudit(db, user, 'download_review.retag', {
        targetKind: 'album',
        targetId: albumId,
        detail: `${updated} tracks`,
      });
    }

    return c.json({ updated, failed, rescanned });
  });

  return app;
}
