import type { Database } from 'bun:sqlite';
import type { JwtPayload } from '@nicotind/core';
import type { Lidarr } from '../lidarr/index.js';
import { acquireAlbum, type AcquireOutcome } from './album-acquire.js';
import { normalizeForGrouping } from './album-grouping.js';
import { artistIdFor } from './library-scanner.js';
import { recordAudit } from './audit-log.js';
import type { RemoteAddonPlugin } from './addons/remote-addon-plugin.js';

export interface CompleteAlbumDeps {
  db: Database;
  lidarr?: Lidarr | null;
  getAddon: () => RemoteAddonPlugin | null;
  /** The runtime acquisition kill-switch. */
  isAcquisitionEnabled: () => boolean;
  minMatchPct: number;
}

export type CompleteAlbumResult =
  | { ok: true; outcome: AcquireOutcome; detail?: string; lidarrAlbumId: number }
  | {
      ok: false;
      reason:
        | 'album-not-found'
        | 'no-target'
        | 'acquisition-disabled'
        | 'lidarr-unconfigured'
        | 'unresolvable';
      error: string;
    };

/**
 * The newest Lidarr album id any recorded hunt used for this artist/title pair,
 * across `album_jobs` UNION `acquisition_jobs` — the same pair-matching
 * (`artist_id` + edition-stripped title) as `matchingLocalAlbums`.
 */
function huntedLidarrAlbumId(db: Database, artist: string, album: string): number | null {
  const artistKey = artistIdFor(artist);
  const titleKey = normalizeForGrouping(album);
  let rows: Array<{ artist_name: string; album_title: string; lidarr_album_id: number }>;
  try {
    rows = db
      .query<(typeof rows)[number], []>(
        `SELECT artist_name, album_title, lidarr_album_id, created_at FROM album_jobs
         WHERE artist_name IS NOT NULL AND album_title IS NOT NULL AND lidarr_album_id IS NOT NULL
         UNION ALL
         SELECT artist_name, album_title, lidarr_album_id, created_at FROM acquisition_jobs
         WHERE artist_name IS NOT NULL AND album_title IS NOT NULL AND lidarr_album_id IS NOT NULL
         ORDER BY created_at DESC`,
      )
      .all();
  } catch {
    return null; // job tables absent — the lookup fallback decides
  }
  const hit = rows.find(
    (j) =>
      artistIdFor(j.artist_name) === artistKey && normalizeForGrouping(j.album_title) === titleKey,
  );
  return hit?.lidarr_album_id ?? null;
}

/**
 * "Complete this album": hunt ONLY its missing tracks through `acquireAlbum`
 * (idempotent — `already-complete` / `in-flight` are notices, never a duplicate
 * download). The one implementation behind the MCP `complete_album` tool and
 * the album page's curator action (issue #737), so both resolve the Lidarr id,
 * honour the kill-switch and audit the same way. → docs/library-audit.md
 */
export async function completeAlbum(
  deps: CompleteAlbumDeps,
  target: { albumId?: string; artist?: string; album?: string },
  audit: { actor: Pick<JwtPayload, 'sub' | 'username'>; via?: string },
): Promise<CompleteAlbumResult> {
  const { db } = deps;
  const albumId = target.albumId?.trim() ?? '';
  let artist = target.artist?.trim() ?? '';
  let album = target.album?.trim() ?? '';
  if (albumId) {
    const row = db
      .query<{ name: string; artist: string }, [string]>(
        'SELECT name, artist FROM library_albums WHERE id = ?',
      )
      .get(albumId);
    if (!row) return { ok: false, reason: 'album-not-found', error: 'Album not found' };
    artist = row.artist;
    album = row.name;
  }
  if (!artist || !album) {
    return { ok: false, reason: 'no-target', error: 'Provide albumId, or artist + album' };
  }
  if (!deps.isAcquisitionEnabled()) {
    return {
      ok: false,
      reason: 'acquisition-disabled',
      error: 'Acquisition is disabled on this server',
    };
  }
  const lidarr = deps.lidarr;
  if (!lidarr) return { ok: false, reason: 'lidarr-unconfigured', error: 'Lidarr not configured' };

  // Hunt history first (proven canonical), then a normalize-matched lookup —
  // no catalog provisioning here; anything else stays a web-flow decision.
  let lidarrAlbumId = huntedLidarrAlbumId(db, artist, album);
  if (lidarrAlbumId == null) {
    const titleKey = normalizeForGrouping(album);
    const hits = await lidarr.album.lookup(`${artist} ${album}`).catch(() => []);
    const hit = hits.find(
      (h) => typeof h.id === 'number' && h.id > 0 && normalizeForGrouping(h.title) === titleKey,
    );
    lidarrAlbumId = hit?.id ?? null;
  }
  if (lidarrAlbumId == null) {
    return {
      ok: false,
      reason: 'unresolvable',
      error: 'Album not resolvable via Lidarr — use the web catalog flow',
    };
  }

  const { outcome, detail } = await acquireAlbum(
    { db, lidarr, getAddon: deps.getAddon },
    {
      lidarrAlbumId,
      artistName: artist,
      albumTitle: album,
      minMatchPct: deps.minMatchPct,
      artistMbid: null,
    },
  );
  recordAudit(db, audit.actor, 'album.acquire', {
    targetKind: 'album',
    targetId: albumId || `${artist} — ${album}`,
    detail: `outcome=${outcome} lidarrAlbumId=${lidarrAlbumId}${detail ? ` detail=${detail}` : ''}${
      audit.via ? ` (${audit.via})` : ''
    }`,
  });
  return { ok: true, outcome, ...(detail ? { detail } : {}), lidarrAlbumId };
}
