import { Hono } from 'hono';
import { basename, dirname, extname, join, normalize, relative } from 'node:path';
import { unlinkSync, existsSync, readdirSync } from 'node:fs';
import { createLogger } from '@nicotind/core';
import type { Song } from '@nicotind/core';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { AuthEnv } from '../middleware/auth.js';

const log = createLogger('library');

export function libraryRoutes(navidrome: Navidrome, musicDir?: string) {
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

  app.get('/genres', async (c) => {
    const genres = await navidrome.browsing.getGenres();
    return c.json(genres);
  });

  app.get('/random', async (c) => {
    const size = Number(c.req.query('size') ?? 10);
    const songs = await navidrome.browsing.getRandomSongs(size);
    return c.json(songs);
  });

  // Recently added songs (for the download inbox)
  app.get('/recent-songs', async (c) => {
    const size = Number(c.req.query('size') ?? 50);
    // Get newest albums, then collect their songs
    const albums = await navidrome.browsing.getAlbumList('newest', Math.min(size, 20));
    const songs = [];
    for (const album of albums) {
      const { songs: albumSongs } = await navidrome.browsing.getAlbum(album.id);
      for (const song of albumSongs) {
        songs.push({ ...song, albumName: album.name, albumArtist: album.artist });
      }
      if (songs.length >= size) break;
    }
    return c.json(songs.slice(0, size));
  });

  // Delete a song from the filesystem and trigger rescan
  app.delete('/songs/:id', async (c) => {
    if (!musicDir) {
      return c.json({ error: 'Music directory not configured' }, 500);
    }

    const id = c.req.param('id');

    // Get the song's path from Navidrome
    const song = await navidrome.browsing.getSong(id);
    if (!song.path) {
      return c.json({ error: 'Song path not available' }, 404);
    }

    const expandedMusicDir = expandDir(musicDir);
    const fullPath = resolveSongPath(expandedMusicDir, song.path);

    if (!isUnderMusicDir(expandedMusicDir, fullPath)) {
      log.warn({ path: fullPath, musicDir: expandedMusicDir }, 'Resolved song path is outside the music directory');
      return c.json({ error: 'Song path is outside the music directory' }, 400);
    }

    if (!existsSync(fullPath)) {
      const fallbackPath = findSongByMetadata(expandedMusicDir, song);
      if (fallbackPath) {
        log.info({ requestedPath: fullPath, resolvedPath: fallbackPath }, 'Resolved song file via filename match');
        try {
          unlinkSync(fallbackPath);
          log.info({ path: fallbackPath, songId: id }, 'Deleted song file from disk');
        } catch (err) {
          log.error({ err, path: fallbackPath }, 'Failed to delete song file');
          return c.json({ error: 'Failed to delete file' }, 500);
        }
      } else {
        log.warn({ path: fullPath }, 'File not found on disk, triggering rescan anyway');
      }
    } else {
      try {
        unlinkSync(fullPath);
        log.info({ path: fullPath, songId: id }, 'Deleted song file from disk');
      } catch (err) {
        log.error({ err, path: fullPath }, 'Failed to delete song file');
        return c.json({ error: 'Failed to delete file' }, 500);
      }
    }

    // Trigger Navidrome rescan to update the index
    try {
      await (navidrome.system as { startScan: (fullScan?: boolean) => Promise<void> }).startScan(
        true,
      );
    } catch {
      // Non-fatal — file is already deleted
    }

    return c.json({ ok: true });
  });

  return app;
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
