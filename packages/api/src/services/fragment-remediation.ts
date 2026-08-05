/**
 * In-app remediation for the fragmentation report (issue #314).
 *
 * The detectors (`library-fragments.ts`) surface defects but offered no fix
 * pathway, so every self-hosted operator hit the same "now what?" wall. The
 * mis-split cluster is the one class with no pre-existing curator action —
 * merging it means unifying `ALBUMARTIST` across the cluster's files so the
 * next scan groups them as one release (the scanner's albumArtist-groups /
 * trackArtist-performs split keeps the per-track credits intact).
 *
 * Deliberately **preview → curator-selects → apply**: a title-only cluster
 * can sweep in unrelated albums that merely share a generic title (prod's
 * "20 Grandes Exitos" is four different artists' own best-ofs), so the
 * curator sees every member and deselects false positives before anything
 * touches a file — the config-import dry-run discipline applied to tags.
 */
import type { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { normalizeForGrouping } from './album-grouping.js';
import { writeAudioTags, type AudioTags } from './audio-tags.js';

export interface MissplitMember {
  albumId: string;
  name: string;
  artist: string;
  classification: string;
  songCount: number;
  /** True for the 1-track singles the detector flagged; the curator may still
   *  include larger members (credit-variant 2-3 track fragments). */
  flagged: boolean;
  paths: string[];
}

/** Every album sharing the cluster's normalized title, with its song paths. */
export function missplitClusterMembers(db: Database, key: string): MissplitMember[] {
  const albums = db
    .query<
      { id: string; name: string; artist: string; classification: string; song_count: number },
      []
    >('SELECT id, name, artist, classification, song_count FROM library_albums')
    .all()
    .filter((a) => normalizeForGrouping(a.name) === key);
  return albums.map((a) => ({
    albumId: a.id,
    name: a.name,
    artist: a.artist,
    classification: a.classification,
    songCount: a.song_count,
    flagged: a.classification === 'single' && a.song_count === 1,
    paths: db
      .query<{ path: string }, [string]>('SELECT path FROM library_songs WHERE album_id = ?')
      .all(a.id)
      .map((r) => r.path),
  }));
}

/** The albumArtist a merge should default to: the dominant member's artist
 *  when the cluster contains a real (≥3-track) album, else Various Artists —
 *  an all-fragment cluster is almost always a VA/DJ-pool compilation. */
export function suggestAlbumArtist(members: MissplitMember[]): string {
  const dominant = [...members].sort((a, b) => b.songCount - a.songCount)[0];
  if (dominant && dominant.songCount >= 3) return dominant.artist;
  return 'Various Artists';
}

export interface MissplitMergeResult {
  tagged: number;
  failed: number;
}

/** Writes the unified ALBUMARTIST into every song file of the selected
 *  albums. VA merges also set the COMPILATION flag so `classifyFolder`
 *  recognizes the merged row. The caller triggers the rescan + audit. */
export async function applyMissplitMerge(
  db: Database,
  musicDir: string,
  albumIds: string[],
  albumArtist: string,
  writeTags: (abs: string, tags: AudioTags) => Promise<boolean> = writeAudioTags,
): Promise<MissplitMergeResult> {
  const tags: AudioTags =
    albumArtist === 'Various Artists' ? { albumArtist, compilation: true } : { albumArtist };
  let tagged = 0;
  let failed = 0;
  for (const albumId of albumIds) {
    const rows = db
      .query<{ path: string }, [string]>('SELECT path FROM library_songs WHERE album_id = ?')
      .all(albumId);
    for (const { path } of rows) {
      const ok = await writeTags(join(musicDir, path), tags).catch(() => false);
      if (ok) tagged++;
      else failed++;
    }
  }
  return { tagged, failed };
}
