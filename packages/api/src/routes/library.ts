import { Hono } from 'hono';
import { basename, dirname, extname, join, normalize, relative } from 'node:path';
import { unlinkSync, existsSync, readdirSync } from 'node:fs';
import { createLogger } from '@nicotind/core';
import type { Song } from '@nicotind/core';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { AuthEnv } from '../middleware/auth.js';
import { getDatabase } from '../db.js';
import type { MetadataFixer } from '../services/metadata-fixer.js';

const log = createLogger('library');

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
    const song = await navidrome.browsing.getSong(id);
    if (!song.path) {
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
      const fallbackPath = findSongByMetadata(expandedMusicDir, song);
      if (fallbackPath) {
        try {
          unlinkSync(fallbackPath);
          deletedPath = fallbackPath;
          log.info({ requestedPath: fullPath, resolvedPath: fallbackPath }, 'Resolved and deleted song file via fallback');
        } catch (err) {
          log.error({ err, path: fallbackPath }, 'Failed to delete song file');
          return { ok: false, error: 'Failed to delete file', status: 500 };
        }
      } else {
        log.warn({ path: fullPath }, 'File not found on disk');
        return { ok: false, error: 'File not found on disk', status: 404 };
      }
    }

    if (deletedPath) {
      const relPath = relative(expandedMusicDir, deletedPath).replace(/\\/g, '/');
      const fileBase = basename(deletedPath).toLowerCase();

      try {
        const db = getDatabase();
        db.run(
          'DELETE FROM completed_downloads WHERE relative_path = ? OR (basename = ? AND relative_path IS NULL)',
          [relPath, fileBase],
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
      return c.json({ error: 'Failed to delete any songs' }, 500);
    }

    // Trigger single Navidrome rescan at the end
    try {
      await (navidrome.system as { startScan: (fullScan?: boolean) => Promise<void> }).startScan(true);
    } catch {
      // Non-fatal
    }

    return c.json({ ok: true, deletedCount: ids.length - failed.length });
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

function findSongByMetadata(musicDir: string, song: Song): string | null {
  const preferredPath = resolveSongPath(musicDir, song.path);
  const targetDir = dirname(preferredPath);
  const targetExt = extname(preferredPath);
  const exactPath = normalize(song.path.replace(/\\/g, '/'));
  const requestedStem = basename(preferredPath, targetExt);
  const requestedProfile = buildSearchProfile(song, requestedStem);

  const localMatch = findBestMatchInDirectory(
    targetDir,
    exactPath,
    requestedProfile,
    targetExt,
  );
  if (localMatch) {
    return localMatch;
  }

  return findBestMatchRecursively(musicDir, exactPath, requestedProfile, targetExt);
}

function findBestMatchInDirectory(
  dir: string,
  exactPath: string,
  profile: SongMatchProfile,
  ext: string,
): string | null {
  if (!existsSync(dir)) return null;

  let best: { path: string; score: number } | null = null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const candidate = join(dir, entry.name);
    const score = scoreSongCandidate(candidate, entry.name, exactPath, profile, ext);
    if (score === null) continue;
    if (!best || score < best.score) {
      best = { path: candidate, score };
    }
    if (score === 0) return candidate;
  }

  return best?.path ?? null;
}

function findBestMatchRecursively(
  rootDir: string,
  exactPath: string,
  profile: SongMatchProfile,
  ext: string,
): string | null {
  if (!existsSync(rootDir)) return null;

  let best: { path: string; score: number } | null = null;
  const stack = [rootDir];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir || !existsSync(dir)) continue;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const candidate = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(candidate);
        continue;
      }

      const score = scoreSongCandidate(candidate, entry.name, exactPath, profile, ext);
      if (score === null) continue;
      if (!best || score < best.score) {
        best = { path: candidate, score };
      }
      if (score === 0) return candidate;
    }
  }

  return best?.path ?? null;
}

interface SongMatchProfile {
  requiredAlphaTokens: string[];
  titleTokens: string[];
  artistTokens: string[];
  albumTokens: string[];
  preferredStemTokens: string[];
  bonusNumericTokens: string[];
}

