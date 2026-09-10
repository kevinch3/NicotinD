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
  /** Mood label from tags (Vorbis `MOOD` / ID3 TMOO), when present. */
  mood?: string;
  /** Copyright text/URL (music-metadata folds TCOP/COPYRIGHT/©cpy), when present. */
  copyright?: string;
  picture?: Array<{ format?: string; data: Uint8Array }>;
}

export interface MMFormat {
  duration?: number;
  bitrate?: number;
  container?: string;
  codec?: string;
  /** True when the audio codec is lossless (e.g. FLAC, ALAC) — codec-derived, not extension-derived. */
  lossless?: boolean;
  /** Sample rate in Hz (e.g. 44100). */
  sampleRate?: number;
  /** Bit depth in bits/sample (e.g. 16/24) — reported by lossless formats. */
  bitsPerSample?: number;
  /** Channel count (1 = mono, 2 = stereo, …). */
  numberOfChannels?: number;
}

export interface MMResult {
  common: MMCommon;
  format: MMFormat;
  /** Raw per-format tag frames (e.g. `vorbis`, `ID3v2.4`) — needed for custom keys. */
  native?: Record<string, Array<{ id: string; value: unknown }>>;
}

/** Higher-priority tag frames carrying a track number, best first (music-metadata's TagPriority). */
const TRACK_FRAMES: ReadonlyArray<[tagType: string, id: string]> = [
  ['APEv2', 'track'],
  ['ID3v2.4', 'TRCK'],
  ['ID3v2.3', 'TRCK'],
  ['ID3v2.2', 'TRK'],
];

/**
 * The file's track number. music-metadata maps `track` without its tag-priority
 * check, so an ID3v1 trailer (parsed last) overwrites ID3v2's TRCK — and every
 * ID3 writer here updates only ID3v2. Prefer a higher-priority frame whenever an
 * ID3v1 tag is present (issue #1077).
 */
export function trackNoFromParse(meta: Pick<MMResult, 'common' | 'native'> | undefined) {
  const common = meta?.common?.track?.no ?? undefined;
  if (!meta?.native?.ID3v1) return common;
  for (const [tagType, id] of TRACK_FRAMES) {
    const frame = meta.native[tagType]?.find((t) => t.id.toLowerCase() === id.toLowerCase());
    const n = parseInt(String(frame?.value ?? ''), 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return common;
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
