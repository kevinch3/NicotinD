import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MiddlewareHandler } from 'hono';
import type { Database } from 'bun:sqlite';
import { mintShareJwt } from './share.js';

/**
 * Server-side Open Graph / Twitter Card injection for `/share/:token`.
 *
 * The SPA sets `<meta property="og:*">` tags at runtime via Angular's Meta
 * service, but link-preview crawlers (Slack, iMessage, WhatsApp, Twitter,
 * Discord, Facebook) fetch the raw HTML and **do not execute JavaScript** — so
 * those tags are invisible to them and shared links render as a bare URL with no
 * title/description/thumbnail. This handler resolves the shared resource
 * server-side and injects real OG tags into `index.html` before serving it, so a
 * crawler sees a rich preview while a real browser still boots the SPA normally.
 *
 * The `og:image` carries a short-lived read-only share JWT (the same kind the
 * client embeds after activation) so the otherwise-authed `/api/cover` endpoint
 * serves the thumbnail to the crawler. Resolving the token here is side-effect
 * free — it never sets `first_accessed_at`, so a human opening the link later
 * still gets the full activation window.
 */

interface ShareTokenRow {
  resource_type: 'playlist' | 'album';
  resource_id: string;
  created_by: string;
  expires_at: number | null;
}

export interface ShareMeta {
  title: string;
  description: string;
  type: 'music.album' | 'music.playlist';
  /** Cover/song/album id for `/api/cover/<id>`, or null when there's no art. */
  coverId: string | null;
  /** JWT subject used to mint the read-only cover token. */
  creatorSub: string;
}

/** Escape a string for safe interpolation into an HTML attribute value. */
export function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface ShareMetaTagInput {
  title: string;
  description: string;
  type: string;
  url: string;
  imageUrl: string | null;
  siteName?: string;
}

/** Build the block of OG + Twitter Card meta tags (pure, fully escaped). */
export function buildShareMetaTags(input: ShareMetaTagInput): string {
  const site = input.siteName ?? 'NicotinD';
  const card = input.imageUrl ? 'summary_large_image' : 'summary';
  const tags = [
    `<meta property="og:site_name" content="${escapeHtmlAttr(site)}" />`,
    `<meta property="og:title" content="${escapeHtmlAttr(input.title)}" />`,
    `<meta property="og:description" content="${escapeHtmlAttr(input.description)}" />`,
    `<meta property="og:type" content="${escapeHtmlAttr(input.type)}" />`,
    `<meta property="og:url" content="${escapeHtmlAttr(input.url)}" />`,
    `<meta name="twitter:card" content="${card}" />`,
    `<meta name="twitter:title" content="${escapeHtmlAttr(input.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtmlAttr(input.description)}" />`,
    `<meta name="description" content="${escapeHtmlAttr(input.description)}" />`,
  ];
  if (input.imageUrl) {
    tags.push(`<meta property="og:image" content="${escapeHtmlAttr(input.imageUrl)}" />`);
    tags.push(`<meta name="twitter:image" content="${escapeHtmlAttr(input.imageUrl)}" />`);
  }
  return tags.join('\n    ');
}

/**
 * Inject a meta-tag block just before `</head>`. Replaces the static
 * `<title>NicotinD</title>` with the resource title so crawlers and tabs that
 * read `<title>` get the right name. Idempotent enough — only the first
 * `</head>` is touched.
 */
export function injectShareMeta(html: string, tagsHtml: string, title: string): string {
  const titled = html.replace(
    /<title>[^<]*<\/title>/,
    `<title>${escapeHtmlAttr(title)} — NicotinD</title>`,
  );
  const block = `    ${tagsHtml}\n  </head>`;
  return titled.includes('</head>') ? titled.replace('</head>', block) : titled;
}

/**
 * Resolve the public origin, honoring a reverse proxy's forwarded headers so the
 * absolute `og:image`/`og:url` point at the user-facing host, not an internal
 * one. Falls back to the request URL's own origin.
 */
