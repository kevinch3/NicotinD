import { spawn } from 'node:child_process';
import { execFileAsync } from './exec-file.js';
import { readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, extname } from 'node:path';
import { createLogger, ID3_EXTS } from '@nicotind/core';
import { isLossless } from './library-track-select.js';
import { getMusicMetadata } from './music-metadata-loader.js';
import { ffmpegAvailable, TRANSCODE_DURATION_TOLERANCE_SEC } from './transcode.js';
import { ffmpegBinary } from './ffmpeg-path.js';
import { withFfmpegSlot } from './ffmpeg-slots.js';
import { extractEmbeddedPicture, preserveFolderCover } from './cover-sources.js';
import { preparePicture } from './opus-artwork.js';
import {
  canonicalTagMetadataArgs,
  readAudioTags,
  writeAudioTags,
  type AudioTags,
  type CanonicalTags,
} from './audio-tags.js';
import { quarantineOriginal } from './transcode-quarantine.js';
import {
  ID3_TXXX_FFMPEG_MISNAMES,
  UNMODELLED_SPACED_KEYS,
  planVorbisKeyFixes,
  type VorbisComment,
} from './vorbis-keys.js';
import {
  DEFAULT_LIBRARY_FORMAT,
  libraryFormat,
  TRANSCODE_TEMP_MARKER,
  type FormatStrategy,
  type LibraryFormat,
} from './library-format.js';

const log = createLogger('post-download-transcode');

export { isLossless };

// Containers that hold either lossy AAC or lossless ALAC — the extension alone
// can't tell, only the codec inside can. Exported: library-transcode.ts and
// library-format-settings.ts both need the same set, for the same reason —
// see #1286.
export const AMBIGUOUS_CONTAINERS = new Set(['m4a', 'm4b', 'mp4']);

/**
 * Codec-aware lossless check. Unambiguous extensions are decided without IO
 * (`isLossless`); `.m4a`-family files are probed with music-metadata because
 * ALAC (Apple Lossless) ships in the exact same container as lossy AAC.
 * Browsers cannot decode ALAC at all (Firefox surfaces
 * NS_ERROR_DOM_MEDIA_METADATA_ERR), so missing it here means a file the web
 * player can only play while server transcoding is enabled. Unreadable or
 * unparseable files answer `false` — the pipeline then leaves them untouched.
 */
export async function isLosslessFile(absPath: string): Promise<boolean> {
  const ext = extname(absPath).toLowerCase().replace(/^\./, '');
  if (isLossless(ext)) return true;
  if (!AMBIGUOUS_CONTAINERS.has(ext)) return false;
  try {
    const mm = await getMusicMetadata();
    if (!mm) return false;
    const meta = await mm.parseFile(absPath, { duration: false, skipCovers: true });
    return meta.format.lossless === true;
  } catch {
    return false;
  }
}

/**
 * Transcode a file to the library's target format **in place**, replacing the
 * original.
 *
 * Used both by the download pipeline (before a file enters the library, so the
 * scanner only ever sees the final encoded path) and by the existing-library
 * conversion job. Lossy files are never touched — callers gate on
 * {@link isLossless}.
 *
 * Tags ride `-map_metadata 0`, plus explicit `-metadata` for the three native
 * ID3 frames it silently drops — see {@link ID3_FRAMES_FFMPEG_DROPS}. The
 * download path re-writes canonical tags afterwards anyway; the library
 * conversion job does not, which is why the carry has to happen here.
 *
 * Returns the new absolute path (same dir + basename, the target format's
 * extension). On any ffmpeg failure the original is left untouched and the call
 * throws.
 *
 * Integrity (same contract as the streaming transcode in `./transcode.ts`):
 *   - `-xerror` + `+discardcorrupt` so a damaged source fails fast
 *   - a strict-mode failure is retried once WITHOUT `explode`/`-xerror` (issue
 *     #534): a single damaged frame — common in Soulseek rips — decodes fine
 *     leniently, and rejecting it left the file un-standardized forever. The
 *     duration check below still guards the lenient output, so a genuinely
 *     truncated source is rejected in both modes.
 *   - post-write ffprobe vs music-metadata source duration, judged **fail
 *     closed** by {@link encodeOutputVerdict}: an output that cannot be probed
 *     is rejected, not waved through. This file ends up IN the library rather
 *     than in a cache, and the very next statement unlinks the original, so the
 *     streaming path's best-effort policy would be actively wrong here. A user
 *     cannot tell a single library track is short without playing it.
 */

