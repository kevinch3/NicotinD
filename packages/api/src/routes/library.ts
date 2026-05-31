import { Hono } from 'hono';
import { basename, dirname, join, normalize, relative } from 'node:path';
import { unlinkSync, rmdirSync, existsSync, readdirSync } from 'node:fs';
import { createLogger } from '@nicotind/core';
import type { Song, Album, Artist } from '@nicotind/core';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { AuthEnv } from '../middleware/auth.js';
import { getDatabase } from '../db.js';
import type { LibraryCurator } from '../services/library-curator.js';

const log = createLogger('library');

const VALID_CLASSIFICATIONS = new Set(['album', 'single', 'compilation', 'unknown']);

interface LibraryRoutesOptions {
  curator?: LibraryCurator;
  runSync?: () => Promise<void>;
}

interface AlbumRow {
  id: string;
  name: string;
  artist: string;
  artist_id: string;
  cover_art: string | null;
  song_count: number;
  duration: number;
  year: number | null;
  genre: string | null;
  created: string | null;
  starred: string | null;
  classification: string;
  hidden: number;
  manual_override: number;
}

interface SongRow {
  id: string;
  album_id: string;
  album_name: string;
  album_cover_art: string | null;
  title: string;
  artist: string;
  artist_id: string;
  track: number | null;
  duration: number;
  year: number | null;
  genre: string | null;
  cover_art: string | null;
  path: string;
  size: number | null;
  bit_rate: number | null;
  suffix: string | null;
  content_type: string | null;
  created: string | null;
  starred: string | null;
}

interface ArtistRow {
  id: string;
  name: string;
  album_count: number;
  cover_art: string | null;
  starred: string | null;
}

const ALBUM_SELECT = `
  SELECT id, name, artist, artist_id, cover_art, song_count, duration,
         year, genre, created, starred, classification, hidden, manual_override
  FROM library_albums
`;

const SONG_SELECT = `
  SELECT s.id, s.album_id, a.name AS album_name, a.cover_art AS album_cover_art,
         s.title, s.artist, s.artist_id, s.track, s.duration, s.year, s.genre,
         s.cover_art, s.path, s.size, s.bit_rate, s.suffix, s.content_type,
         s.created, s.starred
  FROM library_songs s
  LEFT JOIN library_albums a ON a.id = s.album_id
`;

function rowToAlbum(r: AlbumRow): Album & { classification: string; hidden: boolean } {
  return {
    id: r.id,
    name: r.name,
    artist: r.artist,
    artistId: r.artist_id,
    coverArt: r.cover_art ?? undefined,
    songCount: r.song_count,
    duration: r.duration,
    year: r.year ?? undefined,
    genre: r.genre ?? undefined,
    created: r.created ?? '',
    starred: r.starred ?? undefined,
    classification: r.classification,
    hidden: r.hidden === 1,
  };
}

function rowToSong(r: SongRow): Song {
  return {
    id: r.id,
    title: r.title,
    album: r.album_name ?? '',
    albumId: r.album_id,
    artist: r.artist,
    artistId: r.artist_id,
    track: r.track ?? undefined,
    year: r.year ?? undefined,
    genre: r.genre ?? undefined,
    coverArt: r.cover_art ?? r.album_cover_art ?? undefined,
    size: r.size ?? 0,
    contentType: r.content_type ?? '',
    suffix: r.suffix ?? '',
    duration: r.duration,
    bitRate: r.bit_rate ?? 0,
    path: r.path,
    created: r.created ?? '',
    starred: r.starred ?? undefined,
  };
}

function rowToArtist(r: ArtistRow): Artist {
  return {
    id: r.id,
    name: r.name,
    albumCount: r.album_count,
    coverArt: r.cover_art ?? undefined,
    starred: r.starred ?? undefined,
  };
}