export function publicOrigin(headers: Headers, requestUrl: string): string {
  const host = headers.get('x-forwarded-host') ?? headers.get('host');
  if (host) {
    const proto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https';
    return `${proto}://${host}`;
  }
  return new URL(requestUrl).origin;
}

/** Resolve a share token row to display metadata (side-effect free). */
export function resolveShareMeta(db: Database, row: ShareTokenRow): ShareMeta | null {
  if (row.resource_type === 'album') {
    const album = db
      .query<{ name: string; artist: string | null }, [string]>(
        'SELECT name, artist FROM library_albums WHERE id = ?',
      )
      .get(row.resource_id);
    if (!album) return null;
    return {
      title: album.name,
      description: album.artist ? `Album • ${album.artist}` : 'Album',
      type: 'music.album',
      coverId: row.resource_id,
      creatorSub: row.created_by,
    };
  }

  const pl = db
    .query<{ name: string }, [string]>('SELECT name FROM playlists WHERE id = ?')
    .get(row.resource_id);
  if (!pl) return null;
  const count =
    db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM playlist_songs ps
           JOIN library_songs s ON s.id = ps.song_id
          WHERE ps.playlist_id = ?`,
      )
      .get(row.resource_id)?.n ?? 0;
  const firstCover =
    db
      .query<{ cover: string | null }, [string]>(
        `SELECT COALESCE(s.cover_art, s.album_id) AS cover
           FROM playlist_songs ps
           JOIN library_songs s ON s.id = ps.song_id
          WHERE ps.playlist_id = ?
          ORDER BY ps.position ASC LIMIT 1`,
      )
      .get(row.resource_id)?.cover ?? null;
  return {
    title: pl.name,
    description: `Playlist • ${count} ${count === 1 ? 'track' : 'tracks'}`,
    type: 'music.playlist',
    coverId: firstCover,
    creatorSub: row.created_by,
  };
}

export interface ShareMetaHandlerOptions {
  db: Database;
  jwtSecret: string;
  webDistPath: string;
  /** Override index.html read for testing; defaults to reading from disk. */
  readIndexHtml?: () => string | null;
}

/**
 * Hono handler for `GET /share/:token` that serves index.html with injected OG
 * tags. On any miss (bad token, expired, missing resource, no index.html) it
 * falls through to the SPA's normal index.html serving so the app renders its
 * own loading/error/expired states.
 */
export function shareMetaHandler(opts: ShareMetaHandlerOptions): MiddlewareHandler {
  const readIndex =
    opts.readIndexHtml ??
    (() => {
      try {
        return readFileSync(join(opts.webDistPath, 'index.html'), 'utf8');
      } catch {
        return null;
      }
    });

  return async (c, next) => {
    const html = readIndex();
    if (!html) return next();

    const token = c.req.param('token') ?? '';
    const row = opts.db
      .query<ShareTokenRow, [string]>(
        'SELECT resource_type, resource_id, created_by, expires_at FROM share_tokens WHERE token = ?',
      )
      .get(token);

    if (!row || (row.expires_at !== null && row.expires_at < Date.now())) {
      return next();
    }

    const meta = resolveShareMeta(opts.db, row);
    if (!meta) return next();

    const origin = publicOrigin(c.req.raw.headers, c.req.url);
    let imageUrl: string | null = null;
    if (meta.coverId) {
      const jwt = await mintShareJwt(meta.creatorSub, Date.now() + 600_000, opts.jwtSecret);
      imageUrl = `${origin}/api/cover/${meta.coverId}?size=600&token=${jwt}`;
    }

    const tags = buildShareMetaTags({
      title: meta.title,
      description: meta.description,
      type: meta.type,
      url: `${origin}/share/${token}`,
      imageUrl,
    });

    return c.html(injectShareMeta(html, tags, meta.title));
  };
}
