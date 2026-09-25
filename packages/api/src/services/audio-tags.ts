import { spawn } from 'node:child_process';
import { extname } from 'node:path';
import { readFileSync, renameSync, unlinkSync } from 'node:fs';
import { ID3_EXTS, VORBIS_EXTS, createLogger, MOOD_VOCAB, type MoodLabel } from '@nicotind/core';
import { ffmpegBinary } from './ffmpeg-path.js';
import { withFfmpegSlot } from './ffmpeg-slots.js';
import { planVorbisKeyFixes, type VorbisKeyPlan, type VorbisKeyPreference } from './vorbis-keys.js';
import { attachPictureDataToOpus, readOggPicture } from './opus-artwork.js';
import {
  intAtom,
  readFreeformAtoms,
  readStandardAtoms,
  textAtom,
  tmpoAtom,
  writeFreeformAtoms,
} from './mp4-freeform.js';
import { getMusicMetadata as loadMusicMetadata } from './music-metadata-loader.js';

const log = createLogger('audio-tags');

// #845: "is this library content?" is answered once, in core. This module used
// to own a narrower set (no .wma/.webm) that library-disk-audit walked disk
// with, so every .wma row reported as missing_file.
export { ID3_EXTS, VORBIS_EXTS };

export interface AudioTags {
  artist?: string;
  albumArtist?: string;
  album?: string;
  title?: string;
  trackNumber?: number;
  /** Disc number (ID3 TPOS / Vorbis `DISCNUMBER`). Added with `track` for #959. */
  discNumber?: number;
  year?: number;
  genre?: string;
  /**
   * Composer (ID3 TCOM / Vorbis `COMPOSER` / MP4 `©wrt`) and conductor (ID3
   * TPE3 / Vorbis `CONDUCTOR` / an MP4 freeform atom). Without them classical
   * files filed the composer in `artist`, and correcting that deleted it (#1083).
   */
  composer?: string;
  conductor?: string;
  /**
   * Work, movement name and movement number (#1369) — Vorbis `WORK` /
   * `MOVEMENTNAME` / `MOVEMENT`, ID3 `TXXX` under the same names (node-id3
   * cannot write the iTunes `MVNM`/`MVIN` frames; they are still read), MP4
   * `©wrk` / `©mvn` / `©mvi`. Without them a movement is crammed into the title.
   */
  work?: string;
  movement?: string;
  movementNumber?: number;
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
   * Supported on every container this app writes, including mp3 (#1256).
   *
   * It was Vorbis/m4a only until then, on the strength of #917's finding that
   * node-id3 0.2.9 has no `TCMP` frame. True of its typed API, false of its
   * behaviour: it passes an unrecognised four-character frame id straight
   * through, so `{ TCMP: '1' }` writes a real frame. The **read** is the half
   * that genuinely does not work — node-id3 cannot see TCMP at all, not even
   * under `raw` — so the ID3 path reads this one field through music-metadata.
   *
   * Both halves matter together, which is #916's lesson: a write with no
   * matching read is not idempotent, it is a loop. The organizer re-tags any
   * file whose `compilation` reads false against a compilation folder.
   */
  compilation?: boolean;
  /** AcoustID track UUID. Doubles as a "we've already fingerprinted this" marker. */
  acoustIdId?: string;
  /** MusicBrainz recording ID. */
  mbRecordingId?: string;
  /** MusicBrainz release (album) ID. */
  mbReleaseId?: string;
}

type NodeId3UserText = { description: string; value: string };
export type NodeId3Api = {
  read: (filepath: string) => Record<string, unknown> | false | undefined;
  update: (tags: Record<string, unknown>, filepath: string) => boolean;
};
type MusicMetadataApi = {
  parseFile: (
    path: string,
    // `skipCovers` matters as much as `duration` for the narrow reads: a cover
    // is the largest thing in a tag header, and the compilation lookup wants
    // one boolean from it.
    opts?: { duration?: boolean; skipCovers?: boolean },
  ) => Promise<{
    common: {
      artist?: string;
      albumartist?: string;
      album?: string;
      title?: string;
      track?: { no?: number | null };
      /** Disc position, the same `{ no, of }` shape as `track` (#1151). */
      disk?: { no?: number | null };
      year?: number;
      bpm?: number;
      key?: string;
      mood?: string;
      /** One entry per genre tag frame — an ARRAY, not a string (issue #791). */
      genre?: string[];
      composer?: string[];
      conductor?: string[];
      work?: string;
      movement?: string;
      movementIndex?: { no?: number | null };
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

// Picard's MP4 name for the musical key. music-metadata maps no MP4 atom to
// `common.key` at all, so it is read back from the native frame (#1274).
const MP4_KEY_ATOM = 'initialkey';
const MP4_FREEFORM_PREFIX = '----:com.apple.itunes:';

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
      // ID3 native frames surface TXXX as "TXXX:DESCRIPTION"; MP4 freeform
      // atoms as "----:com.apple.iTunes:NAME" (#1274).
      if (id === wanted || id === `txxx:${wanted}` || id === `${MP4_FREEFORM_PREFIX}${wanted}`)
        return frame.value;
    }
  }
  return undefined;
}

/**
 * Work and movement from a music-metadata parse (#1369). music-metadata maps
 * Vorbis `WORK` and the MP4/iTunes atoms, but not Vorbis `MOVEMENTNAME` /
 * `MOVEMENT` or the ID3 `TXXX` spellings this app writes — so each falls back
 * to the native map, the same way `keyFromParse` does. Shared by
 * `readAudioTags` and the scanner so both read one answer.
 */
export function workTagsFromParse(
  common: { work?: string; movement?: string; movementIndex?: { no?: number | null } } | undefined,
  native: NativeTagMap | undefined,
): Pick<AudioTags, 'work' | 'movement' | 'movementNumber'> {
  return {
    work: pickString(common?.work) ?? pickString(readNativeValue(native, 'WORK')),
    movement: pickString(common?.movement) ?? pickString(readNativeValue(native, 'MOVEMENTNAME')),
    movementNumber:
      (common?.movementIndex?.no ?? undefined) ||
      parseLeadingNumber(readNativeValue(native, 'MOVEMENT')),
  };
}

/**
 * The musical key from a music-metadata parse. music-metadata maps no MP4 atom
 * to `common.key`, so an `.m4a` key lives only in its native `initialkey`
 * freeform atom — shared by `readAudioTags` and the scanner so both see it (#1274).
 */
export function keyFromParse(
  commonKey: string | undefined,
  native: NativeTagMap | undefined,
): string | undefined {
  return pickString(commonKey) ?? pickString(readNativeValue(native, MP4_KEY_ATOM));
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

/**
 * MusicBrainz puts the **recording id** in a `UFID` frame owned by
 * `http://musicbrainz.org`, not in a `TXXX`. That is the standard, and it is
 * what real taggers write — measured on the library, 20% of files carry it
 * there and none carry a `TXXX:MusicBrainz Track Id`.
 *
 * Reading only the `TXXX` meant `mbRecordingId` was always `undefined` for
 * those files, so the Opus conversion had nothing to carry and the id was
 * dropped. ffmpeg does not map `UFID` into a Vorbis comment either, so the
 * value simply disappeared.
 *
 * The identifier is raw bytes, not a string: node-id3 hands back a Buffer-like
 * object, so it is decoded as ASCII and sanity-checked as a UUID before use.
 */
const MB_UFID_OWNER = 'http://musicbrainz.org';

export function readMusicBrainzUfid(raw: Record<string, unknown>): string | undefined {
  const frames = raw.uniqueFileIdentifier ?? raw.UFID;
  const list = Array.isArray(frames) ? frames : frames ? [frames] : [];
  for (const f of list as Array<Record<string, unknown>>) {
    const owner = pickString(f?.ownerIdentifier ?? f?.owner_identifier);
    if (owner !== MB_UFID_OWNER) continue;
    const id = f?.identifier;
    const text =
      typeof id === 'string'
        ? id
        : id != null
          ? Buffer.from(Object.values(id as Record<string, number>)).toString('ascii')
          : '';
    // A recording id is a UUID. Anything else is a different owner's payload
    // that happens to share the namespace, and guessing would be worse.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text.trim())) {
      return text.trim();
    }
  }
  return undefined;
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

/** The one lazy `node-id3` loader; `null` when the optional dependency is absent. */
export async function getNodeId3(): Promise<NodeId3Api | null> {
  if (!nodeId3Promise) {
    nodeId3Promise = import('node-id3')
      .then((mod) => (mod.default ?? mod) as unknown as NodeId3Api)
      .catch(() => null);
  }
  return nodeId3Promise;
}
/** The shared loader, typed for the wider `common` this module reads. */
async function getMusicMetadata(): Promise<MusicMetadataApi | null> {
  return (await loadMusicMetadata()) as unknown as MusicMetadataApi | null;
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** A music-metadata credit array (`composer`, `conductor`) as the one string the writers emit. */
function pickJoined(v: unknown): string | undefined {
  if (!Array.isArray(v)) return pickString(v);
  return pickString(v.filter((x) => typeof x === 'string' && x.trim()).join('; '));
}

/**
 * music-metadata returns `common.genre` as an ARRAY — one entry per tag frame,
 * which is the multi-genre shape `splitGenres` parses (docs/genre-model.md).
 * `AudioTags.genre` is the single-string form both writers emit, so join on the
 * same `; ` separator the write paths use rather than dropping the extras.
 */
function pickGenre(raw: unknown): string | undefined {
  if (Array.isArray(raw)) {
    const parts = raw.map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
    return parts.length > 0 ? parts.join('; ') : undefined;
  }
  return pickString(raw);
}

/**
 * The leading integer of a node-id3 numeric frame. Every one of them arrives as
 * a string, and TRCK/TPOS carry a `position/total` pair at least as often as a
 * bare number.
 */
function parseLeadingNumber(raw: unknown): number | undefined {
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

/**
 * The compilation flag on an mp3, read through music-metadata rather than
 * node-id3.
 *
 * node-id3 **writes** `TCMP` — it passes an unrecognised four-character frame
 * id straight through — but cannot **read** it back: not as a top-level key and
 * not under its `raw` map. Measured, not assumed: after
 * `id3.update({ TCMP: '1' })` the frame is in the file and
 * `music-metadata` reports `common.compilation === true`, while
 * `id3.read()` returns only `encodingTechnology, title, raw`.
 *
 * Write-side-works, read-side-blind is the #1151 asymmetry over again, and it
 * is not cosmetic: the organizer re-tags any file whose `compilation` reads
 * false against a compilation folder (`library-organizer.ts`), so a flag that
 * can never be read puts every track of every compilation album into a
 * permanent rewrite loop. That is what kept mp3 from being a valid library
 * target (#1256, #917).
 *
 * Deliberately a **second, narrow parse** rather than moving the whole ID3 read
 * onto music-metadata: `readAudioTags` is called per file by the organizer and
 * the scanner, and swapping the reader wholesale would re-litigate every field
 * mapping above. `duration: false` + `skipCovers: true` keeps this to the tag
 * header — the expensive parts of a parse are exactly the two things it skips.
 *
 * Returns `false` on any failure: an unreadable flag must read as "not a
 * compilation", never throw a tag read that otherwise succeeded.
 */
async function readId3Compilation(filepath: string): Promise<boolean> {
  try {
    const mm = await getMusicMetadata();
    if (!mm) return false;
    const meta = await mm.parseFile(filepath, { duration: false, skipCovers: true });
    return (meta.common as Record<string, unknown>).compilation === true;
  } catch {
    return false;
  }
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
        compilation: (await readId3Compilation(filepath)) || undefined,
        artist: pickString(d.artist),
        albumArtist: pickString(d.performerInfo) ?? pickString(d.band),
        album: pickString(d.album),
        title: pickString(d.title),
        composer: pickString(d.composer),
        conductor: pickString(d.conductor),
        work: readUserText(d, 'WORK'),
        movement: readUserText(d, 'MOVEMENTNAME'),
        movementNumber: parseLeadingNumber(readUserText(d, 'MOVEMENT')),
        trackNumber: parseLeadingNumber(d.trackNumber),
        discNumber: parseLeadingNumber(d.partOfSet),
        bpm: parseLeadingNumber(d.bpm),
        // TYER first, then v2.4's TDRC. node-id3's `update` downgrades the
        // header to v2.3 and writes TYER while leaving any existing TDRC in
        // place, so a retagged file carries both and TDRC is the stale one.
        year: parseYear(d.year) ?? parseYear(d.recordingTime),
        key: pickString(d.initialKey),
        genre: pickString(d.genre),
        lyrics: readId3Lyrics(d),
        energy: parseUnit(readUserText(d, FEATURE_TAG_KEYS.energy)),
        loudness: parseLufs(readUserText(d, FEATURE_TAG_KEYS.loudness)),
        valence: parseUnit(readUserText(d, FEATURE_TAG_KEYS.valence)),
        danceability: parseUnit(readUserText(d, FEATURE_TAG_KEYS.danceability)),
        acousticness: parseUnit(readUserText(d, FEATURE_TAG_KEYS.acousticness)),
        instrumental: parseUnit(readUserText(d, FEATURE_TAG_KEYS.instrumental)),
        mood: parseMood(readUserText(d, FEATURE_TAG_KEYS.mood)),
        acoustIdId: readUserText(d, TXXX_ACOUSTID),
        // TXXX first because our own writer uses it, then the UFID the
        // MusicBrainz standard actually specifies.
        mbRecordingId: readUserText(d, TXXX_MB_RECORDING) ?? readMusicBrainzUfid(d),
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
      // `AudioTags` has no picture field, so decoding a multi-MB cover here was
      // pure waste — on every AAC conversion, which reads its source here (#1288).
      const parsed = await mm.parseFile(filepath, { duration: false, skipCovers: true });
      const c = parsed.common;
      return {
        artist: pickString(c.artist),
        albumArtist: pickString(c.albumartist),
        album: pickString(c.album),
        title: pickString(c.title),
        composer: pickJoined(c.composer),
        conductor: pickJoined(c.conductor),
        ...workTagsFromParse(c, parsed.native),
        trackNumber: c.track?.no ?? undefined,
        // `writeFfmpegTags` emits DISC and BPM here too, so leaving these
        // unmapped made them write-only on flac/m4a for the same reason (#1151).
        discNumber: c.disk?.no ?? undefined,
        // Vorbis comments are free text, so a BPM can arrive as "128" or "128.5"
        // even where music-metadata's own types promise a number.
        bpm: parseLeadingNumber(c.bpm),
        year: c.year,
        key: keyFromParse(c.key, parsed.native),
        genre: pickGenre(c.genre),
        // Without this the organizer's `!currentRaw.compilation` guard is
        // permanently true and it re-remuxes every compilation file on every
        // pass. `compilation-tagger.ts` already reads it exactly this way.
        compilation: (c as Record<string, unknown>).compilation === true,
        lyrics: readVorbisLyrics(c.lyrics),
        ...featureTagsFromNative(parsed.native, c.mood),
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

export interface WriteAudioTagsDeps {
  /** Injectable for tests; defaults to the real reader. This is the ID3
   *  read-back that decides whether the in-place write actually stuck. */
  readTags?: typeof readAudioTags;
  /** A curator's decision for disagreeing spaced/canonical Vorbis pairs (#1283). */
  vorbisKeyPrefer?: ReadonlyMap<string, VorbisKeyPreference>;
}

/**
 * The fields `readAudioTags` maps on an ID3 file, so a read-back can tell a
 * landed write from a lost one. Deliberately not the whole of `AudioTags`: the
 * perceptual features go through `toFixed`, so a faithful write reads back
 * rounded, and comparing them would report a good write as lost and rewrite the
 * container for nothing.
 *
 * `compilation` is also absent, now for a different reason than #917 gave. It
 * writes correctly (a real TCMP frame), but the ffmpeg container rewrite this
 * list triggers would **destroy** it — the mp3 muxer will not emit TCMP from
 * `-metadata`. Listing it here would turn a landed write into a lost one on
 * every repair pass.
 *
 * `bpm`/`discNumber` became readable in #1151 and round-trip exactly, but they
 * stay out: this list decides whether to REWRITE THE CONTAINER, and neither is
 * a field a curator corrects. Widening the rewrite trigger is a cost paid on
 * every write, for a divergence nothing reads.
 */
const ID3_VERIFIABLE_FIELDS = [
  'title',
  'artist',
  'albumArtist',
  'album',
  'composer',
  'conductor',
  'work',
  'movement',
  'movementNumber',
  'genre',
  'key',
  'lyrics',
  'year',
  'trackNumber',
  'acoustIdId',
  'mbRecordingId',
  'mbReleaseId',
] as const satisfies readonly (keyof AudioTags)[];

export async function writeAudioTags(
  filepath: string,
  tags: AudioTags,
  deps: WriteAudioTagsDeps = {},
): Promise<boolean> {
  const ext = extname(filepath).toLowerCase();
  if (ID3_EXTS.has(ext)) {
    if (!(await writeId3Tags(filepath, tags))) return false;
    if (!FFMPEG_MUXERS[ext]) return true;
    // node-id3 reports success on an in-place merge it did not land (#964), so
    // the write is believed only where the file reads it back. The container
    // rewrite is the repair, and `-map_metadata 0` carries every frame the
    // analysis writers own across it. See docs/library-processing.md.
    const onDisk = await (deps.readTags ?? readAudioTags)(filepath);
    const stale = ID3_VERIFIABLE_FIELDS.filter(
      (f) => tags[f] !== undefined && onDisk[f] !== tags[f],
    );
    if (stale.length === 0) return true;
    log.warn({ filepath, stale }, 'ID3 write did not stick in place; rewriting the container');
    // Two frames the container rewrite destroys, restored through node-id3
    // afterwards. ffmpeg re-emits an inherited USLT as a TXXX no reader here
    // maps back to `lyrics`; and its mp3 muxer will not write `TCMP` at all, so
    // a compilation flag that was correctly on disk comes back off. Both are
    // read from the file first, so a rewrite triggered by some *other* field
    // does not quietly strip them (#1256).
    const before = await readAudioTags(filepath);
    const lyrics = tags.lyrics ?? before.lyrics;
    const compilation = tags.compilation ?? before.compilation;
    if (!(await writeFfmpegTags(filepath, tags))) return false;
    const restore: AudioTags = {};
    if (lyrics !== undefined) restore.lyrics = lyrics;
    if (compilation) restore.compilation = true;
    if (Object.keys(restore).length > 0) await writeId3Tags(filepath, restore);
    return true;
  }
  if (VORBIS_EXTS.has(ext) || ext === '.m4a')
    return writeFfmpegTags(filepath, tags, deps.vorbisKeyPrefer);
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
  if (tags.composer !== undefined) update.composer = tags.composer;
  if (tags.conductor !== undefined) update.conductor = tags.conductor;
  if (tags.trackNumber !== undefined) update.trackNumber = String(tags.trackNumber);
  if (tags.discNumber !== undefined) update.partOfSet = String(tags.discNumber);
  if (tags.year !== undefined) update.year = String(tags.year);
  if (tags.genre !== undefined) update.genre = tags.genre;
  if (tags.bpm !== undefined) update.bpm = String(tags.bpm);
  if (tags.key !== undefined) update.initialKey = tags.key;
  if (tags.lyrics !== undefined)
    update.unsynchronisedLyrics = { language: 'eng', text: tags.lyrics };
  // `TCMP` is the iTunes compilation flag. node-id3 0.2.9 has no typed field
  // for it — which is what #917 recorded and why this went unwritten — but it
  // passes an unrecognised **four-character frame id** straight through to the
  // file. Measured: `{ TCMP: '1' }` produces a real TCMP frame that
  // music-metadata reads back as `common.compilation === true`. Its documented
  // `raw: { TCMP }` escape hatch does NOT work, and a `TXXX:COMPILATION` is not
  // read by anything.
  //
  // Not cosmetic, and not only about display: the organizer re-tags any file
  // whose `compilation` reads false against a compilation folder
  // (`library-organizer.ts`), so a container that cannot hold the flag puts
  // every track of every compilation album into a permanent rewrite loop. That
  // is what blocked mp3 from being a valid library target (#1256).
  if (tags.compilation) update.TCMP = '1';

  const userText: NodeId3UserText[] = [];
  for (const [field, key] of numericFeatureEntries()) {
    const v = tags[field];
    if (v !== undefined) userText.push({ description: key, value: formatFeature(field, v) });
  }
  if (tags.mood !== undefined)
    userText.push({ description: FEATURE_TAG_KEYS.mood, value: tags.mood });
  if (tags.work !== undefined) userText.push({ description: 'WORK', value: tags.work });
  if (tags.movement !== undefined)
    userText.push({ description: 'MOVEMENTNAME', value: tags.movement });
  if (tags.movementNumber !== undefined)
    userText.push({ description: 'MOVEMENT', value: String(tags.movementNumber) });
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
  // Only reached as the ID3 fallback above — .mp3 is written in place by
  // node-id3 whenever that works.
  '.mp3': 'mp3',
};

// ffmpeg defaults the mp3 muxer to ID3v2.4, which carries a year as TDRC —
// node-id3 surfaces that frame as `recordingTime`, so `readAudioTags` reads no
// year at all and the rewrite's own write would look lost. v2.3 is what
// node-id3 writes, and both readers agree on it.
const FFMPEG_MUXER_ARGS: Record<string, string[]> = {
  '.mp3': ['-id3v2_version', '3'],
};

/**
 * BPM's `-metadata` key, where the container disagrees with the default.
 *
 * ffmpeg's mov/ipod muxer does not recognise `BPM` and **silently drops it** —
 * no warning, exit 0, and an `.m4a` that ends with no tempo atom at all. The
 * key it maps to the iTunes `tmpo` atom is `tmpo`. Probed across all four
 * plausible spellings against a real `.m4a`, reading back with music-metadata
 * (#1177):
 *
 * | `-metadata` key | `common.bpm` |
 * | --- | --- |
 * | `BPM` | `undefined` |
 * | `tmpo` | **128** |
 * | `TBPM` | `undefined` |
 * | `tempo` | `undefined` |
 *
 * Not cosmetic: `POST /api/library/songs/:id/bpm` and `analyze-bpm.ts` both
 * prefer a file's own BPM tag over a DSP run, so a container that can never
 * hold one is re-analysed forever. A per-container override rather than a
 * global rename, because `BPM` is what the Vorbis family reads.
 */
const BPM_METADATA_KEY: Record<string, string> = {
  '.m4a': 'tmpo',
};

/**
 * What a rewrite of this Ogg/FLAC file would change to put its spaced comment
 * names under their canonical ones (#1250, #1231). `null` for other containers
 * or an unreadable file. `written` is the set of uppercased `-metadata` keys the
 * same write sets explicitly — see `planVorbisKeyFixes`.
 */
export async function planVorbisKeyHeal(
  filepath: string,
  written?: ReadonlySet<string>,
  prefer?: ReadonlyMap<string, VorbisKeyPreference>,
): Promise<VorbisKeyPlan | null> {
  if (!VORBIS_EXTS.has(extname(filepath).toLowerCase())) return null;
  const mm = await getMusicMetadata();
  if (!mm) return null;
  try {
    const parsed = await mm.parseFile(filepath, { duration: false, skipCovers: true });
    return planVorbisKeyFixes(parsed.native?.vorbis ?? [], { written, prefer });
  } catch {
    return null;
  }
}

/**
 * The fields the `ipod` muxer drops from `-metadata`, as the freeform atoms
 * {@link writeFreeformAtoms} writes after the remux instead (#1274). Names are
 * the ones already used as TXXX descriptions and Vorbis keys, so every
 * container carries one spelling per field.
 */
function mp4FreeformValues(tags: AudioTags): Record<string, string> {
  const out: Record<string, string> = {};
  if (tags.key !== undefined) out[MP4_KEY_ATOM] = tags.key;
  // `ipod` has `©wrt` for composer and no atom at all for conductor.
  if (tags.conductor !== undefined) out.CONDUCTOR = tags.conductor;
  for (const [field, key] of numericFeatureEntries()) {
    const v = tags[field];
    if (v !== undefined) out[key] = formatFeature(field, v);
  }
  if (tags.mood !== undefined) out[FEATURE_TAG_KEYS.mood] = tags.mood;
  if (tags.acoustIdId) out[TXXX_ACOUSTID] = tags.acoustIdId;
  if (tags.mbRecordingId) out[TXXX_MB_RECORDING] = tags.mbRecordingId;
  if (tags.mbReleaseId) out[TXXX_MB_RELEASE] = tags.mbReleaseId;
  return out;
}

/** The fields the organizer settles for every placed file (#1305). */
export type CanonicalTags = Pick<
  AudioTags,
  'album' | 'albumArtist' | 'artist' | 'title' | 'trackNumber' | 'year'
>;

/**
 * ffmpeg `-metadata` args for the canonical fields, in the key spellings
 * `writeFfmpegTags` uses — shared so a lossless encode can write them itself
 * instead of a remux rewriting them afterwards (#1305).
 */
export function canonicalTagMetadataArgs(tags: CanonicalTags): string[] {
  const args: string[] = [];
  if (tags.album !== undefined) args.push('-metadata', `ALBUM=${tags.album}`);
  // ffmpeg's generic key, not the Vorbis `ALBUMARTIST`: the only name here that
  // differs by more than case, so the Vorbis spelling landed beside the old
  // value instead of replacing it (#914). The muxer still emits ALBUMARTIST.
  if (tags.albumArtist !== undefined) args.push('-metadata', `album_artist=${tags.albumArtist}`);
  if (tags.artist !== undefined) args.push('-metadata', `ARTIST=${tags.artist}`);
  if (tags.title !== undefined) args.push('-metadata', `TITLE=${tags.title}`);
  if (tags.trackNumber !== undefined) args.push('-metadata', `TRACK=${tags.trackNumber}`);
  if (tags.year !== undefined) args.push('-metadata', `DATE=${tags.year}`);
  return args;
}

/**
 * Every `-metadata` arg a tag write for `ext` sets from `tags`, in the key
 * spellings that container's muxer reads. Shared by the remux below and by an
 * encode that writes its tags itself (#1288).
 */
export function ffmpegTagMetadataArgs(tags: AudioTags, ext: string): string[] {
  const metaArgs: string[] = canonicalTagMetadataArgs(tags);
  if (tags.discNumber !== undefined) metaArgs.push('-metadata', `DISC=${tags.discNumber}`);
  if (tags.genre !== undefined) metaArgs.push('-metadata', `GENRE=${tags.genre}`);
  if (tags.composer !== undefined) metaArgs.push('-metadata', `COMPOSER=${tags.composer}`);
  if (tags.conductor !== undefined) metaArgs.push('-metadata', `CONDUCTOR=${tags.conductor}`);
  if (tags.work !== undefined) metaArgs.push('-metadata', `WORK=${tags.work}`);
  if (tags.movement !== undefined) metaArgs.push('-metadata', `MOVEMENTNAME=${tags.movement}`);
  if (tags.movementNumber !== undefined)
    metaArgs.push('-metadata', `MOVEMENT=${tags.movementNumber}`);
  if (tags.bpm !== undefined)
    metaArgs.push('-metadata', `${BPM_METADATA_KEY[ext] ?? 'BPM'}=${tags.bpm}`);
  if (tags.key !== undefined) metaArgs.push('-metadata', `KEY=${tags.key}`);
  if (tags.lyrics !== undefined) metaArgs.push('-metadata', `LYRICS=${tags.lyrics}`);
  for (const [field, key] of numericFeatureEntries()) {
    const v = tags[field];
    if (v !== undefined) metaArgs.push('-metadata', `${key}=${formatFeature(field, v)}`);
  }
  if (tags.mood !== undefined) metaArgs.push('-metadata', `${FEATURE_TAG_KEYS.mood}=${tags.mood}`);
  if (tags.compilation) metaArgs.push('-metadata', 'COMPILATION=1');
  if (tags.acoustIdId) metaArgs.push('-metadata', `ACOUSTID_ID=${tags.acoustIdId}`);
  if (tags.mbRecordingId) metaArgs.push('-metadata', `MUSICBRAINZ_TRACKID=${tags.mbRecordingId}`);
  if (tags.mbReleaseId) metaArgs.push('-metadata', `MUSICBRAINZ_ALBUMID=${tags.mbReleaseId}`);
  return metaArgs;
}

/**
 * Write only the fields the `ipod` muxer drops — key, the perceptual features,
 * the ids — as freeform atoms, plus `tmpo`, in place: a byte-level patch of
 * `moov`, not a remux. For a file whose other tags an encode already wrote (#1288).
 */
/** Standard iTunes atoms the `ipod` muxer drops, patched in place instead (#1369). */
const MP4_WORK_ATOM_TYPES = ['©wrk', '©mvn', '©mvi'] as const;

/** The standard (non-`----`) atoms `tags` sets that no `-metadata` spelling lands. */
function mp4StandardAtoms(tags: AudioTags, withTempo: boolean): Buffer[] {
  const out: Buffer[] = [];
  // `tmpo` too, after an encode: the cover's remux in between drops it.
  if (withTempo && tags.bpm !== undefined) out.push(tmpoAtom(tags.bpm));
  if (tags.work !== undefined) out.push(textAtom('©wrk', tags.work));
  if (tags.movement !== undefined) out.push(textAtom('©mvn', tags.movement));
  if (tags.movementNumber !== undefined) out.push(intAtom('©mvi', tags.movementNumber));
  return out;
}

export function writeMp4FreeformTags(filepath: string, tags: AudioTags): boolean {
  const values = mp4FreeformValues(tags);
  const standard = mp4StandardAtoms(tags, true);
  if (Object.keys(values).length === 0 && standard.length === 0) return true;
  try {
    return writeFreeformAtoms(
      filepath,
      readFreeformAtoms(readFileSync(filepath)),
      values,
      standard,
    );
  } catch {
    return false;
  }
}

/** One ffmpeg slot covers the whole write — picture read, remux, re-attach (#1312). */
function writeFfmpegTags(
  filepath: string,
  tags: AudioTags,
  prefer?: ReadonlyMap<string, VorbisKeyPreference>,
): Promise<boolean> {
  return withFfmpegSlot('batch', () => remuxFfmpegTags(filepath, tags, prefer));
}

async function remuxFfmpegTags(
  filepath: string,
  tags: AudioTags,
  prefer?: ReadonlyMap<string, VorbisKeyPreference>,
): Promise<boolean> {
  const tmpPath = filepath + '.nicotind.tmp';
  const ext = extname(filepath).toLowerCase();
  const muxer = FFMPEG_MUXERS[ext];
  if (!muxer) return false;
  const metaArgs = ffmpegTagMetadataArgs(tags, ext);
  // Every rewrite also heals spaced comment names, so a file is normalized the
  // first time anything touches it. A key this write sets itself is excluded:
  // the caller's value supersedes whatever the spaced twin said.
  const written = new Set<string>();
  for (let i = 1; i < metaArgs.length; i += 2) {
    written.add(metaArgs[i]!.slice(0, metaArgs[i]!.indexOf('=')).toUpperCase());
  }
  const heal = await planVorbisKeyHeal(filepath, written, prefer);
  for (const m of heal?.metadata ?? []) metaArgs.push('-metadata', m);
  if (metaArgs.length === 0) return true;

  // ffmpeg surfaces an Ogg `METADATA_BLOCK_PICTURE` as a video stream the
  // opus/ogg muxer cannot carry, so this remux dropped every embedded cover
  // (#1280). Read it first and re-attach it to the output before the rename;
  // a picture that is present but unreadable refuses the write instead.
  const isOgg = ext === '.opus' || ext === '.ogg';
  let oggPicture: Awaited<ReturnType<typeof readOggPicture>> = null;
  if (isOgg) {
    try {
      oggPicture = await readOggPicture(filepath);
    } catch (err) {
      log.warn(
        { err, filepath },
        'could not read the embedded cover; refusing a write that would drop it',
      );
      return false;
    }
  }

  // The remux below drops every `----` atom the file already carries, not just
  // the fields we could not write — so they are read first and put back, with
  // this write's own values layered on top.
  let mp4Carry: { carried: Buffer[]; values: Record<string, string>; standard: Buffer[] } | null =
    null;
  if (ext === '.m4a') {
    try {
      const buf = readFileSync(filepath);
      // The remux drops the work/movement atoms as well as `----` ones: the
      // file's own are carried, and this write's values replace them by type.
      const written = mp4StandardAtoms(tags, false);
      const writtenTypes = new Set(written.map((a) => a.toString('latin1', 4, 8)));
      mp4Carry = {
        carried: readFreeformAtoms(buf),
        values: mp4FreeformValues(tags),
        standard: [
          ...readStandardAtoms(buf, MP4_WORK_ATOM_TYPES).filter(
            (a) => !writtenTypes.has(a.toString('latin1', 4, 8)),
          ),
          ...written,
        ],
      };
    } catch {
      return false;
    }
  }

  // Every -metadata also goes to the first audio STREAM (issue #760).
  //
  // In an Ogg container (.opus/.ogg) the Vorbis comments ARE stream metadata,
  // while `-metadata` writes *global*. The muxer merges global into the comment
  // header only where the stream has no value for that key — so a global write
  // lands on a tagless file and is silently discarded on one that already
  // carries the tag, because `-c copy` brings the old comment along and it
  // wins. Retagging is by definition the second case, so `fix_song_metadata`,
  // identify-apply, the analysis writers and the organizer all no-op'd on the
  // format this library transcodes everything into.
  //
  // Both scopes are written rather than branching per container: .flac and
  // .m4a read the global one, Ogg reads the stream one, and neither is harmed
  // by carrying the same value twice.
  const streamMetaArgs: string[] = [];
  for (let i = 0; i < metaArgs.length; i += 2) {
    streamMetaArgs.push('-metadata:s:a:0', metaArgs[i + 1]!);
  }

  const args = [
    '-y',
    '-i',
    filepath,
    '-map_metadata',
    '0',
    ...metaArgs,
    ...streamMetaArgs,
    // Audio only on Ogg: the cover is re-attached separately, and on `.ogg`
    // default stream selection maps it as mjpeg, which the muxer rejects —
    // failing every tag write to a covered file outright (#1280).
    ...(isOgg ? ['-map', '0:a'] : []),
    '-c',
    'copy',
    ...(FFMPEG_MUXER_ARGS[ext] ?? []),
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
    proc.on('close', async (code) => {
      if (code === 0) {
        try {
          if (
            oggPicture &&
            !(await attachPictureDataToOpus(tmpPath, oggPicture.data, oggPicture.mimeType))
          )
            throw new Error('embedded cover not re-attached');
          if (
            mp4Carry &&
            !writeFreeformAtoms(tmpPath, mp4Carry.carried, mp4Carry.values, mp4Carry.standard)
          )
            throw new Error('mp4 freeform atoms not written');
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
