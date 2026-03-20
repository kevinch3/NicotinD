import { Hono } from 'hono';
import type { Navidrome } from '@nicotind/navidrome-client';
import type { AuthEnv } from '../middleware/auth.js';

export function libraryRoutes(navidrome: Navidrome) {
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
    const result = await navidrome.browsing.getAlbum(c.req.param('id'));
    return c.json(result);
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

  return app;
}
