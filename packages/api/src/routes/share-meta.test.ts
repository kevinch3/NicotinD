/**
 * Server-side OG/Twitter meta injection for shared links. Covers the pure tag
 * builders + origin resolution and the DB-backed resolver/handler against a real
 * in-memory DB. The point: crawlers (which don't run the SPA's JS) must get real
 * meta tags so a shared album/playlist renders a rich preview.
 */
import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { applySchema } from '../db.js';
import {
  escapeHtmlAttr,
  buildShareMetaTags,
  injectShareMeta,
  publicOrigin,
  resolveShareMeta,
  shareMetaHandler,
} from './share-meta.js';

const INDEX_HTML = '<!doctype html><html><head><title>NicotinD</title></head><body></body></html>';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

function seedAlbum(): string {
  const id = 'alb-1';
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
     VALUES (?, 'Discovery', 'Daft Punk', 'art-1', 1, 300, 1)`,
    [id],
  );
  return id;
}

function seedPlaylist(): string {
  const plId = 'pl-1';
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
     VALUES ('alb-x', 'Album X', 'Artist X', 'art-x', 1, 200, 1)`,
  );
  db.run(
    `INSERT INTO library_songs (id, album_id, artist_id, title, artist, duration, path, cover_art, synced_at)
     VALUES ('song-1', 'alb-x', 'art-x', 'Track One', 'Artist X', 100, '/m/a/1.opus', 'cov-1', 1)`,
  );
  db.run(
    `INSERT INTO playlists (id, user_id, name, created_at, modified_at) VALUES (?, 'u1', 'Road Trip', 1, 1)`,
    [plId],
  );
  db.run(
    `INSERT INTO playlist_songs (playlist_id, song_id, position, added_at) VALUES (?, 'song-1', 0, 1)`,
    [plId],
  );
  return plId;
}

describe('escapeHtmlAttr', () => {
  it('escapes quotes and angle brackets', () => {
    expect(escapeHtmlAttr('a "b" <c> & \'d\'')).toBe('a &quot;b&quot; &lt;c&gt; &amp; &#39;d&#39;');
  });
});

describe('buildShareMetaTags', () => {
  it('emits OG + Twitter tags with a large image card when an image is present', () => {
    const html = buildShareMetaTags({
      title: 'Discovery',
      description: 'Daft Punk',
      type: 'music.album',
      url: 'https://host/share/tok',
      imageUrl: 'https://host/api/cover/alb-1?token=x',
    });
    expect(html).toContain('property="og:title" content="Discovery"');
    expect(html).toContain('property="og:type" content="music.album"');
    expect(html).toContain('property="og:image" content="https://host/api/cover/alb-1?token=x"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
  });

  it('downgrades the twitter card and omits image tags when there is no image', () => {
    const html = buildShareMetaTags({
      title: 'X',
      description: 'Y',
      type: 'music.playlist',
      url: 'https://host/share/tok',
      imageUrl: null,
    });
    expect(html).toContain('name="twitter:card" content="summary"');
    expect(html).not.toContain('og:image');
  });
});

describe('injectShareMeta', () => {
  it('replaces the title and inserts tags before </head>', () => {
    const out = injectShareMeta(INDEX_HTML, '<meta property="og:title" content="Z" />', 'Z');
    expect(out).toContain('<title>Z — NicotinD</title>');
    expect(out).toContain('<meta property="og:title" content="Z" />\n  </head>');
    expect(out.indexOf('og:title')).toBeLessThan(out.indexOf('</head>'));
  });
});

describe('publicOrigin', () => {
  it('honors x-forwarded-host/proto', () => {
    const h = new Headers({ 'x-forwarded-host': 'pub.example', 'x-forwarded-proto': 'https' });
    expect(publicOrigin(h, 'http://internal:8484/share/tok')).toBe('https://pub.example');
  });

  it('falls back to the request URL origin', () => {
    expect(publicOrigin(new Headers(), 'http://localhost:8484/share/tok')).toBe(
      'http://localhost:8484',
    );
  });
});

describe('resolveShareMeta', () => {
  it('resolves an album', () => {
    const id = seedAlbum();
    const meta = resolveShareMeta(db, {
      resource_type: 'album',
      resource_id: id,
      created_by: 'u1',
      expires_at: null,
    });
    expect(meta).toEqual({
      title: 'Discovery',
      description: 'Album • Daft Punk',
      type: 'music.album',
      coverId: id,
      creatorSub: 'u1',
    });
  });

  it('resolves a playlist with a count and the first track cover', () => {
    const id = seedPlaylist();
    const meta = resolveShareMeta(db, {
      resource_type: 'playlist',
      resource_id: id,
      created_by: 'u1',
      expires_at: null,
    });
    expect(meta?.title).toBe('Road Trip');
    expect(meta?.description).toBe('Playlist • 1 track');
    expect(meta?.coverId).toBe('cov-1');
    expect(meta?.type).toBe('music.playlist');
  });

  it('returns null for a missing resource', () => {
    expect(
      resolveShareMeta(db, {
        resource_type: 'album',
        resource_id: 'nope',
        created_by: 'u1',
        expires_at: null,
      }),
    ).toBeNull();
  });
});

describe('shareMetaHandler', () => {
  function mount() {
    const app = new Hono();
    app.get(
      '/share/:token',
      shareMetaHandler({
        db,
        jwtSecret: 'secret',
        webDistPath: '/unused',
        readIndexHtml: () => INDEX_HTML,
      }),
    );
    app.get('*', (c) => c.text('FALLTHROUGH'));
    return app;
  }

  it('injects meta + a tokenized cover url for a valid album token', async () => {
    const albumId = seedAlbum();
    db.run(
      `INSERT INTO share_tokens (token, resource_type, resource_id, created_by, created_at) VALUES ('tok1', 'album', ?, 'u1', 1)`,
      [albumId],
    );
    const res = await mount().request('http://host/share/tok1');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('property="og:title" content="Discovery"');
    // `&` is HTML-escaped to `&amp;` inside the attribute (crawlers decode it back).
    expect(body).toMatch(/og:image" content="http:\/\/host\/api\/cover\/alb-1\?size=600&amp;token=/);
  });

  it('falls through to the SPA for an unknown token', async () => {
    const res = await mount().request('http://host/share/missing');
    expect(await res.text()).toBe('FALLTHROUGH');
  });

  it('falls through for an expired token (no preview leak)', async () => {
    const albumId = seedAlbum();
    db.run(
      `INSERT INTO share_tokens (token, resource_type, resource_id, created_by, created_at, first_accessed_at, expires_at)
       VALUES ('tokold', 'album', ?, 'u1', 1, 1, 1)`,
      [albumId],
    );
    const res = await mount().request('http://host/share/tokold');
    expect(await res.text()).toBe('FALLTHROUGH');
  });
});
