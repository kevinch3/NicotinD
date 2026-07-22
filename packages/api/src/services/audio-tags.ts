import { spawn } from 'node:child_process';
import { extname } from 'node:path';
import { renameSync, unlinkSync } from 'node:fs';
import { createLogger, MOOD_VOCAB, normalizeLicence, type MoodLabel } from '@nicotind/core';
import { ffmpegBinary } from './ffmpeg-path.js';

const log = createLogger('audio-tags');

export const ID3_EXTS = new Set(['.mp3']);
export const VORBIS_EXTS = new Set(['.flac', '.ogg', '.opus']);
export const AUDIO_EXTS = new Set([
  ...ID3_EXTS,
  ...VORBIS_EXTS,
  '.m4a',
  '.wav',
  '.aac',
  '.aiff',
  '.alac',
]);

export interface AudioTags {
  artist?: string;
  albumArtist?: string;
  album?: string;
  title?: string;
  trackNumber?: number;
  year?: number;
  genre?: string;
  /** Beats per minute (TBPM / Vorbis `BPM`). Written by on-demand track analysis. */
  bpm?: number;
  /** Musical key (TKEY / Vorbis `KEY`). Written by on-demand/windowed key analysis. */
  key?: string;
  /** Plain-text lyrics (ID3 USLT / Vorbis `LYRICS`). Written by on-demand lyrics fetch/edit. */
  lyrics?: string;
  /** Perceived energy 0..1 (TXXX/Vorbis `ENERGY`). Derived from ffmpeg ebur128 loudness. */
  energy?: number;
  /** Integrated loudness in LUFS (TXXX/Vorbis `LOUDNESS_LUFS`). From ffmpeg ebur128. */
  loudness?: number;
  /** Musical positivity 0..1 (TXXX/Vorbis `VALENCE`). From the analysis sidecar. */
  valence?: number;
  /** Danceability 0..1 (TXXX/Vorbis `DANCEABILITY`). From the analysis sidecar. */
  danceability?: number;
  /** Acoustic (vs produced/electronic) confidence 0..1 (TXXX/Vorbis `ACOUSTICNESS`). */
  acousticness?: number;
  /** Probability the track is instrumental 0..1 (TXXX/Vorbis `INSTRUMENTALNESS`). */
  instrumental?: number;
  /** Dominant mood label (TXXX/Vorbis `MOOD`), from MOOD_VOCAB. */
  mood?: string;
  /**
   * Rights/licence code from LICENCE_VOCAB (ID3 `TXXX:LICENSE` / Vorbis
   * `LICENSE`). Read from LICENSE → WCOP → COPYRIGHT frames, normalised to a
   * canonical code; written to the LICENSE frame only (never clobbers an
   * existing copyright notice).
   */
  licence?: string;
  compilation?: boolean;
  /** AcoustID track UUID. Doubles as a "we've already fingerprinted this" marker. */
  acoustIdId?: string;
  /** MusicBrainz recording ID. */
  mbRecordingId?: string;
  /** MusicBrainz release (album) ID. */
  mbReleaseId?: string;
}

type NodeId3UserText = { description: string; value: string };
type NodeId3Api = {
  read: (filepath: string) => Record<string, unknown> | false | undefined;
  update: (tags: Record<string, unknown>, filepath: string) => boolean;
};
type MusicMetadataApi = {
  parseFile: (
    path: string,
    opts?: { duration?: boolean },
  ) => Promise<{
    common: {
      artist?: string;
      albumartist?: string;
      album?: string;
      title?: string;
      track?: { no?: number | null };
      year?: number;
      key?: string;
      mood?: string;
      /** Normalised copyright text/URL (music-metadata folds TCOP/COPYRIGHT/©cpy). */
      copyright?: string;
      acoustid_id?: string;
      musicbrainz_recordingid?: string;
      musicbrainz_albumid?: string;
      lyrics?: Array<string | { text?: string }> | string;
    };
    native?: NativeTagMap;
  }>;
};

// MusicBrainz Picard's TXXX description conventions — kept consistent so other
// tools (Picard, beets, Lidarr, Jellyfin) round-trip the same values.
const TXXX_ACOUSTID = 'Acoustid Id';
const TXXX_MB_RECORDING = 'MusicBrainz Track Id';
const TXXX_MB_RELEASE = 'MusicBrainz Album Id';