function albumOrderBy(type: string): string {
  switch (type) {
    case 'newest':
      return 'created DESC, name COLLATE NOCASE ASC';
    case 'random':
      return 'RANDOM()';
    case 'recent':
      return 'created DESC';
    case 'frequent':
      // Navidrome's "frequent" requires play-count data we don't sync yet.
      return 'created DESC';
    case 'starred':
      return 'starred DESC, name COLLATE NOCASE ASC';
    case 'alphabeticalByName':
    default:
      return 'name COLLATE NOCASE ASC';
  }
}

export function libraryRoutes(
  navidrome: Navidrome,
  musicDir?: string,
  options: LibraryRoutesOptions = {},
) {
  const app = new Hono<AuthEnv>();
  const { curator, runSync } = options;

  app.get('/artists', (c) => {
    const db = getDatabase();
    const rows = db
      .query<ArtistRow, []>(
        `SELECT id, name, album_count, cover_art, starred
         FROM library_artists
         WHERE hidden = 0
         ORDER BY name COLLATE NOCASE ASC`,
      )
      .all();
    return c.json(rows.map(rowToArtist));
  });

  app.get('/artists/:id', async (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const artistRow = db
      .query<ArtistRow, [string]>(
        `SELECT id, name, album_count, cover_art, starred
         FROM library_artists WHERE id = ?`,
      )
      .get(id);
    if (!artistRow) {
      // Fall back to Navidrome — possible the canonical DB is still warming up.
      try {
        const result = await navidrome.browsing.getArtist(id);
        return c.json(result);
      } catch {
        return c.json({ error: 'Artist not found' }, 404);
      }
    }
    const albumRows = db
      .query<AlbumRow, [string]>(
        `${ALBUM_SELECT} WHERE artist_id = ? AND hidden = 0
         ORDER BY year DESC NULLS LAST, name COLLATE NOCASE ASC`,
      )
      .all(id);
    return c.json({ artist: rowToArtist(artistRow), albums: albumRows.map(rowToAlbum) });
  });

  app.get('/albums', (c) => {
    const type = c.req.query('type') ?? 'newest';
    const size = Math.min(Number(c.req.query('size') ?? 20), 500);
    const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);
    const includeHidden = c.req.query('includeHidden') === 'true';
    const classification = c.req.query('classification');

    const wheres: string[] = [];
    const params: Array<string | number> = [];
    if (!includeHidden) wheres.push('hidden = 0');
    if (classification && VALID_CLASSIFICATIONS.has(classification)) {
      wheres.push('classification = ?');
      params.push(classification);
    }

    const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
    const order = albumOrderBy(type);

    const db = getDatabase();
    const rows = db
      .query<AlbumRow, (string | number)[]>(
        `${ALBUM_SELECT} ${whereClause} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...params, size, offset);
    return c.json(rows.map(rowToAlbum));
  });

  app.get('/albums/:id', async (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const albumRow = db
      .query<AlbumRow, [string]>(`${ALBUM_SELECT} WHERE id = ?`)
      .get(id);
    if (!albumRow) {
      // Possible the sync hasn't run yet — fall back to Navidrome to keep things working.
      try {
        const { album, songs } = await navidrome.browsing.getAlbum(id);
        return c.json({ ...album, song: songs });
      } catch {
        return c.json({ error: 'Album not found' }, 404);
      }
    }
    const songRows = db
      .query<SongRow, [string]>(
        `${SONG_SELECT} WHERE s.album_id = ? AND s.hidden = 0
         ORDER BY s.track ASC NULLS LAST, s.title COLLATE NOCASE ASC`,
      )
      .all(id);
    return c.json({ ...rowToAlbum(albumRow), song: songRows.map(rowToSong) });
  });

  app.delete('/albums/:id', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);

    const albumId = c.req.param('id');
    let songs: Awaited<ReturnType<typeof navidrome.browsing.getAlbum>>['songs'];
    try {
      const result = await navidrome.browsing.getAlbum(albumId);
      songs = result.songs;
    } catch {
      return c.json({ error: 'Album not found' }, 404);
    }

    const ids = songs.map((s) => s.id);
    const results = await Promise.allSettled(ids.map((songId) => deleteOne(songId)));

    const failed: Array<{ id: string; error: string }> = [];
    let deletedCount = 0;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled' && r.value.ok) {
        deletedCount++;
      } else {
        const err = r.status === 'fulfilled' ? r.value.error : 'Unexpected error';
        failed.push({ id: ids[i]!, error: err ?? 'Unknown error' });
      }
    }

    try {
      await (navidrome.system as { startScan: (fullScan?: boolean) => Promise<void> }).startScan(true);
    } catch {
      // Non-fatal
    }
    if (runSync) void runSync();

    log.info({ albumId, deletedCount, failedCount: failed.length }, 'Album deletion complete');
    return c.json({ ok: true, deletedCount, failedCount: failed.length, failed });
  });

  // --- Curation admin endpoints -------------------------------------------------
  app.post('/albums/:id/hide', (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
    if (!curator) return c.json({ error: 'Curator not available' }, 503);
    const ok = curator.setManualOverride(c.req.param('id'), { hidden: true });
    return c.json({ ok });
  });

  app.post('/albums/:id/unhide', (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
    if (!curator) return c.json({ error: 'Curator not available' }, 503);
    const ok = curator.setManualOverride(c.req.param('id'), { hidden: false });
    return c.json({ ok });
  });

  app.post('/albums/:id/reclassify', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
    if (!curator) return c.json({ error: 'Curator not available' }, 503);
    const body = await c.req.json<{ classification?: string }>();
    const cls = body.classification;
    if (!cls || !VALID_CLASSIFICATIONS.has(cls)) {
      return c.json({ error: 'Invalid classification' }, 400);
    }
    const ok = curator.setManualOverride(c.req.param('id'), {
      classification: cls as 'album' | 'single' | 'compilation' | 'unknown',
    });
    return c.json({ ok });
  });

  app.post('/albums/:id/clear-override', (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
    if (!curator) return c.json({ error: 'Curator not available' }, 503);
    const ok = curator.clearManualOverride(c.req.param('id'));
    return c.json({ ok });
  });

  app.post('/sync', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);
    if (!runSync) return c.json({ error: 'Sync not available' }, 503);
    await runSync();
    return c.json({ ok: true });
  });

  // --- Songs --------------------------------------------------------------------
  app.get('/songs/:id', async (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    const row = db.query<SongRow, [string]>(`${SONG_SELECT} WHERE s.id = ?`).get(id);
    if (row) return c.json(rowToSong(row));
    try {
      const song = await navidrome.browsing.getSong(id);
      return c.json(song);
    } catch {
      return c.json({ error: 'Song not found' }, 404);
    }
  });

  app.get('/songs/:id/provenance', async (c) => {
    const id = c.req.param('id');
    const db = getDatabase();
    interface ProvenanceRow {
      action: string;
      detail: string;
      applied_at: number;
    }
    const rows = db
      .query<ProvenanceRow, [string]>(
        `SELECT action, detail, applied_at
         FROM library_song_provenance
         WHERE navidrome_id = ?
         ORDER BY applied_at ASC`,
      )
      .all(id);
    return c.json(
      rows.map((r) => ({
        action: r.action,
        detail: JSON.parse(r.detail) as Record<string, unknown>,
        appliedAt: r.applied_at,
      })),
    );
  });

  app.get('/songs/:id/similar', async (c) => {
    const id = c.req.param('id');
    const size = Math.min(Number(c.req.query('size') ?? 20), 50);
    const db = getDatabase();

    const source = db.query<SongRow, [string]>(`${SONG_SELECT} WHERE s.id = ?`).get(id);
    if (!source) return c.json({ error: 'Song not found' }, 404);

    const sourceDirParts = source.path.split('/').filter(Boolean).slice(0, -1);
    const pathPrefix = sourceDirParts.slice(0, 2).join('/');

    const scored = new Map<string, { song: Song; score: number }>();
    const add = (s: Song, delta: number) => {
      if (s.id === source.id) return;
      const entry = scored.get(s.id);
      if (entry) entry.score += delta;
      else scored.set(s.id, { song: s, score: delta });
    };

    // Same-artist songs (boost same-album less to surface other albums first)
    const artistSongs = db
      .query<SongRow, [string]>(
        `${SONG_SELECT} WHERE s.artist_id = ? AND s.hidden = 0`,
      )
      .all(source.artist_id);
    for (const row of artistSongs) {
      const s = rowToSong(row);
      const score = row.album_id === source.album_id ? 5 : 10;
      add(s, score);
      if (pathPrefix && row.path.includes(pathPrefix)) add(s, 4);
    }

    // Same-genre songs within ±5 years
    if (source.genre) {
      const genreRows = db
        .query<SongRow, [string, string]>(
          `${SONG_SELECT} WHERE s.genre = ? AND s.artist_id != ? AND s.hidden = 0
           ORDER BY RANDOM() LIMIT 200`,
        )
        .all(source.genre, source.artist_id);
      const yearMin = source.year ? source.year - 5 : null;
      const yearMax = source.year ? source.year + 5 : null;
      for (const row of genreRows) {
        if (yearMin && yearMax && row.year && (row.year < yearMin || row.year > yearMax)) continue;
        const s = rowToSong(row);
        add(s, 3);
        if (pathPrefix && row.path.includes(pathPrefix)) add(s, 4);
      }
    }

    const results = [...scored.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, size)
      .map((e) => e.song);

    return c.json(results);
  });

  app.get('/genres', (c) => {
    const db = getDatabase();
    const rows = db
      .query<{ name: string; song_count: number; album_count: number }, []>(
        `SELECT name, song_count, album_count FROM library_genres ORDER BY song_count DESC`,
      )
      .all();
    return c.json(
      rows.map((r) => ({ value: r.name, songCount: r.song_count, albumCount: r.album_count })),
    );
  });

  app.get('/genres/songs', (c) => {
    const genre = c.req.query('genre') ?? '';
    const count = Math.min(Number(c.req.query('count') ?? 100), 500);
    if (!genre) return c.json([]);
    const db = getDatabase();
    const rows = db
      .query<SongRow, [string, number]>(
        `${SONG_SELECT} WHERE s.genre = ? AND s.hidden = 0
         ORDER BY s.created DESC NULLS LAST LIMIT ?`,
      )
      .all(genre, count);
    return c.json(rows.map(rowToSong));
  });

  app.get('/random', (c) => {
    const size = Math.min(Number(c.req.query('size') ?? 10), 200);
    const db = getDatabase();
    const rows = db
      .query<SongRow, [number]>(
        `${SONG_SELECT}
         LEFT JOIN library_albums alb ON alb.id = s.album_id
         WHERE s.hidden = 0 AND (alb.hidden IS NULL OR alb.hidden = 0)
         ORDER BY RANDOM() LIMIT ?`,
      )
      .all(size);
    return c.json(rows.map(rowToSong));
  });

  // Recently added — uses completed_downloads history to surface user's most-recent imports.
  app.get('/recent-songs', (c) => {
    const size = Math.min(Number(c.req.query('size') ?? 50), 200);
    const db = getDatabase();
    const rows = db
      .query<SongRow, [number]>(
        `${SONG_SELECT}
         WHERE s.hidden = 0 AND (a.hidden IS NULL OR a.hidden = 0)
         ORDER BY s.created DESC NULLS LAST LIMIT ?`,
      )
      .all(size * 4);
    const songs = rows.map((r) => ({
      ...rowToSong(r),
      albumName: r.album_name ?? '',
      albumArtist: r.artist,
    }));
    const ordered = orderByCompletionHistory(songs);
    return c.json(ordered.slice(0, size));
  });

  function tokenizeFilename(name: string): string[] {
    return name
      .toLowerCase()
      .replace(/\.[^.]+$/, '')
      .split(/[\s\-_.]+/)
      .filter(t => t.length >= 2);
  }

  function findFileByTokens(dir: string, tokens: string[]): string | null {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    const tokenSet = new Set(tokens);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (tokenizeFilename(entry.name).some(t => tokenSet.has(t))) {
        return join(dir, entry.name);
      }
    }
    return null;
  }

  function fuzzyFindFile(musicRootDir: string, fullPath: string): string | null {
    const tokens = tokenizeFilename(basename(fullPath));
    if (tokens.length === 0) return null;

    const knownDir = dirname(fullPath);
    if (existsSync(knownDir)) {
      const found = findFileByTokens(knownDir, tokens);
      if (found) return found;
    }

    let rootEntries: import('node:fs').Dirent[];
    try {
      rootEntries = readdirSync(musicRootDir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of rootEntries) {
      if (!entry.isDirectory()) continue;
      const found = findFileByTokens(join(musicRootDir, entry.name), tokens);
      if (found) return found;
    }

    return null;
  }

  async function deleteOne(id: string): Promise<{ ok: boolean; error?: string; status?: number }> {
    if (!musicDir) {
      return { ok: false, error: 'Music directory not configured', status: 500 };
    }

    // Prefer the canonical row; fall back to Navidrome for songs that haven't been synced yet.
    let songPath: string | null = null;
    const db = getDatabase();
    const canonical = db
      .query<{ path: string }, [string]>(`SELECT path FROM library_songs WHERE id = ?`)
      .get(id);
    if (canonical?.path) songPath = canonical.path;
    if (!songPath) {
      try {
        const song = await navidrome.browsing.getSong(id);
        songPath = song?.path ?? null;
      } catch {
        return { ok: false, error: 'Song not found in library', status: 404 };
      }
    }
    if (!songPath) {
      return { ok: false, error: 'Song path not available', status: 404 };
    }

    const expandedMusicDir = expandDir(musicDir);
    const fullPath = resolveSongPath(expandedMusicDir, songPath);

    if (!isUnderMusicDir(expandedMusicDir, fullPath)) {
      log.warn({ path: fullPath, musicDir: expandedMusicDir }, 'Resolved song path is outside the music directory');
      return { ok: false, error: 'Song path is outside the music directory', status: 400 };
    }

    let deletedPath: string | null = null;

    if (existsSync(fullPath)) {
      try {
        unlinkSync(fullPath);
        deletedPath = fullPath;
        log.info({ path: fullPath, songId: id }, 'Deleted song file from disk');
      } catch (err) {
        log.error({ err, path: fullPath }, 'Failed to delete song file');
        return { ok: false, error: 'Failed to delete file', status: 500 };
      }
    } else {
      const registeredRelPath = lookupDownloadPath(id);
      const fileBasename = basename(fullPath).toLowerCase();
      const relPath = registeredRelPath ?? lookupDownloadPathByBasename(fileBasename);
      const fallbackPath = relPath ? join(expandedMusicDir, relPath) : null;
      if (fallbackPath && existsSync(fallbackPath)) {
        try {
          unlinkSync(fallbackPath);
          deletedPath = fallbackPath;
          log.info({ requestedPath: fullPath, resolvedPath: fallbackPath }, 'Deleted song file via fallback path');
        } catch (err) {
          log.error({ err, path: fallbackPath }, 'Failed to delete song file');
          return { ok: false, error: 'Failed to delete file', status: 500 };
        }
      } else {
        const fuzzyPath = fuzzyFindFile(expandedMusicDir, fullPath);
        if (fuzzyPath) {
          try {
            unlinkSync(fuzzyPath);
            deletedPath = fuzzyPath;
            log.info({ requestedPath: fullPath, resolvedPath: fuzzyPath }, 'Deleted song file via fuzzy path match');
          } catch (err) {
            log.error({ err, path: fuzzyPath }, 'Failed to delete song file');
            return { ok: false, error: 'Failed to delete file', status: 500 };
          }
        } else {
          return { ok: false, error: 'Song file not found on disk', status: 404 };
        }
      }
    }

    if (deletedPath) {
      cleanupEmptyDirs(deletedPath, expandedMusicDir);
      const relPath = relative(expandedMusicDir, deletedPath).replace(/\\/g, '/');

      try {
        db.run(
          'DELETE FROM completed_downloads WHERE navidrome_id = ? OR relative_path = ?',
          [id, relPath],
        );
        db.run('DELETE FROM library_songs WHERE id = ?', [id]);
        log.info({ relPath }, 'Removed song from completion history + canonical DB');
      } catch (err) {
        log.debug({ err }, 'Failed to remove from completion history');
      }
    }

    return { ok: true };
  }

  app.delete('/songs/:id', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);

    const result = await deleteOne(c.req.param('id'));
    if (!result.ok) {
      return c.json({ error: result.error }, (result.status ?? 500) as 400 | 404 | 500);
    }

    try {
      await (navidrome.system as { startScan: (fullScan?: boolean) => Promise<void> }).startScan(true);
    } catch {
      // Non-fatal
    }
    if (runSync) void runSync();

    return c.json({ ok: true });
  });

  app.post('/songs/bulk-delete', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);

    const { ids } = await c.req.json<{ ids: string[] }>();
    if (!ids || !Array.isArray(ids)) {
      return c.json({ error: 'IDs array required' }, 400);
    }

    log.info({ count: ids.length }, 'Bulk deleting songs');
    const results = await Promise.allSettled(ids.map(id => deleteOne(id)));

    const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok));
    if (failed.length === ids.length) {
      const firstError = results.find(r => r.status === 'fulfilled' && !r.value.ok) as PromiseFulfilledResult<{ ok: false; error: string; status: number }> | undefined;
      const status = firstError?.value.status ?? 500;
      return c.json({ error: firstError?.value.error ?? 'Failed to delete any songs' }, status as 400 | 404 | 500);
    }

    try {
      await (navidrome.system as { startScan: (fullScan?: boolean) => Promise<void> }).startScan(true);
    } catch {
      // Non-fatal
    }
    if (runSync) void runSync();

    return c.json({ ok: true, deletedCount: ids.length - failed.length });
  });

  // Duplicate detection — now reads entirely from canonical DB.
  app.get('/duplicates', (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);

    const db = getDatabase();
    const rows = db
      .query<SongRow, []>(
        `${SONG_SELECT} WHERE s.hidden = 0 AND (a.hidden IS NULL OR a.hidden = 0)`,
      )
      .all();
    const allSongs = rows.map(rowToSong);

    const groups = new Map<string, Song[]>();
    for (const song of allSongs) {
      const key = normalizeDupKey(song.title, song.artist);
      const group = groups.get(key) ?? [];
      group.push(song);
      groups.set(key, group);
    }

    const duplicates: Array<Array<{
      id: string; title: string; artist: string; album: string;
      duration?: number; bitRate?: number; suffix?: string;
      path: string; coverArt?: string;
    }>> = [];

    for (const [, group] of groups) {
      if (group.length < 2) continue;

      const clusters: Song[][] = [];
      for (const song of group) {
        let placed = false;
        for (const cluster of clusters) {
          const refDur = cluster[0]?.duration ?? 0;
          if (Math.abs((song.duration ?? 0) - refDur) <= 2) {
            cluster.push(song);
            placed = true;
            break;
          }
        }
        if (!placed) clusters.push([song]);
      }

      for (const cluster of clusters) {
        if (cluster.length < 2) continue;
        duplicates.push(
          cluster
            .sort((a, b) => qualityScore(b) - qualityScore(a))
            .map((s) => ({
              id: s.id,
              title: s.title,
              artist: s.artist,
              album: s.album,
              duration: s.duration,
              bitRate: s.bitRate,
              suffix: s.suffix,
              path: s.path,
              coverArt: s.coverArt,
            })),
        );
      }
    }

    return c.json(duplicates);
  });

  return app;
}

interface DownloadHistoryRow {
  relative_path: string | null;
  basename: string;
  completed_at: number;
}

function orderByCompletionHistory<T extends { path: string; created?: string; title: string }>(
  songs: T[],
): T[] {
  const byPath = new Map<string, number>();
  const byBasename = new Map<string, number>();

  try {
    const db = getDatabase();
    const rows = db
      .query<DownloadHistoryRow, []>(
        `SELECT relative_path, basename, completed_at
         FROM completed_downloads
         ORDER BY completed_at DESC
         LIMIT 5000`,
      )
      .all();

    for (const row of rows) {
      if (row.relative_path) {
        const normalizedPath = normalizePath(row.relative_path);
        if (!byPath.has(normalizedPath)) {
          byPath.set(normalizedPath, row.completed_at);
        }
      }
      const normalizedBasename = row.basename.toLowerCase();
      if (!byBasename.has(normalizedBasename)) {
        byBasename.set(normalizedBasename, row.completed_at);
      }
    }
  } catch {
    // DB not initialized — fallback ordering still applies.
  }

  const scored = songs.map((song) => {
    const normalizedSongPath = normalizePath(song.path);
    const normalizedSongBase = basename(normalizedSongPath).toLowerCase();
    const completedAt = byPath.get(normalizedSongPath) ?? byBasename.get(normalizedSongBase) ?? 0;
    const createdAt = parseCreatedAt(song.created);
    return { song, completedAt, createdAt };
  });

  scored.sort((a, b) => {
    if (a.completedAt !== b.completedAt) return b.completedAt - a.completedAt;
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
    return a.song.title.localeCompare(b.song.title);
  });

  return scored.map((entry) => entry.song);
}

function normalizePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

function normalizeDupKey(title: string, artist: string): string {
  return `${title}|||${artist}`
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function qualityScore(song: Song): number {
  const ext = (song.suffix ?? '').toLowerCase();
  const formatScore =
    ext === 'flac' || ext === 'wav' || ext === 'aiff' || ext === 'ape' || ext === 'wv' ? 200 :
    ext === 'opus' || ext === 'ogg' || ext === 'm4a' || ext === 'aac' ? 100 :
    0;
  return formatScore + (song.bitRate ?? 0);
}

function parseCreatedAt(created?: string): number {
  if (!created) return 0;
  const parsed = Date.parse(created);
  return Number.isFinite(parsed) ? parsed : 0;
}

function expandDir(dir: string): string {
  if (dir.startsWith('~')) {
    return join(process.env.HOME ?? '/root', dir.slice(1));
  }
  return dir;
}

function resolveSongPath(musicDir: string, songPath: string): string {
  const normalizedSongPath = songPath.replace(/\\/g, '/');

  if (isAbsolutePath(normalizedSongPath)) {
    return normalize(normalizedSongPath);
  }

  return normalize(join(musicDir, normalizedSongPath));
}

function lookupDownloadPath(navidromeId: string): string | null {
  try {
    const row = getDatabase()
      .query<{ relative_path: string }, [string]>(
        `SELECT relative_path FROM completed_downloads
         WHERE navidrome_id = ? AND relative_path IS NOT NULL LIMIT 1`,
      )
      .get(navidromeId);
    return row?.relative_path ?? null;
  } catch {
    return null;
  }
}

function lookupDownloadPathByBasename(fileBasename: string): string | null {
  try {
    const row = getDatabase()
      .query<{ relative_path: string }, [string]>(
        `SELECT relative_path FROM completed_downloads
         WHERE basename = ? AND relative_path IS NOT NULL
         ORDER BY completed_at DESC LIMIT 1`,
      )
      .get(fileBasename);
    return row?.relative_path ?? null;
  } catch {
    return null;
  }
}

function isUnderMusicDir(musicDir: string, candidatePath: string): boolean {
  const rel = relative(musicDir, candidatePath);
  return rel !== '' && !rel.startsWith('..');
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:\//.test(path);
}

function cleanupEmptyDirs(filePath: string, musicDir: string): void {
  const normalizedMusicDir = normalize(musicDir);
  let dir = dirname(filePath);
  while (true) {
    const normalizedDir = normalize(dir);
    if (normalizedDir === normalizedMusicDir || !normalizedDir.startsWith(normalizedMusicDir)) break;
    try {
      if (readdirSync(normalizedDir).length === 0) {
        rmdirSync(normalizedDir);
        log.info({ dir: normalizedDir }, 'Removed empty directory after song deletion');
        dir = dirname(normalizedDir);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}
