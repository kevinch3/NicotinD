/**
 * Generates the e2e music fixtures with ffmpeg: small (~30s) silent FLAC tracks
 * carrying real tags so the native LibraryScanner (music-metadata) indexes them.
 * 30s (silence compresses to a few KB) gives seek/pause/next tests headroom so a
 * track doesn't auto-advance mid-assertion.
 *
 * Run once locally (`bun run --filter @nicotind/e2e make-fixtures`) and COMMIT the
 * output under fixtures/music — CI does not have/need ffmpeg. Re-run only when the
 * desired fixture library changes. **Additive**: a track that already exists is
 * left alone, so adding a fixture neither re-encodes the committed ones (byte
 * churn from a newer ffmpeg) nor touches anything else under the tree — the
 * script used to wipe `fixtures/music` first, which also deleted the committed
 * cover below. Delete a file by hand to regenerate it.
 *
 * Produces:
 *   - a 7-track album  -> classified `album`, appears in the Albums grid
 *   - a 1-track loose single -> classified `single`, appears on the artist page
 *   - two genre-tagged catalogues ("E2E Alpha", "E2E Beta") so a radio spec can
 *     tell a session that stays in its seed's genre from one that drifts (#1277);
 *     every other artist stays untagged, because several specs write the only
 *     genre they assert on and read it back by label
 *
 * NOT produced here: `E2E_Test_Artist/E2E_Test_Album/cover.jpg`, a committed
 * 1400x1400 sleeve the scanner picks up as folder art. It exists so screenshots
 * and the TV surface show a genuine cover rather than the gradient-initial
 * placeholder — a placeholder reads as a design choice, which is exactly how a
 * broken cover URL hid on the TV surface until someone looked at a screenshot.
 * It is committed as a binary rather than generated: a fixture that regenerates
 * is a fixture that can drift, and nothing here depends on its contents.
 *
 * The loose single is deliberately left WITHOUT art — `mobile-ux.spec.ts` G2
 * asserts the gradient fallback, which needs a genuinely art-less subject.
 */
import { existsSync, mkdirSync } from 'node:fs';
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
  genre?: string;
}

async function writeTrack(t: Track): Promise<void> {
  const safe = (s: string) => s.replace(/[^\w.-]+/g, '_');
  const dir = join(musicRoot, safe(t.artist), safe(t.album));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${String(t.track).padStart(2, '0')} - ${safe(t.title)}.flac`);
  if (existsSync(file)) {
    console.log('  kept ', file.replace(musicRoot + '/', ''));
    return;
  }

  // 30s of silence at 44.1k, tagged. -y overwrite.
  const args = [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-t',
    '30',
    '-metadata',
    `title=${t.title}`,
    '-metadata',
    `artist=${t.artist}`,
    '-metadata',
    `album=${t.album}`,
    '-metadata',
    `album_artist=${t.artist}`,
    '-metadata',
    `track=${t.track}/${t.total}`,
    '-metadata',
    `date=2024`,
    ...(t.genre ? ['-metadata', `genre=${t.genre}`] : []),
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

  // A same-artist pair sharing a title token, so the playlist-proposals e2e
  // spec has a genuine `matchesAllTokens` overlap to assert on: adding
  // "Nocturne" seeds proposal tokens {nocturne, e2e, playlist, seed, artist},
  // all of which are substrings of "Nocturne Drift" + its (same) artist — see
  // `docs/playlist-generation.md` "Proposals" for the token-overlap contract.
  console.log('Proposal pair: E2E Playlist Seed Artist / Nocturne + Nocturne Drift');
  await writeTrack({
    artist: 'E2E Playlist Seed Artist',
    album: 'E2E Playlist Seed Album',
    title: 'Nocturne',
    track: 1,
    total: 2,
  });
  await writeTrack({
    artist: 'E2E Playlist Seed Artist',
    album: 'E2E Playlist Seed Album',
    title: 'Nocturne Drift',
    track: 2,
    total: 2,
  });

  // Genre catalogues for the radio-anchor spec. `balanced` caps two tracks per
  // artist per generation, so a genre needs several artists to fill a queue
  // depth of five without leaking out of genre; Beta exists to be leaked into.
  const catalogue = async (genre: string, artists: number) => {
    console.log(`Genre catalogue: ${genre} (${artists} artists x 2 tracks)`);
    for (let a = 1; a <= artists; a++) {
      for (let n = 1; n <= 2; n++) {
        await writeTrack({
          artist: `${genre} Artist ${a}`,
          album: `${genre} Album ${a}`,
          title: `${genre} ${a}-${n}`,
          track: n,
          total: 2,
          genre,
        });
      }
    }
  };
  await catalogue('E2E Alpha', 5);
  await catalogue('E2E Beta', 2);

  console.log('\nDone. Commit the generated files under packages/e2e/fixtures/music.');
}

await main();