/**
 * Closed mood vocabulary — argmax over the sidecar's mood heads. Canonical
 * definition lives in @nicotind/core (shared with the web filter UI);
 * re-exported here so tag-pipeline importers keep their import path.
 */
export { MOOD_VOCAB, type MoodLabel };

// Tag keys for the perceptual features. Used verbatim as Vorbis comment names
// and as ID3 TXXX descriptions (no cross-tool standard exists for these except
// MOOD, which music-metadata maps to common.mood).
export const FEATURE_TAG_KEYS = {
  energy: 'ENERGY',
  loudness: 'LOUDNESS_LUFS',
  valence: 'VALENCE',
  danceability: 'DANCEABILITY',
  acousticness: 'ACOUSTICNESS',
  instrumental: 'INSTRUMENTALNESS',
  mood: 'MOOD',
} as const;

/** The perceptual-feature subset of AudioTags, parsed from file tags. */
export interface FeatureTags {
  energy?: number;
  loudness?: number;
  valence?: number;
  danceability?: number;
  acousticness?: number;
  instrumental?: number;
  mood?: string;
}

type NativeTagMap = Record<string, Array<{ id: string; value: unknown }>>;

type NumericFeatureField = Exclude<keyof FeatureTags, 'mood'>;

function numericFeatureEntries(): Array<[NumericFeatureField, string]> {
  return [
    ['energy', FEATURE_TAG_KEYS.energy],
    ['loudness', FEATURE_TAG_KEYS.loudness],
    ['valence', FEATURE_TAG_KEYS.valence],
    ['danceability', FEATURE_TAG_KEYS.danceability],
    ['acousticness', FEATURE_TAG_KEYS.acousticness],
    ['instrumental', FEATURE_TAG_KEYS.instrumental],
  ];
}

/** 0..1 scores get 3 decimals; loudness keeps 1 decimal (LUFS). */
function formatFeature(field: NumericFeatureField, value: number): string {
  return field === 'loudness' ? value.toFixed(1) : value.toFixed(3);
}

/** Parse a 0..1 score; rejects non-finite, clamps into range. */
function parseUnit(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseFloat(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, n));
}

