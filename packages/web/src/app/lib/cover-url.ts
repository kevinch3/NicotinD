/** The entity that owns a cover's revision: an album (also for its songs) or an artist. */
export type CoverKind = 'album' | 'artist';

/**
 * Everything a cover URL is built from (#1666). `coverArt` is the id the cover
 * route resolves — never a URL — and `coverRev` is the persisted `cover_rev` the
 * DTO carried beside it (0 when it carried none). `kind` + `id` name the entity
 * that owns that rev, which is not always `coverArt`: a song's `coverArt` can be
 * its own id (embedded art) while the rev that moves is its album's. The live
 * overlay (`CoverRevisionsService`) looks the rev up by that owner.
 *
 * `coverRev` is required on purpose: a caller that forgets it would build an
 * id-only URL, which the browser caches for a day — the bug this type exists
 * to make a compile error. Build one with `artistCover` / `albumCover` /
 * `songCover` rather than by hand.
 */
export interface CoverRef {
  coverArt: string;
  coverRev: number;
  kind: CoverKind;
  id: string;
}

/**
 * The `/api/cover/:id` URL, spelled once.
 *
 * `coverArt` on a Song, Track or RecentPlay is a cover *id*, never a URL —
 * putting the raw id in an `<img src>` 404s into the letter placeholder while
 * the player, building the URL properly, shows the real cover. That exact bug
 * shipped once on the landing's resume block.
 *
 * `v=<rev>` makes the URL change when the bytes do, so a replaced cover is
 * never served from the browser's day-long cache (#1666). It is left off at
 * rev 0 — an entity whose cover never changed — so the URLs browsers already
 * cached stay valid. This spells `ref.coverRev` as given; a component wants the
 * live rev on top, so it calls `CoverRevisionsService.url` instead.
 *
 * The result is deliberately RELATIVE. Run it through
 * `ServerConfigService.apiUrl()` before it reaches the DOM — the native shell
 * talks to a configured remote base, and a relative cover URL there resolves
 * against the app's own origin and fails. `<app-cover-art>` does this in its
 * `resolvedSrc` computed; callers that bypass the component must do it too.
 */
export function coverUrl(ref: CoverRef, size: number, token: string | null): string {
  const v = ref.coverRev > 0 ? `&v=${ref.coverRev}` : '';
  return `/api/cover/${ref.coverArt}?size=${size}${v}&token=${token ?? ''}`;
}

/** An artist portrait, or null for an artist with no cover id. */
export function artistCover(a: {
  id: string;
  coverArt?: string | null;
  coverRev?: number;
}): CoverRef | null {
  return a.coverArt
    ? { coverArt: a.coverArt, coverRev: a.coverRev ?? 0, kind: 'artist', id: a.id }
    : null;
}

/** An album cover, or null for an album with no cover id. */
export function albumCover(a: {
  id: string;
  coverArt?: string | null;
  coverRev?: number;
}): CoverRef | null {
  return a.coverArt
    ? { coverArt: a.coverArt, coverRev: a.coverRev ?? 0, kind: 'album', id: a.id }
    : null;
}

/**
 * A song's or track's cover, or null when it has none. The rev is its album's,
 * so the owner is the album; without an album id (offline metadata) the cover
 * id stands in, which is the album id whenever the art is not embedded.
 */
export function songCover(s: {
  coverArt?: string | null;
  coverRev?: number;
  albumId?: string | null;
}): CoverRef | null {
  if (!s.coverArt) return null;
  return {
    coverArt: s.coverArt,
    coverRev: s.coverRev ?? 0,
    kind: 'album',
    id: s.albumId || s.coverArt,
  };
}

/**
 * Credential a server-built cover URL (the catalog's `/api/cover/remote?u=…`).
 * `/api/cover/*` is behind auth and an `<img>` never carries the interceptor's
 * header, so the server — which has no per-user media key — cannot bake one in.
 * Only our own relative `/api/cover/` URLs gain a token; anything else (an
 * external Spotify/archive URL) and a URL that already has one pass through.
 */
export function withMediaToken(url: string | undefined, token: string | null): string | undefined {
  if (!url || !token || !url.startsWith('/api/cover/') || /[?&]token=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/**
 * Snap a rendered box size to a served cover size, so a 64px tile does not pull
 * a 256px JPEG. The buckets match what the cover route's downscale cache
 * already holds for other call sites; an unbucketed size would miss the cache
 * on every distinct tile size the mosaic produces.
 */
export function coverSizeBucket(px: number): 96 | 160 | 256 {
  if (px <= 96) return 96;
  if (px <= 160) return 160;
  return 256;
}