function buildSearchProfile(song: Song, requestedStem: string): SongMatchProfile {
  const titleTokens = alphaTokens(song.title);
  const artistTokens = alphaTokens(song.artist);
  const albumTokens = alphaTokens(song.album);
  const preferredStemTokens = alphaTokens(requestedStem);
  const bonusNumericTokens = uniqueTokens([
    ...numericTokens(song.title),
    ...numericTokens(song.artist),
    ...numericTokens(song.album),
    ...numericTokens(requestedStem),
    ...(song.track ? numericTokens(String(song.track)) : []),
  ]);

  const requiredAlphaTokens =
    titleTokens.length > 0
      ? titleTokens
      : preferredStemTokens.length > 0
        ? preferredStemTokens
        : uniqueTokens([...artistTokens, ...albumTokens]);

  return {
    requiredAlphaTokens,
    titleTokens,
    artistTokens,
    albumTokens,
    preferredStemTokens,
    bonusNumericTokens,
  };
}

function scoreSongCandidate(
  candidatePath: string,
  fileName: string,
  exactPath: string,
  profile: SongMatchProfile,
  ext: string,
): number | null {
  const candidateExt = extname(fileName);
  if (candidateExt.toLowerCase() !== ext.toLowerCase()) {
    return null;
  }

  const candidateStem = basename(fileName, candidateExt);
  const candidateNormalizedPath = normalizeSearchToken(candidatePath);
  const candidateTokens = uniqueTokens([
    ...allTokens(candidatePath),
    ...allTokens(candidateStem),
  ]);
  const candidateTokenSet = new Set(candidateTokens);
  const candidateAlphaTokens = candidateTokens.filter((token) => !isNumericToken(token));
  const candidateStemTokens = alphaTokens(candidateStem);

  if (candidateNormalizedPath === exactPath) return 0;
  if (candidateStemTokens.join(' ') === profile.preferredStemTokens.join(' ')) return 1;
  if (
    profile.preferredStemTokens.length > 0 &&
    profile.preferredStemTokens.every((token) => candidateTokenSet.has(token))
  ) {
    return 2;
  }

  if (
    profile.requiredAlphaTokens.length > 0 &&
    !profile.requiredAlphaTokens.every((token) => candidateTokenSet.has(token))
  ) {
    return null;
  }

  let score = 100;
  score -= overlapCount(candidateTokenSet, profile.requiredAlphaTokens) * 20;
  score -= overlapCount(candidateTokenSet, profile.titleTokens) * 12;
  score -= overlapCount(candidateTokenSet, profile.artistTokens) * 8;
  score -= overlapCount(candidateTokenSet, profile.albumTokens) * 6;
  score -= overlapCount(candidateTokenSet, profile.bonusNumericTokens) * 3;
  score -= candidateAlphaTokens.length;
  return score;
}

function isUnderMusicDir(musicDir: string, candidatePath: string): boolean {
  const rel = relative(musicDir, candidatePath);
  return rel !== '' && !rel.startsWith('..');
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:\//.test(path);
}

function allTokens(input?: string): string[] {
  return tokenize(input).filter((token) => !isLongNumericToken(token));
}

function alphaTokens(input?: string): string[] {
  return uniqueTokens(tokenize(input).filter((token) => !isNumericToken(token)));
}

function numericTokens(input?: string): string[] {
  return uniqueTokens(tokenize(input).filter((token) => isNumericToken(token) && !isLongNumericToken(token)));
}

function tokenize(input?: string): string[] {
  const normalized = normalizeSearchToken(input);
  return normalized ? normalized.split(' ') : [];
}

function uniqueTokens(tokens: string[]): string[] {
  return [...new Set(tokens.filter(Boolean))];
}

function isNumericToken(token: string): boolean {
  return /^\d+$/.test(token);
}

function isLongNumericToken(token: string): boolean {
  return isNumericToken(token) && token.length > 4;
}

function overlapCount(set: Set<string>, tokens: string[]): number {
  let count = 0;
  for (const token of tokens) {
    if (set.has(token)) count += 1;
  }
  return count;
}

function normalizeSearchToken(input?: string): string {
  if (!input) return '';
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
