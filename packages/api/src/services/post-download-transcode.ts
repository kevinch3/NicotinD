import { execFileSync, spawn } from 'node:child_process';
import { readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, extname } from 'node:path';
import { createLogger, ID3_EXTS } from '@nicotind/core';
import { isLossless } from './library-track-select.js';
import { getMusicMetadata } from './music-metadata-loader.js';
import { ffmpegAvailable, TRANSCODE_DURATION_TOLERANCE_SEC } from './transcode.js';
import { ffmpegBinary } from './ffmpeg-path.js';
import { extractEmbeddedPicture, preserveFolderCover } from './cover-sources.js';
import { attachPictureToOpus, preparePicture } from './opus-artwork.js';
import { readAudioTags, type AudioTags } from './audio-tags.js';
import { quarantineOriginal } from './transcode-quarantine.js';

const log = createLogger('post-download-transcode');

export { isLossless };

// Containers that hold either lossy AAC or lossless ALAC — the extension alone
// can't tell, only the codec inside can.
const AMBIGUOUS_CONTAINERS = new Set(['m4a', 'm4b', 'mp4']);

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
 * Transcode a lossless file to Opus **in place**, replacing the original.
 *
 * Used both by the download pipeline (before a file enters the library, so the
 * scanner only ever sees the final `.opus` path) and by the existing-library
 * conversion job. Lossy files are never touched — callers gate on
 * {@link isLossless}.
 *
 * Tags ride `-map_metadata 0`, plus explicit `-metadata` for the three native
 * ID3 frames it silently drops — see {@link ID3_FRAMES_FFMPEG_DROPS}. The
 * download path re-writes canonical tags afterwards anyway; the library
 * conversion job does not, which is why the carry has to happen here.
 *
 * Returns the new absolute path (same dir + basename, `.opus` extension). On any
 * ffmpeg failure the original is left untouched and the call throws.
 *
 * Integrity (same contract as the streaming transcode in `./transcode.ts`):
 *   - `-xerror` + `+discardcorrupt` so a damaged source fails fast
 *   - a strict-mode failure is retried once WITHOUT `explode`/`-xerror` (issue
 *     #534): a single damaged frame — common in Soulseek rips — decodes fine
 *     leniently, and rejecting it left the file un-standardized forever. The
 *     duration check below still guards the lenient output, so a genuinely
 *     truncated source is rejected in both modes.
 *   - post-write ffprobe vs music-metadata source duration, judged **fail
 *     closed** by {@link opusOutputVerdict}: an output that cannot be probed is
 *     rejected, not waved through. This file ends up IN the library rather than
 *     in a cache, and the very next statement unlinks the original, so the
 *     streaming path's best-effort policy would be actively wrong here. A user
 *     cannot tell a single library track is short without playing it.
 */
const TEMP_SUFFIX = '.nicotind-transcode.opus';

/**
 * Where the in-progress encode is written.
 *
 * **Dot-prefixed on purpose.** Every handled failure in `transcodeToOpus` already
 * unlinks this file, so the only way one survives is the process dying mid-write
 * — a deploy restart, an OOM kill — where no `finally` runs. A hidden basename
 * means `isHiddenFile()` keeps the scanner from ever ingesting the leftover as a
 * track with a mangled title and a truncated duration (#841). A leak then costs
 * disk, not library correctness.
 */
export function transcodeTempPathFor(absPath: string): string {
  const ext = extname(absPath);
  const stem = basename(ext ? absPath.slice(0, -ext.length) : absPath);
  return join(dirname(absPath), `.${stem}${TEMP_SUFFIX}`);
}

/**
 * Delete abandoned encode temps under `musicDir`. Existing installs already hold
 * leaks under the pre-#841 *un-hidden* name, which the scanner would ingest, so
 * this matches both shapes. Files younger than the grace period are left alone —
 * they may be an encode in flight.
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
      } else if (entry.isFile() && entry.name.endsWith(TEMP_SUFFIX)) {
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
 * The other, quieter failure: frames ffmpeg **keeps but renames wrong**.
 *
 * A TXXX user-text frame becomes a Vorbis comment named after its description,
 * uppercased — so `TXXX:MusicBrainz Track Id` lands as `MUSICBRAINZ TRACK ID`,
 * with spaces. That is not a Vorbis comment name anyone reads: the canonical
 * key is `MUSICBRAINZ_TRACKID`. Measured through the real encode:
 *
 * | ID3 TXXX description | ffmpeg writes | anyone reads |
 * | --- | --- | --- |
 * | `Acoustid Id` | `ACOUSTID ID` | `ACOUSTID_ID` |
 * | `MusicBrainz Track Id` | `MUSICBRAINZ TRACK ID` | `MUSICBRAINZ_TRACKID` |
 * | `MusicBrainz Album Id` | `MUSICBRAINZ ALBUM ID` | `MUSICBRAINZ_ALBUMID` |
 *
 * This is worse than the dropped frames, because the value is still *in* the
 * file — so a "did the data survive?" check says yes while every reader,
 * ours and other players', sees nothing. `acoustIdId` doubles as the
 * "already fingerprinted" marker, so losing it re-fingerprints the track
 * forever; the two MusicBrainz ids are what match a file back to a release.
 *
 * The fix sets the canonical key **and blanks the spaced one**. Setting only
 * the canonical key also reads correctly, but leaves both in the file — six
 * comments for three values, which the next pass would carry again.
 */
const ID3_TXXX_FFMPEG_MISNAMES = [
  { field: 'acoustIdId', description: 'Acoustid Id', vorbis: 'ACOUSTID_ID' },
  { field: 'mbRecordingId', description: 'MusicBrainz Track Id', vorbis: 'MUSICBRAINZ_TRACKID' },
  { field: 'mbReleaseId', description: 'MusicBrainz Album Id', vorbis: 'MUSICBRAINZ_ALBUMID' },
] as const;

/**
 * `-metadata` args fixing up what `-map_metadata 0` gets wrong — the frames
 * ffmpeg drops, and the ones it renames into unreadable keys.
 *
 * Done during the encode rather than as a second `writeAudioTags` pass: that
 * would rewrite the whole container again, and at whole-library scale a second
 * rewrite per file is not free.
 */
async function carriedMetadataArgs(absPath: string): Promise<string[]> {
  if (!ID3_EXTS.has(extname(absPath).toLowerCase())) return [];
  let tags: AudioTags;
  try {
    tags = await readAudioTags(absPath);
  } catch {
    return []; // an unreadable source is the encoder's problem, not ours
  }
  const args: string[] = [];
  const present = (v: unknown): v is string | number =>
    v !== undefined && v !== null && String(v) !== '';

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
  return args;
}

/** Where the replaced original goes instead of being unlinked. */
export interface TranscodeKeepOriginal {
  /** This run's quarantine dir, from `createQuarantineRun`. */
  runDir: string;
  /** Library root, so the original keeps its relative path inside the run. */
  musicDir: string;
}

/**
 * Move the source's embedded cover onto the freshly encoded Opus.
 *
 * Three steps, each of which can decline without failing the conversion:
 * read the picture out of the source, cap it so our own reader can read it
 * back (`preparePicture` — `music-metadata` throws above ~600 KB in Ogg), and
 * attach it with a stream copy.
 *
 * Never throws: art is an enhancement on a file whose audio is already
 * verified, so every failure is a warning and a `false`.
 */
async function carryEmbeddedCover(sourcePath: string, opusPath: string): Promise<boolean> {
  const raw = join(dirname(opusPath), `.${basename(opusPath)}.cover-src`);
  const scratch = join(dirname(opusPath), `.${basename(opusPath)}.cover-fit`);
  try {
    const pic = await extractEmbeddedPicture(sourcePath);
    if (!pic) return false;
    writeFileSync(raw, Buffer.from(pic.data));
    const prepared = preparePicture(raw, scratch);
    if (!prepared) return false; // too large to embed readably — say so, move on
    return attachPictureToOpus(opusPath, prepared.path);
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

export async function transcodeToOpus(
  absPath: string,
  bitRate = 128,
  keepOriginal?: TranscodeKeepOriginal,
): Promise<string> {
  // Materialise the cover BEFORE encoding: `-vn` below discards the attached
  // picture stream and nothing downstream can recover it (issue #953 — 0 of
  // 1,719 non-mp3 files in the library carry art). The source is lossless and
  // reliably has one; a no-op when the folder already has an image.
  await preserveFolderCover(absPath);
  const ext = extname(absPath);
  const base = ext ? absPath.slice(0, -ext.length) : absPath;
  const destPath = `${base}.opus`;
  // Distinct temp name so an interrupted run never half-writes the destination
  // (which may equal absPath only if the source were already .opus — excluded).
  const tmpPath = transcodeTempPathFor(absPath);
  const carried = await carriedMetadataArgs(absPath);
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
    '-c:a',
    'libopus',
    '-b:a',
    `${bitRate}k`,
    '-f',
    'ogg',
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
  // short of positive evidence is a rejection. See `opusOutputVerdict`.
  let verdict: { ok: true } | { ok: false; reason: string };
  try {
    verdict = await validateOpusOutput(absPath, tmpPath);
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
  // back; see `attachPictureToOpus` for why the obvious routes do not work.
  //
  // Best-effort by construction: the audio is already verified correct, and a
  // missing cover must never cost the conversion.
  await carryEmbeddedCover(absPath, tmpPath);

  try {
    // Promote temp → final, then deal with the original. If dest === source
    // path (impossible here since ext changed) we'd skip it entirely.
    renameSync(tmpPath, destPath);
    if (absPath !== destPath) {
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
    }
    log.debug({ from: absPath, to: destPath, bitRate }, 'transcoded lossless → opus');
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
  return new Promise((resolve, reject) => {
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
  });
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
export function opusOutputVerdict(
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
 * pass — see {@link opusOutputVerdict}.
 *
 * The one genuine exemption is ffmpeg being absent entirely: the strict decode
 * flags are off in that case too, so there is nothing to verify against and
 * the caller never reaches the delete anyway.
 */
async function validateOpusOutput(
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
  return opusOutputVerdict(src, out);
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
    const out = execFileSync(
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
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 },
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
