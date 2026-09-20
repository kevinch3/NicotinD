import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Fixture builders for the Opus-artwork harness.
 *
 * Split out from the spec so the generators are reusable and the spec reads as
 * assertions rather than setup. Everything here shells out to real ffmpeg /
 * opusenc: the whole point is to test what those tools actually produce, which
 * ad-hoc probing got wrong twice (#1226).
 */

/** Present on this machine? `opus-tools` is a separate package from ffmpeg. */
export function opusencAvailable(): boolean {
  try {
    execFileSync('opusenc', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function opusinfoAvailable(): boolean {
  try {
    // `-V`, not `--version`: opusinfo rejects long options and prints
    // "invalid option" per character, so the obvious probe silently answers no.
    execFileSync('opusinfo', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * A JPEG of roughly `px` square, filled with **noise** so it cannot compress
 * away — a flat colour yields a few hundred bytes and would test nothing about
 * size handling, which is the axis that matters here.
 */
export function makeCover(path: string, px: number, quality = 3): number {
  mkdirSync(dirname(path), { recursive: true });
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `nullsrc=s=${px}x${px},geq=random(1)*255:128:128`,
      '-frames:v',
      '1',
      '-q:v',
      String(quality),
      '-y',
      path,
    ],
    { stdio: 'ignore' },
  );
  return statSync(path).size;
}

/** One second of silence as a WAV, the input opusenc takes. */
export function makeWav(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-t',
      '1',
      '-c:a',
      'pcm_s16le',
      '-y',
      path,
    ],
    { stdio: 'ignore' },
  );
}

/** An mp3 carrying `coverPath` as an attached picture. */
export function makeMp3WithCover(path: string, coverPath: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const bare = join(dirname(path), '.bare-for-cover.mp3');
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-t',
      '1',
      '-c:a',
      'libmp3lame',
      '-y',
      bare,
    ],
    { stdio: 'ignore' },
  );
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      bare,
      '-i',
      coverPath,
      '-map',
      '0:a',
      '-map',
      '1:v',
      '-c',
      'copy',
      '-id3v2_version',
      '3',
      '-metadata:s:v',
      'title=cover',
      '-y',
      path,
    ],
    { stdio: 'ignore' },
  );
}

/** Encode `wav` to Opus with `cover` embedded, using opus-tools. */
export function encodeWithPicture(wav: string, cover: string, out: string, bitRate = 96): void {
  mkdirSync(dirname(out), { recursive: true });
  execFileSync(
    'opusenc',
    ['--quiet', '--bitrate', String(bitRate), '--picture', `3||||${cover}`, wav, out],
    { stdio: 'pipe' },
  );
}

/**
 * What `opusinfo` — opus-tools' own reader, and therefore the authority on
 * whether the FILE is right — says the embedded picture is.
 *
 * Returns the declared byte count, or null when there is no picture block.
 * Used to separate "the file is wrong" from "our reader cannot read it",
 * which is the distinction the whole harness exists to make.
 */
export function opusinfoPictureBytes(opusPath: string): number | null {
  const out = execFileSync('opusinfo', [opusPath], { encoding: 'utf8', stdio: 'pipe' });
  const m = out.match(/METADATA_BLOCK_PICTURE=.*?<(\d+) bytes of image data>/);
  return m ? Number(m[1]) : null;
}