/**
 * Where the in-progress encode is written.
 *
 * **Dot-prefixed on purpose.** Every handled failure in
 * `transcodeToLibraryFormat` already unlinks this file, so the only way one
 * survives is the process dying mid-write — a deploy restart, an OOM kill —
 * where no `finally` runs. A hidden basename means `isHiddenFile()` keeps the
 * scanner from ever ingesting the leftover as a track with a mangled title and
 * a truncated duration (#841). A leak then costs disk, not library correctness.
 *
 * The target's extension is on the end so ffmpeg can pick a muxer from the temp
 * path the same way it would from the final one.
 */
export function transcodeTempPathFor(
  absPath: string,
  format: LibraryFormat = DEFAULT_LIBRARY_FORMAT,
): string {
  const ext = extname(absPath);
  const stem = basename(ext ? absPath.slice(0, -ext.length) : absPath);
  return join(dirname(absPath), `.${stem}${TRANSCODE_TEMP_MARKER}${libraryFormat(format).ext}`);
}

/**
 * Delete abandoned encode temps under `musicDir`. Existing installs already hold
 * leaks under the pre-#841 *un-hidden* name, which the scanner would ingest, so
 * this matches both shapes. Files younger than the grace period are left alone —
 * they may be an encode in flight.
 *
 * Matches the format-independent marker rather than one target's suffix: after
 * the target changes, temps left by the previous one still have to be swept, and
 * a suffix match would strand them forever.
 */
export function sweepStaleTranscodeTemps(musicDir: string, graceMs = 10 * 60_000): number {
  const cutoff = Date.now() - graceMs;
  let removed = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.includes(TRANSCODE_TEMP_MARKER)) {
        try {
          if (statSync(full).mtimeMs < cutoff) {
            rmSync(full, { force: true });
            removed += 1;
          }
        } catch {
          /* raced with another sweep or the encode itself */
        }
      }
    }
  };
  walk(musicDir);
  if (removed > 0) log.info({ musicDir, removed }, 'swept abandoned transcode temp files');
  return removed;
}

/**
 * How many {@link transcodeToLibraryFormat} calls may run at once.
 *
 * why a small constant rather than `cpus().length`: this is real CPU work, but
 * the box also runs the analysis sidecar and whatever else shares the host, and
 * one batch is not the only thing that should get to use it. Measured on prod
 * (8 cores, load ~1.8): four concurrent encodes of a 3-minute FLAC took 3.4 s
 * against 10.0 s serial, so the return is already most of the way to linear at
 * four and buying more would mostly be taking cores off neighbours.
 *
 * It lives here rather than in either caller because both the download
 * organizer and the whole-library conversion pool the same call against the
 * same cores. Two independently chosen numbers would quietly become eight
 * concurrent encodes whenever a download lands mid-conversion.
 */
export const TRANSCODE_CONCURRENCY = 4;

/**
 * ID3 frames `-map_metadata 0` does not carry into Vorbis comments, and the
 * Vorbis name each has to be written under.
 *
 * Measured rather than assumed, on a real mp3 carrying the full tag set.
 * Everything NicotinD stores as an ID3 `TXXX` user-text frame — energy,
 * loudness, valence, danceability, acousticness, instrumentalness, mood —
 * maps across on its own. Exactly three do not, and all three are **native**
 * ID3 frames rather than user text:
 *
 * | field  | ID3 frame | survives `-map_metadata 0`? |
 * | ------ | --------- | --- |
 * | bpm    | `TBPM`    | no  |
 * | key    | `TKEY`    | no  |
 * | lyrics | `USLT`    | no  |
 *
 * Losing them is not cosmetic. `POST /api/library/songs/:id/bpm` and
 * `analyze-bpm.ts` both prefer a file's own BPM tag over a DSP run, so a
 * dropped `TBPM` means that track is re-analysed forever — the same live cost
 * #1151 and #1177 describe, one container over. And the lyrics tag is the only
 * recovery path for a `library_lyrics` row orphaned by the id re-mint.
 */
