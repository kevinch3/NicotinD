import { execFileSync } from 'node:child_process';
import { existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { createLogger } from '@nicotind/core';
import { ffmpegBinary } from './ffmpeg-path.js';

const log = createLogger('attached-picture');

/**
 * Cover art for the containers that carry it as an **attached picture stream**
 * — mp3's ID3 `APIC` and mp4/m4a's `covr` atom.
 *
 * Structurally different from the Ogg route in `opus-artwork.ts`, which
 * base64-encodes a `METADATA_BLOCK_PICTURE` into a Vorbis comment. Here the
 * image is a video stream in the container, marked `attached_pic` so players
 * treat it as artwork rather than something to play. Same intent, no shared
 * mechanism — which is why this is a second module rather than a parameter on
 * the first.
 *
 * **No size cap, measured rather than assumed.** The Opus path caps covers at
 * 512 KB because `music-metadata` throws above ~600 KB *in Ogg*. That is a
 * property of the reader against that container, not of cover art, and it does
 * not transfer. Measured here on real files, reading back with the same
 * `music-metadata` every read path in this app uses:
 *
 * | cover bytes | attached | read back | byte-exact |
 * | --- | --- | --- | --- |
 * | 43,287 | yes | 43,287 | yes |
 * | 427,891 | yes | 427,891 | yes |
 * | 1,343,456 | yes | 1,343,456 | yes |
 * | 2,593,122 | yes | 2,593,122 | yes |
 * | 6,553,147 | yes | 6,553,147 | yes |
 *
 * Ten times the Ogg ceiling with no failure, so carrying the 512 KB cap here
 * would re-compress covers that read back perfectly — degrading them for a
 * reason that does not apply. Disk cost is a separate question from reader
 * capability and belongs in operator settings, not disguised as a limit.
 */

/** ffmpeg muxer + extra args per container, so the tmp path's extension is irrelevant. */
const PICTURE_MUXERS: Record<string, { muxer: string; args: string[] }> = {
  // ID3v2.3, matching `FFMPEG_MUXER_ARGS` in audio-tags.ts: ffmpeg defaults to
  // v2.4, whose TDRC year node-id3 surfaces as `recordingTime` and no reader
  // here maps back — so a picture write would quietly cost the year.
  '.mp3': { muxer: 'mp3', args: ['-id3v2_version', '3'] },
  '.m4a': { muxer: 'ipod', args: [] },
};

/** Whether this container takes art through the attached-picture route. */
export function usesAttachedPicture(path: string): boolean {
  return extname(path).toLowerCase() in PICTURE_MUXERS;
}

/**
 * Attach `coverPath` to `audioPath` **without re-encoding the audio**.
 *
 * Never throws — art is an enhancement on a file whose audio is already
 * verified, so every failure is a warning and a `false`, matching
 * `attachPictureToOpus`.
 */
export function attachPictureAsStream(audioPath: string, coverPath: string): boolean {
  const ext = extname(audioPath).toLowerCase();
  const spec = PICTURE_MUXERS[ext];
  if (!spec) {
    log.warn({ audioPath }, 'no attached-picture muxer for this container');
    return false;
  }

  const dir = dirname(audioPath);
  const stem = basename(audioPath, extname(audioPath));
  const tmp = join(dir, `.${stem}.nicotind-art${ext}`);
  const cleanup = (): void => {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
  };

  try {
    execFileSync(
      ffmpegBinary(),
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        audioPath,
        '-i',
        coverPath,
        // Audio from input 0, picture from input 1. Both stream-copied: the
        // point is to add art to a verified encode, never to re-encode it.
        '-map',
        '0:a',
        '-map',
        '1:v',
        '-c:a',
        'copy',
        '-c:v',
        'copy',
        // Without this the image is an ordinary video stream and players try to
        // treat the file as a video rather than showing the cover.
        '-disposition:v',
        'attached_pic',
        ...spec.args,
        '-f',
        spec.muxer,
        '-y',
        tmp,
      ],
      { stdio: 'pipe' },
    );
    if (!existsSync(tmp) || statSync(tmp).size === 0) {
      cleanup();
      return false;
    }
    renameSync(tmp, audioPath);
    return true;
  } catch (err) {
    log.warn({ err, audioPath }, 'could not attach cover art');
    cleanup();
    return false;
  }
}
