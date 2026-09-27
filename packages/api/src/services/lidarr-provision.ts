import type { Lidarr, LidarrArtist } from '../lidarr/index.js';
import { createLogger } from '@nicotind/core';
import { corroboratesLidarrHit } from './lidarr-confidence.js';
import { normalizeArtistForGrouping } from './album-grouping.js';

const log = createLogger('lidarr-provision');

/**
 * Adds an artist to Lidarr from a `lookup()` candidate, provisioning the
 * prerequisites Lidarr's POST /artist requires (a quality profile, a metadata
 * profile, a root folder). When no root folder exists yet we auto-provision one
 * pointing at `musicDir` — a fresh Lidarr ships with none.
 *
 * Shared by the discography flow (add-on-demand for a local-library artist) and
 * catalog search (add-on-demand for a MusicBrainz hit that has no local row), so
 * the provisioning logic lives in exactly one place.
 */
export async function addArtistFromLookup(
  lidarr: Lidarr,
  candidate: LidarrArtist,
  musicDir?: string,
): Promise<LidarrArtist> {
  const [profiles, metadataProfiles, initialRootFolders] = await Promise.all([
    lidarr.artist.getQualityProfiles(),
    lidarr.artist.getMetadataProfiles(),
    lidarr.artist.getRootFolders(),
  ]);

  if (!profiles.length) throw new Error('Lidarr has no quality profiles configured');
  if (!metadataProfiles.length) throw new Error('Lidarr has no metadata profiles configured');

  let rootFolders = initialRootFolders;
  if (!rootFolders.length) {
    if (!musicDir) throw new Error('Lidarr has no root folders configured');
    log.info({ path: musicDir }, 'No Lidarr root folder — provisioning music dir');
    const added = await lidarr.artist.addRootFolder(musicDir);
    rootFolders = [added];
  }

  const added = await lidarr.artist.add(
    candidate,
    profiles[0].id,
    rootFolders[0].path,
    metadataProfiles[0].id,
  );

  log.info({ artistName: added.artistName, lidarrId: added.id }, 'Artist added to Lidarr');
  return added;
}

/** Who to add: a local library artist (discography) or a MusicBrainz hit (catalog). */
export interface ProvisionTarget {
  artistName: string;
  /** A MusicBrainz id the caller already chose; picks the lookup hit by id. */
  artistMbid?: string | null;
  /** Local library artist id: the hit must corroborate the name (#212). */
  localArtistId?: string | null;
}

/**
 * What a read path answers instead of adding the artist itself (issue #644):
 * adding runs Lidarr's synchronous whole-discography import, so it is an
 * explicit action on `ArtistProvisioningService`, never a side effect of a read.
 */
export interface ArtistNotProvisioned {
  notProvisioned: true;
  artistName: string;
  artistMbid: string | null;
}

export function isNotProvisioned(v: unknown): v is ArtistNotProvisioned {
  return typeof v === 'object' && v !== null && (v as ArtistNotProvisioned).notProvisioned === true;
}

export function sameProvisionTarget(a: ProvisionTarget, b: ProvisionTarget): boolean {
  if (a.localArtistId || b.localArtistId) return a.localArtistId === b.localArtistId;
  if (a.artistMbid && b.artistMbid) return a.artistMbid === b.artistMbid;
  return normalizeArtistForGrouping(a.artistName) === normalizeArtistForGrouping(b.artistName);
}

/**
 * The whole add: an artist Lidarr already monitors is returned as-is, otherwise
 * the lookup hit is added. `shouldStop` is checked before the add — the one step
 * that cannot be taken back — and a stop there returns null.
 */
export async function provisionArtist(
  lidarr: Lidarr,
  target: ProvisionTarget,
  opts: { musicDir?: string; shouldStop?: () => boolean } = {},
): Promise<{ artist: LidarrArtist; added: boolean } | null> {
  const key = normalizeArtistForGrouping(target.artistName);
  const monitored = await lidarr.artist.list();
  const existing = monitored.find(
    (a) =>
      (!!target.artistMbid && a.foreignArtistId === target.artistMbid) ||
      normalizeArtistForGrouping(a.artistName) === key,
  );
  if (existing) return { artist: existing, added: false };

  const candidates = await lidarr.artist.lookup(target.artistName);
  const best =
    (target.artistMbid && candidates.find((a) => a.foreignArtistId === target.artistMbid)) ||
    candidates[0];
  if (!best) throw new Error(`Lidarr found no artist matching "${target.artistName}"`);
  if (target.localArtistId && !corroboratesLidarrHit(target.artistName, best)) {
    throw new Error(`No confident Lidarr match for "${target.artistName}"`);
  }
  if (opts.shouldStop?.()) return null;
  return { artist: await addArtistFromLookup(lidarr, best, opts.musicDir), added: true };
}
