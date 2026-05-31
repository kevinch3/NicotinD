import type { Lidarr, LidarrArtist } from '@nicotind/lidarr-client';
import { createLogger } from '@nicotind/core';

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
