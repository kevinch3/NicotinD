import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Hono } from 'hono';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import type { AuthEnv } from '../middleware/auth.js';

const db = new Database(':memory:');
applySchema(db);
mock.module('../db.js', () => ({ getDatabase: () => db, applySchema }));

const { playlistRoutes } = await import('./playlists.js');

function appAs(sub: string): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use('*', (c, next) => {
    c.set('user', { sub, role: 'user', iat: 0, exp: 9999999999 });
    return next();
  });
  app.route('/', playlistRoutes());
  return app;
}

describe('playlist routes', () => {
  beforeEach(() => {
    db.run('DELETE FROM playlists');
    db.run('DELETE FROM playlist_songs');
  });

  it('rejects a create with no name', async () => {
    const res = await appAs('u1').request('/', { method: 'POST', body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });

  it('creates and lists a playlist for the owning user only', async () => {
    const create = await appAs('u1').request('/', {
      method: 'POST',
      body: JSON.stringify({ name: 'Mine' }),
    });
    expect(create.status).toBe(201);

    const mine = (await (await appAs('u1').request('/')).json()) as { playlists: unknown[] };
    expect(mine.playlists).toHaveLength(1);

    const others = (await (await appAs('u2').request('/')).json()) as { playlists: unknown[] };
    expect(others.playlists).toHaveLength(0);
  });

  it("returns 404 fetching another user's playlist", async () => {
    const create = await appAs('u1').request('/', {
      method: 'POST',
      body: JSON.stringify({ name: 'Mine' }),
    });
    const { playlist } = (await create.json()) as { playlist: { id: string } };
    const res = await appAs('u2').request(`/${playlist.id}`);
    expect(res.status).toBe(404);
  });

  // ─── Curated (system, global, read-only) playlists ─────────────────
  function seedCurated(id: string, name: string): void {
    db.run(
      `INSERT INTO playlists (id, user_id, name, description, cover_art, kind, created_at, modified_at)
       VALUES (?, 'admin', ?, 'desc', '/playlist-covers/x.svg', 'curated', 0, 0)`,
      [id, name],
    );
  }

  it('shows curated playlists to every user with kind + coverArt', async () => {
    seedCurated('c1', 'Latin Beats');
    for (const user of ['u1', 'u2']) {
      const body = (await (await appAs(user).request('/')).json()) as {
        playlists: Array<{ kind: string; coverArt: string | null }>;
      };
      expect(body.playlists).toHaveLength(1);
      expect(body.playlists[0].kind).toBe('curated');
      expect(body.playlists[0].coverArt).toBe('/playlist-covers/x.svg');
    }
  });

  it('lets any user fetch a curated playlist detail', async () => {
    seedCurated('c1', 'Latin Beats');
    const res = await appAs('u2').request('/c1');
    expect(res.status).toBe(200);
  });

  it('blocks updating a curated playlist (read-only)', async () => {
    seedCurated('c1', 'Latin Beats');
    const res = await appAs('u1').request('/c1', {
      method: 'PUT',
      body: JSON.stringify({ name: 'Hacked' }),
    });
    expect(res.status).toBe(404);
  });

  it('blocks deleting a curated playlist (read-only)', async () => {
    seedCurated('c1', 'Latin Beats');
    const res = await appAs('u1').request('/c1', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  // ─── GET /:id/proposals (token-overlap song suggestions) ─────────────────
  describe('GET /:id/proposals', () => {
    beforeEach(() => {
      db.run('DELETE FROM library_songs');
      db.run('DELETE FROM library_albums');
    });

    function seedAlbum(id: string, name: string): void {
      db.run(
        `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, classification, hidden, synced_at)
         VALUES (?, ?, 'A', 'art', 1, 60, 'album', 0, 1)`,
        [id, name],
      );
    }

    function seedSong(id: string, title: string, artist: string): void {
      db.run(
        `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, hidden, landed_at, synced_at)
         VALUES (?, 'alb', ?, ?, 'art', 0, ?, 1000, 320, 'mp3', 'audio/mpeg', '2024-01-01', 0, 1, 1)`,
        [id, title, artist, `Artist/Album/${id}.mp3`],
      );
    }

    it('empty playlist proposes songs matching its own name, excludes non-matches', async () => {
      seedAlbum('alb', 'Album');
      // Every token in the playlist name ("rock", "anthems") must appear as a
      // substring somewhere in title+artist — AND semantics, per matchesAllTokens.
      seedSong('rock1', 'Ultimate Rock Anthems Collection', 'Some Band');
      seedSong('unrelated', 'Quiet Ballad', 'Other Band');

      const { playlist } = (await (
        await appAs('u1').request('/', {
          method: 'POST',
          body: JSON.stringify({ name: 'Rock Anthems' }),
        })
      ).json()) as { playlist: { id: string } };

      const res = await appAs('u1').request(`/${playlist.id}/proposals`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ id: string }>;
      expect(body.map((s) => s.id)).toEqual(['rock1']);
    });

    it('non-empty playlist scores off its tracks, ignoring a rename', async () => {
      seedAlbum('alb', 'Album');
      seedSong('seed', 'Bohemian Rhapsody', 'Queen');
      seedSong('match', 'Bohemian Rhapsody (Live)', 'Queen');
      seedSong('unrelated', 'My Mix Song', 'Nobody');

      const { playlist } = (await (
        await appAs('u1').request('/', {
          method: 'POST',
          body: JSON.stringify({ name: 'My Mix', songIds: ['seed'] }),
        })
      ).json()) as { playlist: { id: string } };

      // Rename to something wholly unrelated to the seed track's tokens.
      await appAs('u1').request(`/${playlist.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: 'Totally Unrelated Title Zzz' }),
      });

      const body = (await (
        await appAs('u1').request(`/${playlist.id}/proposals`)
      ).json()) as Array<{ id: string }>;
      // Still scored off "Bohemian Rhapsody"/"Queen" — not the new name, and
      // not the empty-playlist "seed"-name branch either.
      expect(body.map((s) => s.id)).toEqual(['match']);
    });

    it('a song already in the playlist never appears in its own proposals', async () => {
      seedAlbum('alb', 'Album');
      seedSong('seed', 'Bohemian Rhapsody', 'Queen');
      seedSong('match', 'Bohemian Rhapsody (Live)', 'Queen');

      const { playlist } = (await (
        await appAs('u1').request('/', {
          method: 'POST',
          body: JSON.stringify({ name: 'Mix', songIds: ['seed'] }),
        })
      ).json()) as { playlist: { id: string } };

      const body = (await (
        await appAs('u1').request(`/${playlist.id}/proposals`)
      ).json()) as Array<{ id: string }>;
      expect(body.map((s) => s.id)).not.toContain('seed');
      expect(body.map((s) => s.id)).toEqual(['match']);
    });

    it('adding then removing a track changes the proposal set on the next call', async () => {
      seedAlbum('alb', 'Album');
      seedSong('queen1', 'Bohemian Rhapsody', 'Queen'); // added first
      seedSong('queen_match', 'Bohemian Rhapsody Remix', 'Queen'); // matches queen1's tokens
      seedSong('rock1', 'Rock Anthem', 'Rock Band'); // added after the swap
      seedSong('rock_match', 'Epic Rock Anthem', 'Rock Band'); // matches rock1's tokens

      const { playlist } = (await (
        await appAs('u1').request('/', {
          method: 'POST',
          body: JSON.stringify({ name: 'Mix', songIds: ['queen1'] }),
        })
      ).json()) as { playlist: { id: string } };

      const withQueen = (await (
        await appAs('u1').request(`/${playlist.id}/proposals`)
      ).json()) as Array<{ id: string }>;
      expect(withQueen.map((s) => s.id)).toEqual(['queen_match']);

      await appAs('u1').request(`/${playlist.id}`, {
        method: 'PUT',
        body: JSON.stringify({ remove: ['queen1'], add: ['rock1'] }),
      });

      const afterSwap = (await (
        await appAs('u1').request(`/${playlist.id}/proposals`)
      ).json()) as Array<{ id: string }>;
      expect(afterSwap.map((s) => s.id)).toEqual(['rock_match']);
    });

    it("returns 404 for another user's playlist", async () => {
      const { playlist } = (await (
        await appAs('u1').request('/', {
          method: 'POST',
          body: JSON.stringify({ name: 'Mine' }),
        })
      ).json()) as { playlist: { id: string } };

      const res = await appAs('u2').request(`/${playlist.id}/proposals`);
      expect(res.status).toBe(404);
    });

    it('responds for a curated playlist (read-only GET, no write guard)', async () => {
      seedCurated('c1', 'Latin Beats');
      seedAlbum('alb', 'Album');
      seedSong('latin1', 'Latin Beats Anthem', 'DJ Someone');

      const res = await appAs('u2').request('/c1/proposals');
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ id: string }>;
      expect(body.map((s) => s.id)).toEqual(['latin1']);
    });
  });
});
