// What the provider (the Soulseek network) actually holds, per album (#1538).
//
// The catalog grid is Lidarr's free-text lookup: it shows releases no peer has
// and misses ones half the network does (Christian Löffler's grid was 8 early
// EPs while 20 peers held *Mare*). The page already has every peer folder the
// network search answered with, so this joins the two client-side — no new
// call — to mark each catalog card with its availability and to surface the
// albums only the provider knows as cards of their own.

import {
  artistCredits,
  cleanFolderName,
  folderAlbumIdentity,
  normalizeArtistForGrouping,
  normalizeForGrouping,
} from '@nicotind/core';
import { folderAudioFiles, folderFormat, type FolderGroup } from './folder-utils';

/** A folder below this many tracks is a single or a stray, not an album copy. */
export const MIN_ALBUM_TRACKS = 3;

export interface ProviderAvailability {
  /** Distinct peers holding a copy. */
  peers: number;
  /** The most tracks any one copy has. */
  bestTracks: number;
  /** Some copy is lossless. */
  lossless: boolean;
  /** Some copy has at least the release's track count. */
  complete: boolean;
  /** Every matching folder, best copy first. */
  folders: FolderGroup[];
}

export interface ProviderOnlyAlbum {
  /** Grouping key — stable across copies, used as the card's track key. */
  key: string;
  title: string;
  artist: string;
  availability: ProviderAvailability;
}

function segments(directory: string): string[] {
  return directory.split(/[\\/]+/).filter(Boolean);
}

/** Lowercased, diacritic-free path, for "does the path name this act" checks. */
function normalizedPath(directory: string): string {
  return normalizeArtistForGrouping(segments(directory).join(' / '));
}

/**
 * The album-title keys a folder name can stand for: the cleaned name itself,
 * and — for "Artist - Album" or "2016 - Album" — the part after the dash.
 */
function titleKeys(segment: string): string[] {
  const cleaned = cleanFolderName(segment);
  const keys = [normalizeForGrouping(cleaned)];
  const dash = cleaned.match(/^.+?\s+[-–—]\s+(.+)$/);
  if (dash) keys.push(normalizeForGrouping(dash[1]!));
  return keys.filter(Boolean);
}

/** True when the folder's path names an act of `artist` (a credit, diacritic-free). */
function pathNamesArtist(directory: string, artist: string): boolean {
  const path = normalizedPath(directory);
  return artistCredits(artist).some((credit) => path.includes(credit));
}

/**
 * Whether a peer folder is a copy of the album: one of its path segments
 * folds to the album's title key, and the path names one of its acts. Segment
 * equality rather than a substring, so *Mare* never matches *Mare Reworks*;
 * any segment rather than the leaf, so "Fabric 54 - Damian Lazarus/CD1" counts.
 */
export function folderIsAlbum(
  folder: FolderGroup,
  album: { artistName: string; title: string },
): boolean {
  const want = normalizeForGrouping(album.title);
  if (!want || !pathNamesArtist(folder.directory, album.artistName)) return false;
  return segments(folder.directory).some((s) => titleKeys(s).includes(want));
}

function availabilityOf(folders: FolderGroup[], trackCount?: number): ProviderAvailability {
  const ranked = [...folders].sort(
    (a, b) => folderAudioFiles(b).length - folderAudioFiles(a).length,
  );
  const bestTracks = ranked.length ? folderAudioFiles(ranked[0]!).length : 0;
  return {
    peers: new Set(folders.map((f) => f.username)).size,
    bestTracks,
    lossless: folders.some((f) => folderFormat(f)?.lossless === true),
    complete: trackCount ? bestTracks >= trackCount : bestTracks >= MIN_ALBUM_TRACKS,
    folders: ranked,
  };
}

/** Album-shaped folders only: a stray track or two says nothing about an album. */
function albumShaped(folders: FolderGroup[]): FolderGroup[] {
  return folders.filter((f) => folderAudioFiles(f).length >= MIN_ALBUM_TRACKS);
}

/** Per catalog album, what the network holds of it — null when no peer has a copy. */
export function availabilityFor(
  album: { artistName: string; title: string; trackCount?: number },
  folders: FolderGroup[],
): ProviderAvailability | null {
  const copies = albumShaped(folders).filter((f) => folderIsAlbum(f, album));
  return copies.length ? availabilityOf(copies, album.trackCount) : null;
}

/**
 * Albums the network holds for `artist` that no catalog card covers — the
 * provider's own discography. A folder counts when its path names the artist
 * (collaborations included: "Damian Lazarus & The Ancient Moons"), it is
 * album-shaped, and it matches no catalog album. Copies group by title key;
 * most peers first. A folder whose title is just the artist's name is a
 * container, not an album.
 */
export function providerOnlyAlbums(
  folders: FolderGroup[],
  catalog: Array<{ artistName: string; title: string }>,
  artist: string,
  limit = 12,
): ProviderOnlyAlbum[] {
  const artistKeys = new Set(artistCredits(artist).map((c) => normalizeForGrouping(c)));
  const groups = new Map<string, { titles: string[]; artists: string[]; folders: FolderGroup[] }>();
  for (const folder of albumShaped(folders)) {
    if (!pathNamesArtist(folder.directory, artist)) continue;
    if (catalog.some((album) => folderIsAlbum(folder, album))) continue;
    const identity = folderAlbumIdentity(folder.directory);
    if (!identity.title) continue;
    const key = normalizeForGrouping(identity.title);
    if (!key || artistKeys.has(key)) continue;
    const group = groups.get(key) ?? { titles: [], artists: [], folders: [] };
    group.titles.push(displayTitle(identity.title));
    group.artists.push(identity.artist ?? artist);
    group.folders.push(folder);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      title: mostCommon(g.titles),
      artist: mostCommon(g.artists),
      availability: availabilityOf(g.folders),
    }))
    .sort(
      (a, b) =>
        b.availability.peers - a.availability.peers ||
        b.availability.bestTracks - a.availability.bestTracks ||
        a.title.localeCompare(b.title),
    )
    .slice(0, limit);
}

/** A folder's album name for a card: a trailing "(2024)" is the peer's filing, not the title. */
function displayTitle(title: string): string {
  return title.replace(/\s*\((?:19|20)\d{2}\)\s*$/, '').trim() || title;
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
}