const ID3_FRAMES_FFMPEG_DROPS = [
  { field: 'bpm', vorbis: 'BPM' },
  { field: 'key', vorbis: 'KEY' },
  { field: 'lyrics', vorbis: 'LYRICS' },
] as const;

/**
 * `-metadata` args fixing up what `-map_metadata 0` gets wrong — the frames
 * ffmpeg drops, and the ones it renames into unreadable keys.
 *
 * Done during the encode rather than as a second `writeAudioTags` pass: that
 * would rewrite the whole container again, and at whole-library scale a second
 * rewrite per file is not free.
 */
/**
 * The mirror image: what `-map_metadata 0` drops going **Vorbis → ID3**.
 *
 * `ID3_FRAMES_FFMPEG_DROPS` above covers ID3 → Vorbis, the only direction that
 * existed while Opus was the only target. Converting *into* mp3 loses a
 * different set, and nothing covered it until the per-format round-trip test
 * measured it (#1256): from a FLAC source, an mp3 target arrived missing seven
 * of twenty-two fields.
 *
 * Probed the way #1177's `tmpo` was — every plausible spelling against a real
 * file, read back with music-metadata:
 *
 * | field | key that works | keys that do not |
 * | --- | --- | --- |
 * | bpm | `TBPM` | `BPM` |
 * | key | `TKEY` | `KEY`, `initial_key` |
 *
 * The three ids are the **mirror of #1230**, one direction over. ffmpeg names
 * the TXXX frame after the `-metadata` key it was given, and `readAudioTags`
 * looks the ids up by their spaced, title-case descriptions (`Acoustid Id`).
 * So `-metadata ACOUSTID_ID=…` writes a frame that is present in the file and
 * invisible to every reader here — a "did the data survive?" check says yes
 * while nothing can find it. They therefore reuse the **description** column of
 * {@link ID3_TXXX_FFMPEG_MISNAMES} rather than a second copy of those strings.
 *
 * Two fields have **no** working `-metadata` key at all and are handled after
 * the encode by {@link carryPostEncodeTags}: `lyrics` (ffmpeg re-emits USLT as a
 * TXXX no reader maps back) and `compilation` (needs a TCMP frame ffmpeg's mp3
 * muxer will not write).
 */
const VORBIS_FIELDS_FFMPEG_DROPS = [
  { field: 'bpm', id3: 'TBPM' },
  { field: 'key', id3: 'TKEY' },
  ...ID3_TXXX_FFMPEG_MISNAMES.map((m) => ({ field: m.field, id3: m.description })),
] as const satisfies ReadonlyArray<{ field: keyof AudioTags; id3: string }>;

/**
 * The two fields no `-metadata` key can carry into ID3, written after the
 * encode through node-id3 — the same route `writeAudioTags` already uses to put
 * lyrics back after an ffmpeg container rewrite.
 *
 * Best-effort by construction: the audio is verified and the file is already
 * correct without these, so a failure is a warning, never a lost conversion.
 */
async function carryPostEncodeTags(sourceTags: AudioTags, outPath: string): Promise<void> {
  // An `.m4a` target gets the source's whole tag set: the `ipod` muxer drops
  // key, the perceptual features and the ids from `-map_metadata` and from any
  // `-metadata` spelling, and `writeAudioTags` is the one writer that lands
  // them, as freeform atoms (#1274, #1279). Written after the cover, because
  // the cover's own remux would otherwise drop those atoms.
  if (extname(outPath).toLowerCase() === '.m4a') {
    try {
      if (!(await writeAudioTags(outPath, sourceTags)))
        log.warn({ outPath }, 'could not carry tags onto the encoded .m4a');
    } catch (err) {
      log.warn({ err, outPath }, 'could not carry tags onto the encoded .m4a');
    }
    return;
  }
  const carry: AudioTags = {};
  if (sourceTags.lyrics !== undefined) carry.lyrics = sourceTags.lyrics;
  if (sourceTags.compilation) carry.compilation = true;
  if (Object.keys(carry).length === 0) return;
  try {
    await writeAudioTags(outPath, carry);
  } catch (err) {
    log.warn({ err, outPath }, 'could not carry lyrics/compilation onto the encoded file');
  }
}

