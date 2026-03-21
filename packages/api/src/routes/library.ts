import { Hono } from 'hono';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { createLogger } from '@nicotind/core';
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

    // Construct full path and delete
    const expandedMusicDir = musicDir.startsWith('~')
      ? musicDir.replace('~', process.env.HOME ?? '/root')
      : musicDir;
    const fullPath = join(expandedMusicDir, song.path);

    if (!existsSync(fullPath)) {
      log.warn({ path: fullPath }, 'File not found on disk, triggering rescan anyway');
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
      await navidrome.system.startScan();
    } catch {
      // Non-fatal — file is already deleted
    }

    return c.json({ ok: true });
  });

  return app;
}