/** Parse an integrated-LUFS value; sane range for music is ~[-70, 5]. */
function parseLufs(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number.parseFloat(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  if (n < -70 || n > 5) return undefined;
  return n;
}

function parseMood(v: unknown): string | undefined {
  const s = pickString(typeof v === 'string' ? v.toLowerCase() : undefined);
  return s && (MOOD_VOCAB as readonly string[]).includes(s) ? s : undefined;
}

/** Case-insensitive lookup of one key across every native tag format block. */
function readNativeValue(native: NativeTagMap | undefined, key: string): unknown {
  if (!native) return undefined;
  const wanted = key.toLowerCase();
  for (const frames of Object.values(native)) {
    if (!Array.isArray(frames)) continue;
    for (const frame of frames) {
      const id = frame?.id?.toLowerCase();
      // ID3 native frames surface TXXX as "TXXX:DESCRIPTION".
      if (id === wanted || id === `txxx:${wanted}`) return frame.value;
    }
  }
  return undefined;
}

/**
 * Parse the perceptual-feature tags from a music-metadata parse result.
 * Shared by readAudioTags and the library scanner so tagged files are dense
 * from the very first scan. Pure; tolerates missing/garbage values.
 */
export function featureTagsFromNative(
  native: NativeTagMap | undefined,
  commonMood?: string,
): FeatureTags {
  const out: FeatureTags = {
    energy: parseUnit(readNativeValue(native, FEATURE_TAG_KEYS.energy)),
    loudness: parseLufs(readNativeValue(native, FEATURE_TAG_KEYS.loudness)),
    valence: parseUnit(readNativeValue(native, FEATURE_TAG_KEYS.valence)),
    danceability: parseUnit(readNativeValue(native, FEATURE_TAG_KEYS.danceability)),
    acousticness: parseUnit(readNativeValue(native, FEATURE_TAG_KEYS.acousticness)),
    instrumental: parseUnit(readNativeValue(native, FEATURE_TAG_KEYS.instrumental)),
    mood: parseMood(commonMood) ?? parseMood(readNativeValue(native, FEATURE_TAG_KEYS.mood)),
  };
  return out;
}

// Rights/licence frames checked in priority order: the explicit LICENSE frame
// (Vorbis `LICENSE` / ID3 `TXXX:LICENSE`) first, then the copyright-URL (WCOP)
// and copyright-text (TCOP / Vorbis COPYRIGHT) frames.
const LICENCE_NATIVE_KEYS = ['LICENSE', 'WCOP', 'TCOP', 'COPYRIGHT'] as const;

/**
 * Resolve a canonical licence code from a file's native tag frames plus the
 * music-metadata `common.copyright` fold. Positive identifications only (null →
 * undefined when nothing recognisable) — see normalizeLicence. Shared by
 * readAudioTags and the library scanner so tagged files are licence-dense from
 * the first scan.
 */
export function licenceFromTags(
  native: NativeTagMap | undefined,
  commonCopyright?: string,
): string | undefined {
  for (const key of LICENCE_NATIVE_KEYS) {
    const code = normalizeLicence(pickString(readNativeValue(native, key) as string | undefined));
    if (code) return code;
  }
  return normalizeLicence(commonCopyright) ?? undefined;
}

function readUserText(raw: Record<string, unknown>, description: string): string | undefined {
  const list = raw.userDefinedText as NodeId3UserText[] | undefined;
  if (!Array.isArray(list)) return undefined;
  const hit = list.find((u) => u?.description?.toLowerCase() === description.toLowerCase());
  return hit ? pickString(hit.value) : undefined;
}

/** node-id3 returns USLT as `{ language, shortText, text }` (or an array of them). */
function readId3Lyrics(raw: Record<string, unknown>): string | undefined {
  const u = raw.unsynchronisedLyrics as { text?: string } | Array<{ text?: string }> | undefined;
  if (!u) return undefined;
  const first = Array.isArray(u) ? u[0] : u;
  return pickString(first?.text);
}

/** music-metadata returns `common.lyrics` as strings or `{ text }` objects. */
function readVorbisLyrics(
  lyrics: Array<string | { text?: string }> | string | undefined,
): string | undefined {
  if (!lyrics) return undefined;
  if (typeof lyrics === 'string') return pickString(lyrics);
  const first = lyrics[0];
  if (typeof first === 'string') return pickString(first);
  return pickString(first?.text);
}

let nodeId3Promise: Promise<NodeId3Api | null> | null = null;
let mmPromise: Promise<MusicMetadataApi | null> | null = null;

async function getNodeId3(): Promise<NodeId3Api | null> {
  if (!nodeId3Promise) {
    nodeId3Promise = import('node-id3')
      .then((mod) => (mod.default ?? mod) as unknown as NodeId3Api)
      .catch(() => null);
  }
  return nodeId3Promise;
}
async function getMusicMetadata(): Promise<MusicMetadataApi | null> {
  if (!mmPromise) {
    mmPromise = import('music-metadata')
      .then((mod) => mod as unknown as MusicMetadataApi)
      .catch(() => null);
  }
  return mmPromise;
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function parseTrackNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const m = raw.match(/^\d+/);
    if (m) {
      const n = Number(m[0]);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function parseYear(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const m = raw.match(/(19|20)\d{2}/);
    if (m) return Number(m[0]);
  }
  return undefined;
}

export async function readAudioTags(filepath: string): Promise<AudioTags> {
  const ext = extname(filepath).toLowerCase();
  if (ID3_EXTS.has(ext)) {
    const id3 = await getNodeId3();
    if (!id3) return {};
    try {
      const raw = id3.read(filepath);
      if (!raw || typeof raw !== 'object') return {};
      const d = raw as Record<string, unknown>;
      return {
        artist: pickString(d.artist),
        albumArtist: pickString(d.performerInfo) ?? pickString(d.band),
        album: pickString(d.album),
        title: pickString(d.title),
        trackNumber: parseTrackNumber(d.trackNumber),
        year: parseYear(d.year),
        key: pickString(d.initialKey),
        compilation: d.TCMP === '1' || d.compilation === '1',
        lyrics: readId3Lyrics(d),
        energy: parseUnit(readUserText(d, FEATURE_TAG_KEYS.energy)),
        loudness: parseLufs(readUserText(d, FEATURE_TAG_KEYS.loudness)),
        valence: parseUnit(readUserText(d, FEATURE_TAG_KEYS.valence)),
        danceability: parseUnit(readUserText(d, FEATURE_TAG_KEYS.danceability)),
        acousticness: parseUnit(readUserText(d, FEATURE_TAG_KEYS.acousticness)),
        instrumental: parseUnit(readUserText(d, FEATURE_TAG_KEYS.instrumental)),
        mood: parseMood(readUserText(d, FEATURE_TAG_KEYS.mood)),
        licence:
          normalizeLicence(
            readUserText(d, 'LICENSE') ?? pickString(d.copyright) ?? pickString(d.copyrightUrl),
          ) ?? undefined,
        acoustIdId: readUserText(d, TXXX_ACOUSTID),
        mbRecordingId: readUserText(d, TXXX_MB_RECORDING),
        mbReleaseId: readUserText(d, TXXX_MB_RELEASE),
      };
    } catch {
      return {};
    }
  }
  if (VORBIS_EXTS.has(ext) || ext === '.m4a') {
    const mm = await getMusicMetadata();
    if (!mm) return {};
    try {
      const parsed = await mm.parseFile(filepath, { duration: false });
      const c = parsed.common;
      return {
        artist: pickString(c.artist),
        albumArtist: pickString(c.albumartist),
        album: pickString(c.album),
        title: pickString(c.title),
        trackNumber: c.track?.no ?? undefined,
        year: c.year,
        key: pickString(c.key),
        lyrics: readVorbisLyrics(c.lyrics),
        ...featureTagsFromNative(parsed.native, c.mood),
        licence: licenceFromTags(parsed.native, pickString(c.copyright)),
        acoustIdId: pickString(c.acoustid_id),
        mbRecordingId: pickString(c.musicbrainz_recordingid),
        mbReleaseId: pickString(c.musicbrainz_albumid),
      };
    } catch {
      return {};
    }
  }
  return {};
}

export async function writeAudioTags(filepath: string, tags: AudioTags): Promise<boolean> {
  const ext = extname(filepath).toLowerCase();
  if (ID3_EXTS.has(ext)) return writeId3Tags(filepath, tags);
  if (VORBIS_EXTS.has(ext) || ext === '.m4a') return writeFfmpegTags(filepath, tags);
  return false;
}

async function writeId3Tags(filepath: string, tags: AudioTags): Promise<boolean> {
  const id3 = await getNodeId3();
  if (!id3) return false;
  const update: Record<string, unknown> = {};
  if (tags.album !== undefined) update.album = tags.album;
  if (tags.albumArtist !== undefined) update.performerInfo = tags.albumArtist;
  if (tags.artist !== undefined) update.artist = tags.artist;
  if (tags.title !== undefined) update.title = tags.title;
  if (tags.trackNumber !== undefined) update.trackNumber = String(tags.trackNumber);
  if (tags.year !== undefined) update.year = String(tags.year);
  if (tags.genre !== undefined) update.genre = tags.genre;
  if (tags.bpm !== undefined) update.bpm = String(tags.bpm);
  if (tags.key !== undefined) update.initialKey = tags.key;
  if (tags.lyrics !== undefined)
    update.unsynchronisedLyrics = { language: 'eng', text: tags.lyrics };
  if (tags.compilation) update.TCMP = '1';

  const userText: NodeId3UserText[] = [];
  for (const [field, key] of numericFeatureEntries()) {
    const v = tags[field];
    if (v !== undefined) userText.push({ description: key, value: formatFeature(field, v) });
  }
  if (tags.mood !== undefined) userText.push({ description: FEATURE_TAG_KEYS.mood, value: tags.mood });
  // Written to a LICENSE TXXX frame only — never the native copyright frame, so
  // an existing "© …" notice on the file is preserved.
  if (tags.licence !== undefined) userText.push({ description: 'LICENSE', value: tags.licence });
  if (tags.acoustIdId) userText.push({ description: TXXX_ACOUSTID, value: tags.acoustIdId });
  if (tags.mbRecordingId)
    userText.push({ description: TXXX_MB_RECORDING, value: tags.mbRecordingId });
  if (tags.mbReleaseId) userText.push({ description: TXXX_MB_RELEASE, value: tags.mbReleaseId });
  if (userText.length > 0) update.userDefinedText = userText;

  if (Object.keys(update).length === 0) return true;
  try {
    return id3.update(update, filepath);
  } catch (err) {
    log.warn({ err, filepath }, 'ID3 update failed');
    return false;
  }
}

// ffmpeg muxer per extension. The tmp output ends in `.nicotind.tmp`, so the
// muxer CANNOT be inferred from the filename — without an explicit `-f`,
// EVERY Vorbis-family tag write fails ("Unable to choose an output format").
const FFMPEG_MUXERS: Record<string, string> = {
  '.flac': 'flac',
  '.ogg': 'ogg',
  '.opus': 'opus',
  '.m4a': 'ipod',
};

function writeFfmpegTags(filepath: string, tags: AudioTags): Promise<boolean> {
  const tmpPath = filepath + '.nicotind.tmp';
  const muxer = FFMPEG_MUXERS[extname(filepath).toLowerCase()];
  if (!muxer) return Promise.resolve(false);
  const metaArgs: string[] = [];
  if (tags.album !== undefined) metaArgs.push('-metadata', `ALBUM=${tags.album}`);
  if (tags.albumArtist !== undefined) metaArgs.push('-metadata', `ALBUMARTIST=${tags.albumArtist}`);
  if (tags.artist !== undefined) metaArgs.push('-metadata', `ARTIST=${tags.artist}`);
  if (tags.title !== undefined) metaArgs.push('-metadata', `TITLE=${tags.title}`);
  if (tags.trackNumber !== undefined) metaArgs.push('-metadata', `TRACK=${tags.trackNumber}`);
  if (tags.year !== undefined) metaArgs.push('-metadata', `DATE=${tags.year}`);
  if (tags.genre !== undefined) metaArgs.push('-metadata', `GENRE=${tags.genre}`);
  if (tags.bpm !== undefined) metaArgs.push('-metadata', `BPM=${tags.bpm}`);
  if (tags.key !== undefined) metaArgs.push('-metadata', `KEY=${tags.key}`);
  if (tags.lyrics !== undefined) metaArgs.push('-metadata', `LYRICS=${tags.lyrics}`);
  for (const [field, key] of numericFeatureEntries()) {
    const v = tags[field];
    if (v !== undefined) metaArgs.push('-metadata', `${key}=${formatFeature(field, v)}`);
  }
  if (tags.mood !== undefined)
    metaArgs.push('-metadata', `${FEATURE_TAG_KEYS.mood}=${tags.mood}`);
  if (tags.licence !== undefined) metaArgs.push('-metadata', `LICENSE=${tags.licence}`);
  if (tags.compilation) metaArgs.push('-metadata', 'COMPILATION=1');
  if (tags.acoustIdId) metaArgs.push('-metadata', `ACOUSTID_ID=${tags.acoustIdId}`);
  if (tags.mbRecordingId) metaArgs.push('-metadata', `MUSICBRAINZ_TRACKID=${tags.mbRecordingId}`);
  if (tags.mbReleaseId) metaArgs.push('-metadata', `MUSICBRAINZ_ALBUMID=${tags.mbReleaseId}`);
  if (metaArgs.length === 0) return Promise.resolve(true);

  const args = [
    '-y',
    '-i',
    filepath,
    '-map_metadata',
    '0',
    ...metaArgs,
    '-c',
    'copy',
    '-f',
    muxer,
    tmpPath,
  ];
  return new Promise<boolean>((resolve) => {
    const proc = spawn(ffmpegBinary(), args, { stdio: 'ignore' });
    proc.on('error', () => {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      resolve(false);
    });
    proc.on('close', (code) => {
      if (code === 0) {
        try {
          renameSync(tmpPath, filepath);
          resolve(true);
        } catch {
          try {
            unlinkSync(tmpPath);
          } catch {
            /* ignore */
          }
          resolve(false);
        }
      } else {
        try {
          unlinkSync(tmpPath);
        } catch {
          /* ignore */
        }
        resolve(false);
      }
    });
  });
}

export function isUnknownLike(value: string | undefined): boolean {
  if (!value) return true;
  const n = value
    .toLowerCase()
    .replace(/[\[\](){}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (
    n === '' ||
    n === 'unknown' ||
    n === 'unknown artist' ||
    n === 'unknown album' ||
    n === 'unknown title' ||
    n === 'various' ||
    n === 'various artists'
  );
}

export function normalizeTagValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const lower = trimmed.toLowerCase();
  if (
    lower === 'unknown' ||
    lower === 'unknown artist' ||
    lower === 'unknown album' ||
    lower === 'unknown title'
  )
    return undefined;
  return trimmed;
}