/**
 * The Vorbis comments an ID3 → Vorbis encode produces from `-map_metadata 0`,
 * as far as spaced names go: each TXXX under its uppercased description, and
 * the album artist `TPE2` maps to. Empty if the source cannot be parsed.
 */
async function encodedVorbisComments(absPath: string, tags: AudioTags): Promise<VorbisComment[]> {
  const out: VorbisComment[] = [];
  if (tags.albumArtist) out.push({ id: 'ALBUMARTIST', value: tags.albumArtist });
  const mm = await getMusicMetadata();
  if (!mm) return out;
  try {
    const parsed = await mm.parseFile(absPath, { duration: false, skipCovers: true });
    for (const [type, frames] of Object.entries(parsed.native ?? {})) {
      if (!type.startsWith('ID3v2')) continue;
      for (const f of frames) {
        if (!f.id.startsWith('TXXX:')) continue;
        const id = f.id.slice(5).toUpperCase();
        for (const value of Array.isArray(f.value) ? f.value : [f.value]) out.push({ id, value });
      }
    }
  } catch {
    /* the encoder reports an unreadable source */
  }
  return out;
}

async function carriedMetadataArgs(
  absPath: string,
  targetExt: string,
): Promise<{ args: string[]; sourceTags: AudioTags | null }> {
  const sourceIsId3 = ID3_EXTS.has(extname(absPath).toLowerCase());
  const targetIsId3 = ID3_EXTS.has(`.${targetExt}`);
  // No `-metadata` spelling reaches the fields `ipod` drops, so an `.m4a`
  // target is carried after the encode instead — see `carryPostEncodeTags`.
  if (targetExt === 'm4a') {
    try {
      return { args: [], sourceTags: await readAudioTags(absPath) };
    } catch {
      return { args: [], sourceTags: null };
    }
  }
  // Same tag family in and out: `-map_metadata 0` carries everything and there
  // is nothing to fix up.
  if (sourceIsId3 === targetIsId3) return { args: [], sourceTags: null };

  let tags: AudioTags;
  try {
    tags = await readAudioTags(absPath);
  } catch {
    return { args: [], sourceTags: null }; // an unreadable source is the encoder's problem
  }
  const args: string[] = [];
  const present = (v: unknown): v is string | number =>
    v !== undefined && v !== null && String(v) !== '';

  if (sourceIsId3) {
    for (const { field, vorbis } of ID3_FRAMES_FFMPEG_DROPS) {
      const v = tags[field];
      if (present(v)) args.push('-metadata', `${vorbis}=${String(v)}`);
    }
    for (const { field, description, vorbis } of ID3_TXXX_FFMPEG_MISNAMES) {
      const v = tags[field];
      if (!present(v)) continue;
      args.push('-metadata', `${vorbis}=${String(v)}`);
      // Blank the key ffmpeg derives from the TXXX description, so the value
      // exists once under the name readers actually look for.
      args.push('-metadata', `${description.toUpperCase()}=`);
    }
    // The TXXX frames `AudioTags` does not model land spaced too (#1250), so
    // the comments the encode *will* write are planned here, from the source.
    const plan = planVorbisKeyFixes(await encodedVorbisComments(absPath, tags), {
      keys: UNMODELLED_SPACED_KEYS,
    });
    for (const m of plan.metadata) args.push('-metadata', m);
    return { args, sourceTags: tags };
  }

  // Vorbis-family source, ID3 target — the mirror direction (#1256).
  for (const { field, id3 } of VORBIS_FIELDS_FFMPEG_DROPS) {
    const v = tags[field];
    if (present(v)) args.push('-metadata', `${id3}=${String(v)}`);
  }
  return { args, sourceTags: tags };
}

