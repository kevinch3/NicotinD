/**
 * Generates the e2e music fixtures with ffmpeg: small (~30s) silent FLAC tracks
 * carrying real tags so the native LibraryScanner (music-metadata) indexes them.
 * 30s (silence compresses to a few KB) gives seek/pause/next tests headroom so a
 * track doesn't auto-advance mid-assertion.
 *
 * Run once locally (`bun run --filter @nicotind/e2e make-fixtures`) and COMMIT the
 * output under fixtures/music — CI does not have/need ffmpeg. Re-run only when the
 * desired fixture library changes.
 *
 * Produces:
 *   - a 7-track album  -> classified `album`, appears in the Albums grid
 *   - a 1-track loose single -> classified `single`, appears on the artist page
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const musicRoot = resolve(__dirname, '../fixtures/music');

interface Track {
  artist: string;
  album: string;
  title: string;
  track: number;
  total: number;
}

async function writeTrack(t: Track): Promise<void> {
  const safe = (s: string) => s.replace(/[^\w.-]+/g, '_');
  const dir = join(musicRoot, safe(t.artist), safe(t.album));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${String(t.track).padStart(2, '0')} - ${safe(t.title)}.flac`);

  // 30s of silence at 44.1k, tagged. -y overwrite.
  const args = [
    '-y',
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-t', '30',
    '-metadata', `title=${t.title}`,
    '-metadata', `artist=${t.artist}`,
    '-metadata', `album=${t.album}`,
    '-metadata', `album_artist=${t.artist}`,
    '-metadata', `track=${t.track}/${t.total}`,
    '-metadata', `date=2024`,
    file,
  ];

  const proc = Bun.spawn(['ffmpeg', ...args], { stdout: 'ignore', stderr: 'pipe' });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`ffmpeg failed for ${file} (exit ${code}):\n${err}`);
  }
  console.log('  wrote', file.replace(musicRoot + '/', ''));
}

async function main(): Promise<void> {
  rmSync(musicRoot, { recursive: true, force: true });
  mkdirSync(musicRoot, { recursive: true });

  const albumTitles = [
    'Opening Static',
    'Second Wind',
    'Three Of Cups',
    'Quiet Hours',
    'Five Easy Pieces',
    'Sixth Sense',
    'Closing Time',
  ];
  console.log('Album: E2E Test Artist / E2E Test Album');
  for (let i = 0; i < albumTitles.length; i++) {
    await writeTrack({
      artist: 'E2E Test Artist',
      album: 'E2E Test Album',
      title: albumTitles[i]!,
      track: i + 1,
      total: albumTitles.length,
    });
  }

  console.log('Single: E2E Single Artist / E2E Lonesome Single');
  await writeTrack({
    artist: 'E2E Single Artist',
    album: 'E2E Lonesome Single',
    title: 'E2E Lonesome Single',
    track: 1,
    total: 1,
  });

  console.log('\nDone. Commit the generated files under packages/e2e/fixtures/music.');
}

await main();
