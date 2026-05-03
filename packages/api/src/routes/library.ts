import { Hono } from 'hono';
import { basename, dirname, join, normalize, relative } from 'node:path';
import { unlinkSync, rmdirSync, existsSync, readdirSync } from 'node:fs';
import { createLogger } from '@nicotind/core';
import type { Song } from '@nicotind/core';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { AuthEnv } from '../middleware/auth.js';
import { getDatabase } from '../db.js';
import type { MetadataFixer, ReprocessStats } from '../services/metadata-fixer.js';

const log = createLogger('library');

interface ReprocessJob extends ReprocessStats {
  running: boolean;
  startedAt: number | null;
}

let reprocessJob: ReprocessJob = {
  running: false,
  processed: 0,
  total: 0,
  fixed: 0,
  skipped: 0,
  errors: 0,
  startedAt: null,
};

export function libraryRoutes(navidrome: Navidrome, musicDir?: string, metadataFixer?: MetadataFixer) {
  const app = new Hono<AuthEnv>();

  app.get('/artists', async (c) => {
    const artists = await navidrome.browsing.getArtists();
    return c.json(artists);
  });

  app.get('/artists/:id', async (c) => {
    const result = await navidrome.browsing.getArtist(c.req.param('id'));
    return c.json(result);
  });

  app.get('/albums', async (c) => {
    const type = (c.req.query('type') ?? 'newest') as
      | 'newest'
      | 'random'
      | 'frequent'
      | 'recent'
      | 'starred'
      | 'alphabeticalByName';
    const size = Number(c.req.query('size') ?? 20);
    const offset = Number(c.req.query('offset') ?? 0);
    const albums = await navidrome.browsing.getAlbumList(type, size, offset);
    return c.json(albums);
  });

  app.get('/albums/:id', async (c) => {
    const { album, songs } = await navidrome.browsing.getAlbum(c.req.param('id'));
    return c.json({ ...album, song: songs });
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

    log.info({ albumId, deletedCount, failedCount: failed.length }, 'Album deletion complete');
    return c.json({ ok: true, deletedCount, failedCount: failed.length, failed });
  });

  app.get('/songs/:id', async (c) => {
    const song = await navidrome.browsing.getSong(c.req.param('id'));
    return c.json(song);
  });

  app.get('/songs/:id/similar', async (c) => {
    const id = c.req.param('id');
    const size = Math.min(Number(c.req.query('size') ?? 20), 50);

    let source: Song;
    try {
      source = await navidrome.browsing.getSong(id);
    } catch {
      return c.json({ error: 'Song not found' }, 404);
    }

    type SimilarSong = {
      id: string; title: string; artist: string; album: string;
      duration?: number; coverArt?: string; genre?: string; year?: number;
    };
    const scored = new Map<string, { song: SimilarSong; score: number }>();

    function add(song: Song, delta: number) {
      if (song.id === source.id) return;
      const entry = scored.get(song.id);
      const slim: SimilarSong = {
        id: song.id, title: song.title, artist: song.artist,
        album: song.album, duration: song.duration,
        coverArt: song.coverArt, genre: song.genre, year: song.year,
      };
      if (entry) {
        entry.score += delta;
      } else {
        scored.set(song.id, { song: slim, score: delta });
      }
    }

    // Source path prefix for heuristic (first 2 directory components)
    const sourceDirParts = source.path.split('/').filter(Boolean).slice(0, -1);
    const pathPrefix = sourceDirParts.slice(0, 2).join('/');

    // Parallel: artist albums + genre songs
    const [artistData, genreSongs] = await Promise.all([
      navidrome.browsing.getArtist(source.artistId).catch(() => null),
      source.genre
        ? navidrome.browsing.getSongsByGenre(source.genre, 200).catch(() => [] as Song[])
        : Promise.resolve([] as Song[]),
    ]);

    // Process artist albums (cap at 10)
    if (artistData) {
      const albums = artistData.albums.slice(0, 10);
      for (const album of albums) {
        try {
          const { songs } = await navidrome.browsing.getAlbum(album.id);
          for (const song of songs) {
            const score = song.albumId === source.albumId ? 5 : 10;
            add(song, score);
            // Path heuristic boost
            if (pathPrefix && song.path.includes(pathPrefix)) {
              add(song, 4);
            }
          }
        } catch {
          // Skip unreachable album
        }
      }
    }

    // Process genre songs
    const yearMin = source.year ? source.year - 5 : null;
    const yearMax = source.year ? source.year + 5 : null;
    const filteredGenre = genreSongs.filter((s) => {
      if (s.artistId === source.artistId) return false;
      if (yearMin && yearMax && s.year && (s.year < yearMin || s.year > yearMax)) return false;
      return true;
    });
    // Random sample up to 30 to avoid ordering bias
    const genreSample = filteredGenre
      .sort(() => Math.random() - 0.5)
      .slice(0, 30);
    for (const song of genreSample) {
      add(song, 3);
      if (pathPrefix && song.path.includes(pathPrefix)) {
        add(song, 4);
      }
    }

    const results = [...scored.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, size)
      .map((e) => e.song);

    return c.json(results);
  });

  app.get('/genres', async (c) => {
    const genres = await navidrome.browsing.getGenres();
    return c.json(genres);
  });

  app.get('/genres/songs', async (c) => {
    const genre = c.req.query('genre') ?? '';
    const count = Number(c.req.query('count') ?? 100);
    if (!genre) return c.json([], 200);
    const songs = await navidrome.browsing.getSongsByGenre(genre, count);
    return c.json(songs);
  });

  app.get('/random', async (c) => {
    const size = Number(c.req.query('size') ?? 10);
    const songs = await navidrome.browsing.getRandomSongs(size);
    return c.json(songs);
  });

  // Recently added songs (for the download inbox)
  app.get('/recent-songs', async (c) => {
    const size = Number(c.req.query('size') ?? 50);
    const albumFetchSize = Math.min(Math.max(size, 20), 80);
    const candidateTarget = Math.min(Math.max(size * 4, size), 400);
    // Get newest albums, then collect their songs
    const albums = await navidrome.browsing.getAlbumList('newest', albumFetchSize);
    const songs: Array<Song & { albumName: string; albumArtist: string }> = [];
    for (const album of albums) {
      const { songs: albumSongs } = await navidrome.browsing.getAlbum(album.id);
      for (const song of albumSongs) {
        songs.push({ ...song, albumName: album.name, albumArtist: album.artist });
      }
      if (songs.length >= candidateTarget) break;
    }

    const ordered = orderByCompletionHistory(songs);
    return c.json(ordered.slice(0, size));
  });

  async function deleteOne(id: string): Promise<{ ok: boolean; error?: string; status?: number }> {
    if (!musicDir) {
      return { ok: false, error: 'Music directory not configured', status: 500 };
    }

    // Get the song's path from Navidrome
    let song: Awaited<ReturnType<typeof navidrome.browsing.getSong>>;
    try {
      song = await navidrome.browsing.getSong(id);
    } catch {
      return { ok: false, error: 'Song not found in library', status: 404 };
    }
    if (!song?.path) {
      return { ok: false, error: 'Song path not available', status: 404 };
    }

    const expandedMusicDir = expandDir(musicDir);
    const fullPath = resolveSongPath(expandedMusicDir, song.path);

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
      // Primary: registry lookup by navidrome_id (populated for downloads after upgrade)
      const registeredRelPath = lookupDownloadPath(id);
      // Secondary: basename lookup in completed_downloads (covers pre-upgrade downloads)
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
        // File not on disk and not in download registry — ghost record in Navidrome.
        // The scan triggered by the caller will remove it from Navidrome's index.
        log.info({ path: fullPath, songId: id }, 'Song file absent from disk; scan will clear ghost record');
        return { ok: true };
      }
    }

    if (deletedPath) {
      cleanupEmptyDirs(deletedPath, expandedMusicDir);
      const relPath = relative(expandedMusicDir, deletedPath).replace(/\\/g, '/');

      try {
        const db = getDatabase();
        db.run(
          'DELETE FROM completed_downloads WHERE navidrome_id = ? OR relative_path = ?',
          [id, relPath],
        );
        log.info({ relPath }, 'Removed song from completion history');
      } catch (err) {
        log.debug({ err }, 'Failed to remove from completion history');
      }
    }

    return { ok: true };
  }

  // Delete a song from the filesystem and trigger rescan
  app.delete('/songs/:id', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);

    const result = await deleteOne(c.req.param('id'));
    if (!result.ok) {
      return c.json({ error: result.error }, (result.status as any) ?? 500);
    }

    // Trigger Navidrome rescan to update the index
    try {
      await (navidrome.system as { startScan: (fullScan?: boolean) => Promise<void> }).startScan(true);
    } catch {
      // Non-fatal
    }

    return c.json({ ok: true });
  });

  // Bulk delete songs
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
      return c.json({ error: firstError?.value.error ?? 'Failed to delete any songs' }, status as any);
    }

    // Trigger single Navidrome rescan at the end
    try {
      await (navidrome.system as { startScan: (fullScan?: boolean) => Promise<void> }).startScan(true);
    } catch {
      // Non-fatal
    }

    return c.json({ ok: true, deletedCount: ids.length - failed.length });
  });


  // Start library-wide metadata reprocess job (admin only)
  app.post('/reprocess', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);

    if (reprocessJob.running) {
      return c.json({ error: 'Reprocess already running' }, 409);
    }

    if (!musicDir || !metadataFixer) {
      return c.json({ error: 'Music directory or metadata fixer not configured' }, 500);
    }

    reprocessJob = { running: true, processed: 0, total: 0, fixed: 0, skipped: 0, errors: 0, startedAt: Date.now() };
    log.info('Starting library-wide metadata reprocess');

    metadataFixer
      .reprocessLibrary((stats) => {
        Object.assign(reprocessJob, stats);
      })
      .then(async (stats) => {
        Object.assign(reprocessJob, stats, { running: false });
        log.info(stats, 'Library reprocess complete');
        try {
          await (navidrome.system as { startScan: (full?: boolean) => Promise<void> }).startScan(true);
        } catch {
          // Non-fatal
        }
      })
      .catch((err) => {
        log.error({ err }, 'Library reprocess failed');
        reprocessJob.running = false;
      });

    return c.json({ ok: true });
  });

  // Poll reprocess job status
  app.get('/reprocess/status', (c) => {
    return c.json(reprocessJob);
  });

  // Duplicate detection (admin only)
  app.get('/duplicates', async (c) => {
    const user = c.get('user');
    if (user.role !== 'admin') return c.json({ error: 'Admin only' }, 403);

    const allSongs: Song[] = [];
    let offset = 0;
    while (true) {
      const albums = await navidrome.browsing.getAlbumList('alphabeticalByName', 500, offset);
      if (albums.length === 0) break;
      await Promise.all(
        albums.map(async (album) => {
          try {
            const { songs } = await navidrome.browsing.getAlbum(album.id);
            allSongs.push(...songs);
          } catch {
            // Skip unreachable album
          }
        }),
      );
      offset += albums.length;
      if (albums.length < 500) break;
    }

    // Group songs by normalized title + artist
    const groups = new Map<string, Song[]>();
    for (const song of allSongs) {
      const key = normalizeDupKey(song.title, song.artist);
      const group = groups.get(key) ?? [];
      group.push(song);
      groups.set(key, group);
    }

    // Within each group, sub-cluster by duration (±2s tolerance) and keep clusters of 2+
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

  // On-demand metadata normalization for a single song via MusicBrainz
  app.post('/songs/:id/fix-metadata', async (c) => {
    if (!musicDir || !metadataFixer) {
      return c.json({ error: 'Metadata fixer not configured' }, 500);
    }

    const id = c.req.param('id');
    const song = await navidrome.browsing.getSong(id);
    if (!song.path) {
      return c.json({ error: 'Song path not available' }, 404);
    }

    const expandedMusicDir = expandDir(musicDir);
    const fullPath = resolveSongPath(expandedMusicDir, song.path);

    if (!isUnderMusicDir(expandedMusicDir, fullPath)) {
      log.warn({ path: fullPath, musicDir: expandedMusicDir }, 'Song path is outside the music directory');
      return c.json({ error: 'Song path is outside the music directory' }, 400);
    }

    if (!existsSync(fullPath)) {
      return c.json({ error: 'File not found on disk' }, 404);
    }

    const hint = { title: song.title, artist: song.artist, album: song.album };
    const result = await metadataFixer.fixFileAtAbsolutePath(fullPath, hint);

    if (result.fixed) {
      try {
        await (navidrome.system as { startScan: (fullScan?: boolean) => Promise<void> }).startScan(false);
      } catch {
        // Non-fatal
      }
    }

    return c.json(result);
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
    // DB not initialized or table unavailable — fallback ordering still applies.
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
  const formatScore = ext === 'flac' || ext === 'wav' ? 200 : ext === 'opus' || ext === 'ogg' ? 100 : 0;
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