/** Where the replaced original goes instead of being unlinked. */
export interface TranscodeKeepOriginal {
  /** This run's quarantine dir, from `createQuarantineRun`. */
  runDir: string;
  /** Library root, so the original keeps its relative path inside the run. */
  musicDir: string;
}

/**
 * Move the source's embedded cover onto the freshly encoded file.
 *
 * Three steps, each of which can decline without failing the conversion:
 * read the picture out of the source, cap it so our own reader can read it
 * back (`preparePicture` — `music-metadata` throws above ~600 KB in Ogg), and
 * attach it by whatever mechanism the target format uses.
 *
 * Never throws: art is an enhancement on a file whose audio is already
 * verified, so every failure is a warning and a `false`.
 */
async function carryEmbeddedCover(
  sourcePath: string,
  outPath: string,
  strategy: FormatStrategy,
): Promise<boolean> {
  // The `.jpg` matters and is not decoration: `preparePicture` re-compresses an
  // oversized cover with `ffmpeg -i in -q:v N out`, and ffmpeg picks the output
  // muxer from the **extension**. With an extensionless scratch path it cannot,
  // so every re-compress failed and every cover over the 512 KB cap was
  // dropped — measured at 10% of files, and exactly the well-tagged albums
  // whose art is worth keeping.
  const raw = join(dirname(outPath), `.${basename(outPath)}.cover-src.jpg`);
  const scratch = join(dirname(outPath), `.${basename(outPath)}.cover-fit.jpg`);
  try {
    const pic = await extractEmbeddedPicture(sourcePath);
    if (!pic) return false;
    writeFileSync(raw, Buffer.from(pic.data));
    const prepared = await preparePicture(raw, scratch, strategy.maxEmbeddedPictureBytes);
    if (!prepared) return false; // too large to embed readably — say so, move on
    return await strategy.embedArt(outPath, prepared.path);
  } catch (err) {
    log.debug({ err, sourcePath }, 'no cover carried across the transcode');
    return false;
  } finally {
    for (const p of [raw, scratch]) {
      try {
        rmSync(p, { force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

export async function transcodeToLibraryFormat(
  absPath: string,
  bitRate = 128,
  keepOriginal?: TranscodeKeepOriginal,
  format: LibraryFormat = DEFAULT_LIBRARY_FORMAT,
  // The organizer's settled tags, written by the encode itself so its tag pass
  // afterwards finds nothing left to change (#1305). Last, so they win.
  canonical?: CanonicalTags,
): Promise<string> {
  const strategy = libraryFormat(format);
  // Materialise the cover BEFORE encoding: `-vn` below discards the attached
  // picture stream and nothing downstream can recover it (issue #953 — 0 of
  // 1,719 non-mp3 files in the library carry art). The source is lossless and
  // reliably has one; a no-op when the folder already has an image.
  await preserveFolderCover(absPath);
  const ext = extname(absPath);
  const base = ext ? absPath.slice(0, -ext.length) : absPath;
  const destPath = `${base}.${strategy.ext}`;
  // Distinct temp name so an interrupted run never half-writes the
  // destination. destPath can equal absPath: not just when the source were
  // already the target format (excluded by the callers' "already the target"
  // test), but genuinely when an ambiguous-container source (ALAC in `.m4a`)
  // converts to a target sharing that extension (`aac`, #1286) — the rename
  // below is written to stay correct for that case too.
  const tmpPath = transcodeTempPathFor(absPath, format);
  const { args: carried, sourceTags } = await carriedMetadataArgs(absPath, strategy.ext);
  const ffmpegArgs = (strict: boolean) => [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-fflags',
    '+discardcorrupt',
    ...(strict ? ['-err_detect', 'explode', '-xerror'] : []),
    '-i',
    absPath,
    '-vn',
    '-map_metadata',
    '0',
    // After -map_metadata so these win over anything it carried.
    ...carried,
    ...(canonical ? canonicalTagMetadataArgs(canonical) : []),
    ...strategy.encodeArgs(bitRate),
    tmpPath,
  ];

  const strictRun = await runFfmpeg(ffmpegArgs(true), tmpPath);
  if (strictRun.code !== 0) {
    const lenientRun = await runFfmpeg(ffmpegArgs(false), tmpPath);
    if (lenientRun.code !== 0) {
      cleanup(tmpPath);
      const detail = lenientRun.stderrTail || strictRun.stderrTail;
      throw new Error(
        `ffmpeg exited with code ${lenientRun.code} transcoding ${absPath}${detail ? `: ${detail}` : ''}`,
      );
    }
    log.info(
      { absPath, strictError: strictRun.stderrTail },
      'strict transcode failed — lenient retry succeeded (imperfect source frame)',
    );
  }

  // Exit 0 isn't enough — ffmpeg can succeed on a truncated source and
  // produce a valid-but-short Opus file that the browser will play for
  // 1-2 s then "end". Validate before swapping the library file — and **fail
  // closed**: the statement after the swap unlinks the original, so anything
  // short of positive evidence is a rejection. See `encodeOutputVerdict`.
  let verdict: { ok: true } | { ok: false; reason: string };
  try {
    verdict = await validateEncodedOutput(absPath, tmpPath);
  } catch (err) {
    // A throw here used to leave the flag at its `true` initial value, so the
    // original was deleted on the strength of an exception. Unverifiable is a
    // rejection now, because the next statement is irreversible.
    verdict = { ok: false, reason: `verification threw: ${(err as Error).message}` };
  }
  if (!verdict.ok) {
    cleanup(tmpPath);
    throw new Error(
      `Refusing to replace ${absPath}: ${verdict.reason}. The original is untouched.`,
    );
  }
  // Carry the source's embedded cover across, onto the TEMP — so the rename
  // below promotes a complete file rather than one that gains art a moment
  // later. `-vn` in the encode discarded it and nothing else can bring it
  // back; see the format's `embedArt` for why the obvious routes do not work.
  //
  // Best-effort by construction: the audio is already verified correct, and a
  // missing cover must never cost the conversion.
  await carryEmbeddedCover(absPath, tmpPath, strategy);

  // Lyrics and the compilation flag have no working `-metadata` key into ID3,
  // so they go on after the encode, onto the TEMP — the rename below then
  // promotes a complete file rather than one that gains tags a moment later,
  // the same discipline the cover carry above follows.
  if (sourceTags) await carryPostEncodeTags(sourceTags, tmpPath);

  try {
    // Promote temp → final, then deal with the original — except when
    // destPath and absPath are the SAME path (an ambiguous-container source
    // converting to a same-extension target, e.g. ALAC → aac, #1286): there,
    // the rename would silently overwrite the original before it could ever be
    // preserved, so the original is dealt with FIRST, freeing the path for the
    // rename that follows. Distinct paths keep the original order, since
    // nothing there touches absPath before the rename runs.
    const dealWithOriginal = (): void => {
      if (keepOriginal) {
        // Opt-in, and only the whole-library backfill opts in. A freshly
        // downloaded original is one re-download away, and quarantining every
        // download would fill the disk for no benefit; an irreplaceable
        // library file is a different proposition, and generation loss is
        // invisible to every check that runs before this point.
        quarantineOriginal(keepOriginal.runDir, keepOriginal.musicDir, absPath);
      } else {
        rmSync(absPath, { force: true });
      }
    };
    const sameLocation = absPath === destPath;
    if (sameLocation) dealWithOriginal();
    renameSync(tmpPath, destPath);
    if (!sameLocation) dealWithOriginal();
    log.debug({ from: absPath, to: destPath, bitRate, format }, 'transcoded to the library format');
    return destPath;
  } catch (err) {
    cleanup(tmpPath);
    throw err;
  }
}

/** Cap kept stderr so a pathological input can't balloon the error object. */
const STDERR_TAIL_CHARS = 400;

/** Spawn ffmpeg capturing a bounded stderr tail — an opaque "exited with code
 *  183" with the real reason discarded is the exact bug class track-analysis.ts
 *  already fixed; this brings the ingest transcode onto the same contract. */
function runFfmpeg(
  args: string[],
  tmpPath: string,
): Promise<{ code: number | null; stderrTail: string }> {
  return withFfmpegSlot(
    'batch',
    () =>
      new Promise((resolve, reject) => {
        const proc = spawn(ffmpegBinary(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        proc.stderr?.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_CHARS);
        });
        proc.on('error', (err) => {
          cleanup(tmpPath);
          reject(err);
        });
        proc.on('close', (code) => {
          resolve({ code, stderrTail: stderr.trim().split('\n').at(-1)?.trim() ?? '' });
        });
      }),
  );
}

/**
 * Whether the output is good enough to **destroy the source for**.
 *
 * Deliberately stricter than `validateTranscodeOutput` in `./transcode.ts`,
 * because the stakes are not the same and a single shared policy cannot be
 * right for both. There, the output is a *cache* file: an unprobeable one is
 * served best-effort and regenerated if it is wrong, so failing open costs a
 * cache miss. Here the next statement unlinks an irreplaceable library file.
 *
 * So this one **fails closed**. Two ways it used to fail open, both of which
 * ended with the original deleted on no evidence:
 *
 * 1. `transcodeOutputIsAcceptable` returns `true` when *either* duration is
 *    `null` — "best effort", which is right for a cache and wrong here.
 * 2. The caller initialised its flag to `true` and swallowed a probe throw, so
 *    an exception was also a pass.
 *
 * Returns a reason rather than a bare boolean: "failed the duration check" and
 * "could not be probed at all" are different operator problems, and a run over
 * thousands of files needs to say which.
 */
export function encodeOutputVerdict(
  sourceSec: number | null,
  outputSec: number | null,
  toleranceSec = TRANSCODE_DURATION_TOLERANCE_SEC,
): { ok: true } | { ok: false; reason: string } {
  if (sourceSec == null) return { ok: false, reason: 'source duration could not be read' };
  if (outputSec == null) return { ok: false, reason: 'output duration could not be read' };
  if (!Number.isFinite(outputSec) || outputSec <= 0) {
    return { ok: false, reason: `output duration is ${outputSec}` };
  }
  if (outputSec < sourceSec - toleranceSec) {
    return {
      ok: false,
      reason: `output ${outputSec.toFixed(2)}s is shorter than source ${sourceSec.toFixed(2)}s`,
    };
  }
  return { ok: true };
}

/**
 * Probe both durations and judge. Any probe failure is a **rejection**, not a
 * pass — see {@link encodeOutputVerdict}.
 *
 * The one genuine exemption is ffmpeg being absent entirely: the strict decode
 * flags are off in that case too, so there is nothing to verify against and
 * the caller never reaches the delete anyway.
 */
async function validateEncodedOutput(
  sourcePath: string,
  outputPath: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!ffmpegAvailable()) return { ok: true };
  let src: number | null = null;
  let out: number | null = null;
  try {
    [src, out] = await Promise.all([
      readSourceDurationSec(sourcePath),
      readOutputDurationSec(outputPath),
    ]);
  } catch (err) {
    return { ok: false, reason: `duration probe threw: ${(err as Error).message}` };
  }
  return encodeOutputVerdict(src, out);
}

async function readSourceDurationSec(absPath: string): Promise<number | null> {
  try {
    const mm = await getMusicMetadata();
    if (!mm) return null;
    const meta = await mm.parseFile(absPath, { duration: true, skipCovers: true });
    return meta.format.duration ?? null;
  } catch {
    return null;
  }
}

async function readOutputDurationSec(absPath: string): Promise<number | null> {
  try {
    const ffprobe = ffmpegBinary().replace(/ffmpeg$/, 'ffprobe');
    const out = (
      await execFileAsync(
        ffprobe,
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'default=noprint_wrappers=1:nokey=1',
          absPath,
        ],
        { timeout: 10_000 },
      )
    )
      .toString()
      .trim();
    const sec = Number(out);
    return Number.isFinite(sec) ? sec : null;
  } catch {
    return null;
  }
}

function cleanup(p: string): void {
  try {
    rmSync(p, { force: true });
  } catch {
    /* ignore */
  }
}
