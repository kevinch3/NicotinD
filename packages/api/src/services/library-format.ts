import { FORMAT_ARGS } from './transcode.js';
import { bitrateFor as ladderBitrateFor } from './transcode-bitrate.js';
import { attachPictureToOpus, MAX_EMBEDDED_PICTURE_BYTES } from './opus-artwork.js';
import { attachPictureAsStream } from './attached-picture.js';
import { writeOutputGain } from './opus-gain.js';

/**
 * What the library standardizes **on disk**, and why this is not the same table
 * as the streaming one.
 *
 * `FORMAT_ARGS` (`./transcode.ts`) answers "how do I encode bytes for this
 * request". Those bytes are ephemeral: nothing tags them, nothing scans them,
 * and a wrong one costs a cache miss. This table answers "what may the library
 * be made of", where the bytes are permanent, tagged, re-scanned, and replace a
 * file that is then deleted.
 *
 * The two tables genuinely disagree, which is why they stay separate rather
 * than one being derived from the other. `FORMAT_ARGS.aac` emits `-f adts` with
 * extension `.aac`: correct for a stream, unusable for the library. `.aac` is
 * in `AUDIO_EXTENSIONS`, so the scanner would index it, but it is in neither
 * `ID3_EXTS` nor `VORBIS_EXTS` and `writeAudioTags` returns `false` for it — a
 * `.aac` library would be scanned and permanently untaggable. Library AAC has
 * to be `.m4a` through the `ipod` muxer, a different muxer for the same codec.
 *
 * Where they *do* agree, the args come from `FORMAT_ARGS` rather than being
 * written out again — the duplicate this module exists to delete.
 */
export type LibraryFormat = 'opus' | 'mp3';

export interface FormatStrategy {
  id: LibraryFormat;
  /** Output extension, no dot. Drives the dest path, the temp name and the "already the target" test. */
  ext: string;
  /** ffmpeg output args for a target rate. */
  encodeArgs(kbps: number): string[];
  /** Target rate for a source, given its own bitrate and whether it is lossless. */
  bitrateFor(sourceKbps: number | null | undefined, lossless: boolean): number;
  /**
   * Largest cover this container's readers can take back, or `null` where no
   * ceiling has been measured. Not a property of the format — a property of
   * `music-metadata` reading it; see `opus-artwork.ts`.
   */
  maxEmbeddedPictureBytes: number | null;
  /** Attach a prepared cover to an encoded file. Never throws; `false` means "declined". */
  embedArt(path: string, coverPath: string): boolean;
  /**
   * Apply a loudness offset without re-encoding, or `null` when the container
   * has no in-header gain field.
   *
   * Nullable **in the type** on purpose. Opus carries `output_gain` in
   * `OpusHead` (RFC 7845 §5.1), so normalization is six bytes and reversible.
   * mp3 and AAC have no equivalent: they can only bake the gain into the audio
   * or write an advisory ReplayGain tag no player is obliged to honour. That is
   * a real capability gap, and a `null` here makes every call site handle it at
   * compile time instead of a user discovering that normalization silently did
   * nothing.
   */
  writeGain: ((path: string, gainDb: number) => boolean) | null;
}

/**
 * The formats the library may be standardized on.
 *
 * Total by construction — `Record<LibraryFormat, …>`, so a format joins the
 * union and the table together or not at all. mp3 and AAC join in #1256's step
 * 4, each bringing its own ladder, art mechanism and (absent) gain support;
 * AAC additionally needs #1177, since the `ipod` muxer drops `-metadata BPM=`
 * and an `.m4a` library would re-analyse BPM forever.
 */
export const LIBRARY_FORMATS: Record<LibraryFormat, FormatStrategy> = {
  opus: {
    id: 'opus',
    ext: 'opus',
    encodeArgs: (kbps) => FORMAT_ARGS.opus.args(kbps),
    bitrateFor: (sourceKbps, lossless) => ladderBitrateFor('opus', sourceKbps, lossless),
    maxEmbeddedPictureBytes: MAX_EMBEDDED_PICTURE_BYTES,
    embedArt: attachPictureToOpus,
    writeGain: writeOutputGain,
  },
  mp3: {
    id: 'mp3',
    ext: 'mp3',
    encodeArgs: (kbps) => FORMAT_ARGS.mp3.args(kbps),
    bitrateFor: (sourceKbps, lossless) => ladderBitrateFor('mp3', sourceKbps, lossless),
    // No ceiling we could measure: a 6.5 MB cover reads back byte-exact, ten
    // times the point where Ogg throws. The 512 KB cap is a property of
    // `music-metadata` reading Ogg, not of cover art — see `attached-picture.ts`.
    maxEmbeddedPictureBytes: null,
    embedArt: attachPictureAsStream,
    // mp3 has no in-header gain field. ReplayGain is an advisory tag no player
    // is obliged to honour, and baking the gain into the audio is the thing
    // `loudness_measured` exists to make safe but which still re-encodes. So
    // this format declares the capability absent and every call site is made to
    // handle it by the type.
    writeGain: null,
  },
};

/** What the library standardizes on today. The only caller-visible default. */
export const DEFAULT_LIBRARY_FORMAT: LibraryFormat = 'opus';

/**
 * Resolve a strategy, falling back to the default for an unknown id.
 *
 * Unknown rather than throwing because the id will eventually come from an
 * operator setting read out of `app_settings`, where a hand-edited or
 * downgraded value must not take the conversion pass down.
 */
export function libraryFormat(id?: string | null): FormatStrategy {
  const known = (id ?? '') as LibraryFormat;
  return LIBRARY_FORMATS[known] ?? LIBRARY_FORMATS[DEFAULT_LIBRARY_FORMAT];
}

/**
 * Marker shared by every in-progress encode's filename, whatever the target.
 *
 * The sweep matches on **this**, not on a format-specific suffix, so temps left
 * by a previous target are still cleaned up after the target changes. Matching
 * only the current format's suffix would strand them forever.
 */
export const TRANSCODE_TEMP_MARKER = '.nicotind-transcode.';
