/**
 * The catalog the stand-in services (demo Lidarr, demo addon) serve, decoupled
 * from where it comes from: the generated tone catalog drives the product tour,
 * the pinned CC catalog (`demo/cc-catalog.ts`) drives the static demo snapshot.
 */
import { join } from 'node:path';
import { DEMO_ALBUMS, demoTracks } from '../../core/src/demo/index.js';
import { albumDir, trackFileName } from './make-demo-library.js';

export interface StandInTrack {
  title: string;
  trackNumber: number;
  durationSec: number;
  /** Stable per-track seed for fake MBIDs. */
  seed: string;
  /** File name inside the album's `dir`. */
  fileName: string;
}

export interface StandInAlbum {
  artist: string;
  title: string;
  year: number;
  genre: string;
  pool: 'library' | 'acquirable';
  /** Directory holding the tracks and a `cover.jpg`. */
  dir: string;
  tracks: StandInTrack[];
}

export function trackPath(album: StandInAlbum, track: StandInTrack): string {
  return join(album.dir, track.fileName);
}

export function toneCatalog(): StandInAlbum[] {
  return DEMO_ALBUMS.map((album) => ({
    artist: album.artist,
    title: album.title,
    year: album.year,
    genre: album.genre,
    pool: album.pool,
    dir: albumDir(album),
    tracks: demoTracks(album).map((t) => ({
      title: t.title,
      trackNumber: t.trackNumber,
      durationSec: t.tone.durationSec,
      seed: t.seed,
      fileName: trackFileName(t),
    })),
  }));
}
