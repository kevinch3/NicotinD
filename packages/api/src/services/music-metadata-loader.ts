/**
 * Shared lazy loader for `music-metadata`. The library is an optional native
 * dependency (heavy parsers); the codebase loads it via dynamic import and
 * degrades gracefully when it's absent — see audio-tags.ts for the original
 * pattern. This exposes a fuller typed surface (format + cover picture + genre)
 * for the library scanner and cover-art extraction.
 */
export interface MMCommon {
  title?: string;
  artist?: string;
  albumartist?: string;
  album?: string;
  track?: { no?: number | null };
  disk?: { no?: number | null };
  year?: number;
  genre?: string[];
  /** Beats per minute from tags (TBPM / `BPM`), when present. */
  bpm?: number;
  /** Musical key from tags (TKEY / `KEY` / `INITIALKEY`), when present. */
  key?: string;
  picture?: Array<{ format?: string; data: Uint8Array }>;
}

export interface MMFormat {
  duration?: number;
  bitrate?: number;
  container?: string;
  codec?: string;
}

export interface MMResult {
  common: MMCommon;
  format: MMFormat;
}

export type MusicMetadataApi = {
  parseFile: (
    path: string,
    opts?: { duration?: boolean; skipCovers?: boolean },
  ) => Promise<MMResult>;
};

let mmPromise: Promise<MusicMetadataApi | null> | null = null;

export async function getMusicMetadata(): Promise<MusicMetadataApi | null> {
  if (!mmPromise) {
    mmPromise = import('music-metadata')
      .then((mod) => mod as unknown as MusicMetadataApi)
      .catch(() => null);
  }
  return mmPromise;
}

/** Reset the cached loader (tests only). */
export function _resetMusicMetadata(): void {
  mmPromise = null;
}
