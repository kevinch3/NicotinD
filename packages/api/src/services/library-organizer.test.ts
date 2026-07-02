/**
 * Integration tests for LibraryOrganizer against real fs + real ID3 reads/writes.
 *
 * Each test seeds a synthetic MP3 (copy of the silence.mp3 fixture, retagged
 * via node-id3) into a temp staging dir, then runs the organizer and asserts
 * the resulting destination path.
 *
 * Regenerate the silence fixture with:
 *   ffmpeg -f lavfi -i 'anullsrc=channel_layout=mono:sample_rate=22050' \
 *     -t 0.1 -b:a 32k -id3v2_version 3 packages/api/test-fixtures/silence.mp3
 */
import { describe, expect, it, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  existsSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import nodeId3 from 'node-id3';
import { LibraryOrganizer } from './library-organizer.js';
import { ffmpegAvailable } from './transcode.js';

/** Generate a tagged FLAC via ffmpeg (lossless source for the transcode hook). */
function seedFlac(dir: string, relPath: string, tags: SeedTags): string {
  const dest = join(dir, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  const meta: string[] = [];
  if (tags.artist) meta.push('-metadata', `ARTIST=${tags.artist}`);
  if (tags.album) meta.push('-metadata', `ALBUM=${tags.album}`);
  if (tags.title) meta.push('-metadata', `TITLE=${tags.title}`);
  if (tags.trackNumber !== undefined) meta.push('-metadata', `track=${tags.trackNumber}`);
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=channel_layout=mono:sample_rate=22050',
      '-t',
      '0.3',
      '-c:a',
      'flac',
      ...meta,
      dest,
    ],
    { stdio: 'ignore' },
  );
  return dest;
}

const FIXTURE = fileURLToPath(new URL('../../test-fixtures/silence.mp3', import.meta.url));

interface SeedTags {
  artist?: string;
  album?: string;
  title?: string;
  albumArtist?: string;
  trackNumber?: number;
  compilation?: boolean;
}

function seed(dir: string, relPath: string, tags: SeedTags): string {
  const dest = join(dir, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(FIXTURE, dest);
  const id3: Record<string, string> = {};
  if (tags.artist) id3.artist = tags.artist;
  if (tags.album) id3.album = tags.album;
  if (tags.title) id3.title = tags.title;
  if (tags.albumArtist) id3.performerInfo = tags.albumArtist;
  if (tags.trackNumber !== undefined) id3.trackNumber = String(tags.trackNumber);
  if (tags.compilation) id3.partOfCompilation = '1';
  nodeId3.update(id3, dest);
  return dest;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpRoot() {
  // Some sandboxes export a TMPDIR that doesn't exist yet; mkdtempSync would ENOENT.
  mkdirSync(tmpdir(), { recursive: true });
  const root = mkdtempSync(join(tmpdir(), 'nicotind-org-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeOrg(musicDir: string, stagingDir?: string) {
  return new LibraryOrganizer({ musicDir, stagingDir });
}

describe('LibraryOrganizer (real fs)', () => {
  it('strips a featured-artist suffix from the artist folder name', async () => {
    const root = tmpRoot();
    const staging = join(root, '_staging');
    seed(staging, 'Daft Punk - Discovery/01 - Get Lucky.mp3', {
      artist: 'Daft Punk feat. Pharrell',
      album: 'Discovery',
      title: 'Get Lucky',
      trackNumber: 1,
    });
    const org = makeOrg(root, staging);
    const result = await org.organizeBatch([
      {
        username: 'u',
        directory: 'Daft Punk - Discovery',
        filename: '01 - Get Lucky.mp3',
        directoryFileCount: 1,
      },
    ]);
    expect(result.moved).toBe(1);
    expect(existsSync(join(root, 'Daft Punk', 'Discovery', '01 - Get Lucky.mp3'))).toBe(true);
    expect(existsSync(join(root, 'Daft Punk feat. Pharrell'))).toBe(false);
  });

  it('names a hunted album folder after the job canonical title, not the peer edition tag', async () => {
    const root = tmpRoot();
    const staging = join(root, '_staging');
    // Peer tagged this as a deluxe edition; the job knows the canonical album.
    seed(staging, 'Queen - Hot Space (Deluxe)/01 - Staying Power.mp3', {
      artist: 'Queen',
      album: 'Hot Space (Deluxe Remastered Version)',
      title: 'Staying Power',
      trackNumber: 1,
    });
    const org = new LibraryOrganizer({
      musicDir: root,
      stagingDir: staging,
      jobLookup: (dir) =>
        dir === 'Queen - Hot Space (Deluxe)' ? { artist: 'Queen', album: 'Hot Space' } : null,
    });
    const result = await org.organizeBatch([
      {
        username: 'u',
        directory: 'Queen - Hot Space (Deluxe)',
        filename: '01 - Staying Power.mp3',
        directoryFileCount: 1,
      },
    ]);
    expect(result.moved).toBe(1);
    expect(existsSync(join(root, 'Queen', 'Hot Space', '01 - Staying Power.mp3'))).toBe(true);
    expect(existsSync(join(root, 'Queen', 'Hot Space (Deluxe Remastered Version)'))).toBe(false);
  });

  it('consolidates two editions of one album (in a single batch) into one folder + dedupes', async () => {
    const root = tmpRoot();
    const staging = join(root, '_staging');
    // Base edition + a deluxe edition of the SAME album, different peer folders.
    // They share track 01 (a true duplicate) and the deluxe adds a bonus track.
    seed(staging, 'Lana Del Rey - Ultraviolence/01 - Cruel World.mp3', {
      artist: 'Lana Del Rey',
      album: 'Ultraviolence',
      title: 'Cruel World',
      trackNumber: 1,
    });
    seed(staging, 'Lana Del Rey - Ultraviolence (Deluxe)/01 - Cruel World.mp3', {
      artist: 'Lana Del Rey',
      album: 'Ultraviolence (Deluxe Edition)',
      title: 'Cruel World',
      trackNumber: 1,
    });
    seed(staging, 'Lana Del Rey - Ultraviolence (Deluxe)/02 - Florida Kilos.mp3', {
      artist: 'Lana Del Rey',
      album: 'Ultraviolence (Deluxe Edition)',
      title: 'Florida Kilos',
      trackNumber: 2,
    });
    const org = makeOrg(root, staging);
    const result = await org.organizeBatch([
      // Base edition first so it wins the canonical folder name.
      {
        username: 'u',
        directory: 'Lana Del Rey - Ultraviolence',
        filename: '01 - Cruel World.mp3',
        directoryFileCount: 1,
      },
      {
        username: 'u',
        directory: 'Lana Del Rey - Ultraviolence (Deluxe)',
        filename: '01 - Cruel World.mp3',
        directoryFileCount: 2,
      },
      {
        username: 'u',
        directory: 'Lana Del Rey - Ultraviolence (Deluxe)',
        filename: '02 - Florida Kilos.mp3',
        directoryFileCount: 2,
      },
    ]);
    const albumDir = join(root, 'Lana Del Rey', 'Ultraviolence');
    // Everything landed in ONE folder; the deluxe-named sibling was never created.
    expect(existsSync(join(root, 'Lana Del Rey', 'Ultraviolence (Deluxe Edition)'))).toBe(false);
    expect(existsSync(join(albumDir, '02 - Florida Kilos.mp3'))).toBe(true);
    // The duplicate track 01 was collapsed by the auto-dedupe pass — exactly one
    // copy survives (whichever pickKeeper chose), not both.
    const cruelWorldCopies = readdirSync(albumDir).filter((f) => /cruel world/i.test(f));
    expect(cruelWorldCopies.length).toBe(1);
    expect(result.dedupedBasenames.some((b) => /cruel world/i.test(b))).toBe(true);
  });

  it('folds a later-batch edition into a pre-existing album folder on disk', async () => {
    const root = tmpRoot();
    const staging = join(root, '_staging');
    // First batch: the base album lands normally.
    seed(staging, 'Lana Del Rey - Ultraviolence/01 - Cruel World.mp3', {
      artist: 'Lana Del Rey',
      album: 'Ultraviolence',
      title: 'Cruel World',
      trackNumber: 1,
    });
    const org = makeOrg(root, staging);
    await org.organizeBatch([
      {
        username: 'u',
        directory: 'Lana Del Rey - Ultraviolence',
        filename: '01 - Cruel World.mp3',
        directoryFileCount: 1,
      },
    ]);
    // Second batch (separate call → cache cleared): a JP deluxe edition arrives.
    seed(staging, 'Lana Del Rey - Ultraviolence (JP Deluxe Edition)/02 - Florida Kilos.mp3', {
      artist: 'Lana Del Rey',
      album: 'Ultraviolence (JP Deluxe Edition)',
      title: 'Florida Kilos',
      trackNumber: 2,
    });
    await org.organizeBatch([
      {
        username: 'u',
        directory: 'Lana Del Rey - Ultraviolence (JP Deluxe Edition)',
        filename: '02 - Florida Kilos.mp3',
        directoryFileCount: 1,
      },
    ]);
    const albumDir = join(root, 'Lana Del Rey', 'Ultraviolence');
    expect(existsSync(join(root, 'Lana Del Rey', 'Ultraviolence (JP Deluxe Edition)'))).toBe(false);
    expect(existsSync(join(albumDir, '01 - Cruel World.mp3'))).toBe(true);
    expect(existsSync(join(albumDir, '02 - Florida Kilos.mp3'))).toBe(true);
  });

  it('does NOT merge distinct titles like "Greatest Hits" vs "Greatest Hits II"', async () => {
    const root = tmpRoot();
    const staging = join(root, '_staging');
    seed(staging, 'Band - Greatest Hits/01 - A.mp3', {
      artist: 'Band',
      album: 'Greatest Hits',
      title: 'A',
      trackNumber: 1,
    });
    seed(staging, 'Band - Greatest Hits II/01 - B.mp3', {
      artist: 'Band',
      album: 'Greatest Hits II',
      title: 'B',
      trackNumber: 1,
    });
    const org = makeOrg(root, staging);
    await org.organizeBatch([
      {
        username: 'u',
        directory: 'Band - Greatest Hits',
        filename: '01 - A.mp3',
        directoryFileCount: 1,
      },
      {
        username: 'u',
        directory: 'Band - Greatest Hits II',
        filename: '01 - B.mp3',
        directoryFileCount: 1,
      },
    ]);
    expect(existsSync(join(root, 'Band', 'Greatest Hits', '01 - A.mp3'))).toBe(true);
    expect(existsSync(join(root, 'Band', 'Greatest Hits II', '01 - B.mp3'))).toBe(true);
  });

  it('preserves unicode characters in artist and album folders', async () => {
    const root = tmpRoot();
    const staging = join(root, '_staging');
    seed(staging, 'Sigur Ros/song.mp3', {
      artist: 'Sigur Rós',
      album: '( )',
      title: 'Untitled',
      trackNumber: 1,
    });
    const org = makeOrg(root, staging);
    await org.organizeBatch([
      { username: 'u', directory: 'Sigur Ros', filename: 'song.mp3', directoryFileCount: 1 },
    ]);
    expect(existsSync(join(root, 'Sigur Rós', '( )', '01 - Untitled.mp3'))).toBe(true);
  });

  it('replaces illegal filesystem chars in tags (AC/DC → "AC DC")', async () => {
    const root = tmpRoot();
    const staging = join(root, '_staging');
    seed(staging, 'AC-DC/bells.mp3', {
      artist: 'AC/DC',
      album: 'Back in Black',
      title: 'Hells Bells',
      trackNumber: 1,
    });
    const org = makeOrg(root, staging);
    await org.organizeBatch([
      { username: 'u', directory: 'AC-DC', filename: 'bells.mp3', directoryFileCount: 1 },
    ]);
    expect(existsSync(join(root, 'AC DC', 'Back in Black', '01 - Hells Bells.mp3'))).toBe(true);
  });

  it('strips trailing dots from path segments', async () => {
    const root = tmpRoot();
    const staging = join(root, '_staging');
    seed(staging, 'src/track.mp3', {
      artist: 'Artist.',
      album: 'Album.',
      title: 'Title.',
      trackNumber: 1,
    });
    const org = makeOrg(root, staging);
    await org.organizeBatch([
      { username: 'u', directory: 'src', filename: 'track.mp3', directoryFileCount: 1 },
    ]);
    expect(existsSync(join(root, 'Artist', 'Album', '01 - Title.mp3'))).toBe(true);
    expect(existsSync(join(root, 'Artist.'))).toBe(false);
  });

  it('routes missing-artist tracks to Unsorted/<sourceFolder>/', async () => {
    const root = tmpRoot();
    const staging = join(root, '_staging');
    seed(staging, 'Mystery Folder/orphan.mp3', { title: 'Orphan Track' });
    const org = makeOrg(root, staging);
    const result = await org.organizeBatch([
      { username: 'u', directory: 'Mystery Folder', filename: 'orphan.mp3', directoryFileCount: 1 },
    ]);
    expect(result.unsorted).toBe(1);
    expect(existsSync(join(root, 'Unsorted', 'Mystery Folder', 'Orphan Track.mp3'))).toBe(true);
  });

  it('routes artist+title without album into <Artist>/Singles/ when folder is generic', async () => {
    const root = tmpRoot();
    const staging = join(root, '_staging');
    seed(staging, 'src/single.mp3', { artist: 'Solo', title: 'Standalone' });
    const org = makeOrg(root, staging);
    await org.organizeBatch([
      { username: 'u', directory: 'src', filename: 'single.mp3', directoryFileCount: 1 },
    ]);
    expect(existsSync(join(root, 'Solo', 'Singles', 'Standalone.mp3'))).toBe(true);
  });

  it('uses the peer folder as album when artist+title are tagged but album tag is missing', async () => {
    const root = tmpRoot();
    const staging = join(root, '_staging');
    // Peer has the file in a well-named album subfolder but forgot to write the album tag.
    seed(staging, 'Pink Floyd - The Dark Side of the Moon/02 - Breathe.mp3', {
      artist: 'Pink Floyd',
      title: 'Breathe',
      trackNumber: 2,
    });
    const org = makeOrg(root, staging);
    await org.organizeBatch([
      {
        username: 'u',
        directory: 'Pink Floyd - The Dark Side of the Moon',
        filename: '02 - Breathe.mp3',
        directoryFileCount: 1,
      },
    ]);
    expect(
      existsSync(join(root, 'Pink Floyd', 'The Dark Side of the Moon', '02 - Breathe.mp3')),
    ).toBe(true);
    expect(existsSync(join(root, 'Pink Floyd', 'Singles'))).toBe(false);
  });

  it('routes a compilation (folder name + distinct artists, no album tags) to Various Artists/', async () => {
    const root = tmpRoot();
    const staging = join(root, '_staging');
    const peer = 'VA - Best of 2026';
    const artists = ['Artist A', 'Artist B', 'Artist C', 'Artist D', 'Artist E'];
    const files = artists.map((artist, i) => {
      const filename = `0${i + 1} - ${artist}.mp3`;
      // album omitted so CompilationTagger falls through "leave-alone" and matches the folder-name rule
      seed(staging, `${peer}/${filename}`, {
        artist,
        title: artist,
        trackNumber: i + 1,
      });
      return { username: 'u', directory: peer, filename, directoryFileCount: artists.length };
    });
    await makeOrg(root, staging).organizeBatch(files);
    for (let i = 0; i < artists.length; i++) {
      expect(existsSync(join(root, 'Various Artists', peer, `0${i + 1} - ${artists[i]}.mp3`))).toBe(
        true,
      );
    }
    for (const a of artists) {
      expect(existsSync(join(root, a))).toBe(false);
    }
  });

  it('appends "(2)" counter when two files collide at the same destination', async () => {
    const root = tmpRoot();
    const staging = join(root, '_staging');
    seed(staging, 'src/a.mp3', { artist: 'Dupe', album: 'Album', title: 'Same' });
    seed(staging, 'src/b.mp3', { artist: 'Dupe', album: 'Album', title: 'Same' });
    // autoDedupe off so we observe the raw uniquePath collision suffix; with it on
    // (the default) the "(2)" copy is intentionally reaped (see auto-dedupe tests).
    const org = new LibraryOrganizer({ musicDir: root, stagingDir: staging, autoDedupe: false });
    await org.organizeBatch([
      { username: 'u', directory: 'src', filename: 'a.mp3', directoryFileCount: 2 },
      { username: 'u', directory: 'src', filename: 'b.mp3', directoryFileCount: 2 },
    ]);
    expect(existsSync(join(root, 'Dupe', 'Album', 'Same.mp3'))).toBe(true);
    expect(existsSync(join(root, 'Dupe', 'Album', 'Same (2).mp3'))).toBe(true);
  });

  it('cleans a filename-shaped title even when the title tag is already set', async () => {
    const root = tmpRoot();
    const staging = join(root, '_staging');
    // Title tag is filename leak; artist + album already set.
    seed(staging, 'Babasonicos/01-Demasiado.mp3', {
      artist: 'Babasónicos',
      title: '01-Demasiado',
    });
    await makeOrg(root, staging).organizeBatch([
      {
        username: 'u',
        directory: 'Babasonicos',
        filename: '01-Demasiado.mp3',
        directoryFileCount: 1,
      },
    ]);
    const dest = join(root, 'Babasónicos', 'Singles', '01 - Demasiado.mp3');
    expect(existsSync(dest)).toBe(true);
    const tags = nodeId3.read(dest) as { title?: string; trackNumber?: string } | false;
    expect(tags && typeof tags === 'object' ? tags.title : undefined).toBe('Demasiado');
    expect(tags && typeof tags === 'object' ? tags.trackNumber : undefined).toBe('1');
  });

  it('writes an inferred title back to a file whose title tag is missing', async () => {
    const root = tmpRoot();
    const staging = join(root, '_staging');
    // No title tag in the seed; filename carries a track-prefix pattern (no space around dash).
    seed(staging, 'Babasonicos/01-Demasiado.mp3', { artist: 'Babasónicos' });
    await makeOrg(root, staging).organizeBatch([
      {
        username: 'u',
        directory: 'Babasonicos',
        filename: '01-Demasiado.mp3',
        directoryFileCount: 1,
      },
    ]);
    // Singles fallback: no album tag → file lands in <Artist>/Singles/, but the
    // album tag is left empty (no longer force-written to "Singles") so the
    // scanner turns it into its own single release named after the title.
    const dest = join(root, 'Babasónicos', 'Singles', '01 - Demasiado.mp3');
    expect(existsSync(dest)).toBe(true);
    const tags = nodeId3.read(dest) as { title?: string; album?: string } | false;
    expect(tags && typeof tags === 'object' ? tags.title : undefined).toBe('Demasiado');
    expect(tags && typeof tags === 'object' ? tags.album : undefined).toBeFalsy();
  });

  it('removes the source file from staging after a successful move', async () => {
    const root = tmpRoot();
    const staging = join(root, '_staging');
    const src = seed(staging, 'src/song.mp3', {
      artist: 'A',
      album: 'B',
      title: 'C',
      trackNumber: 1,
    });
    await makeOrg(root, staging).organizeBatch([
      { username: 'u', directory: 'src', filename: 'song.mp3', directoryFileCount: 1 },
    ]);
    expect(existsSync(src)).toBe(false);
    expect(existsSync(join(root, 'A', 'B', '01 - C.mp3'))).toBe(true);
  });

  describe('format-preference dedup (preferFlacSkipMp3)', () => {
    it('skips an incoming MP3 when a FLAC of the same track is already present', async () => {
      const root = tmpRoot();
      const staging = join(root, '_staging');
      // Existing FLAC (diacritics differ from the incoming MP3's accented title).
      mkdirSync(join(root, 'Soda Stereo', 'Canción Animal'), { recursive: true });
      writeFileSync(join(root, 'Soda Stereo', 'Canción Animal', '01 - Cancion Animal.flac'), 'x');

      const src = seed(staging, 'Soda Stereo - Cancion Animal/01 - Canción Animal.mp3', {
        artist: 'Soda Stereo',
        album: 'Canción Animal',
        title: 'Canción Animal',
        trackNumber: 1,
      });

      const org = new LibraryOrganizer({
        musicDir: root,
        stagingDir: staging,
        preferFlacSkipMp3: true,
      });
      const result = await org.organizeBatch([
        {
          username: 'u',
          directory: 'Soda Stereo - Cancion Animal',
          filename: '01 - Canción Animal.mp3',
          directoryFileCount: 1,
        },
      ]);

      expect(result.skipped).toBe(1);
      expect(result.moved).toBe(0);
      // Source MP3 removed; no MP3 landed next to the FLAC.
      expect(existsSync(src)).toBe(false);
      expect(
        existsSync(join(root, 'Soda Stereo', 'Canción Animal', '01 - Canción Animal.mp3')),
      ).toBe(false);
    });

    it('auto-dedupe drops a freshly-placed MP3 that collides with an existing FLAC', async () => {
      const root = tmpRoot();
      const staging = join(root, '_staging');
      // Existing FLAC of the track already in the album folder.
      mkdirSync(join(root, 'Lenny Kravitz', 'Circus'), { recursive: true });
      writeFileSync(join(root, 'Lenny Kravitz', 'Circus', '01 - Believe.flac'), 'x'.repeat(100));

      seed(staging, 'Lenny Kravitz - Circus/01 - Believe.mp3', {
        artist: 'Lenny Kravitz',
        album: 'Circus',
        title: 'Believe',
        trackNumber: 1,
      });

      // preferFlacSkipMp3 off, but autoDedupe (default on) cleans up the collision
      // after placement.
      const org = new LibraryOrganizer({ musicDir: root, stagingDir: staging });
      const result = await org.organizeBatch([
        {
          username: 'u',
          directory: 'Lenny Kravitz - Circus',
          filename: '01 - Believe.mp3',
          directoryFileCount: 1,
        },
      ]);

      expect(result.dedupedBasenames).toContain('01 - believe.mp3');
      expect(existsSync(join(root, 'Lenny Kravitz', 'Circus', '01 - Believe.flac'))).toBe(true);
      expect(existsSync(join(root, 'Lenny Kravitz', 'Circus', '01 - Believe.mp3'))).toBe(false);
    });

    it('keeps the MP3 when the preference is off (default)', async () => {
      const root = tmpRoot();
      const staging = join(root, '_staging');
      mkdirSync(join(root, 'Soda Stereo', 'Canción Animal'), { recursive: true });
      writeFileSync(join(root, 'Soda Stereo', 'Canción Animal', '01 - Cancion Animal.flac'), 'x');

      seed(staging, 'Soda Stereo - Cancion Animal/01 - Cancion Animal.mp3', {
        artist: 'Soda Stereo',
        album: 'Canción Animal',
        title: 'Canción Animal',
        trackNumber: 1,
      });

      // Both dedupe paths off → the MP3 is placed and kept alongside the FLAC.
      const org = new LibraryOrganizer({ musicDir: root, stagingDir: staging, autoDedupe: false });
      const result = await org.organizeBatch([
        {
          username: 'u',
          directory: 'Soda Stereo - Cancion Animal',
          filename: '01 - Cancion Animal.mp3',
          directoryFileCount: 1,
        },
      ]);

      expect(result.moved).toBe(1);
      expect(
        existsSync(join(root, 'Soda Stereo', 'Canción Animal', '01 - Canción Animal.mp3')),
      ).toBe(true);
    });
  });

  describe('reconcileTouched', () => {
    it('deletes a cross-name duplicate and reports rel path + album dir', async () => {
      const music = tmpRoot();
      const albumDir = join(music, 'Britney Spears', 'Circus');
      mkdirSync(albumDir, { recursive: true });
      // Two MP3s with the same ID3 title but different filenames — dedupeFolder (filename-only)
      // would MISS this; reconcileTouched uses tag-aware reconcileAlbumFolder.
      seed(albumDir, '02 - Circus.mp3', {
        title: 'Circus',
        artist: 'Britney Spears',
        album: 'Circus',
        trackNumber: 2,
      });
      seed(albumDir, 'circus_radio.mp3', {
        title: 'Circus',
        artist: 'Britney Spears',
        album: 'Circus',
      });
      const org = new LibraryOrganizer({ musicDir: music, autoDedupe: true });
      const res = await org.reconcileTouched([albumDir], () => null);
      // One copy removed (lexicographic tiebreak keeps '02 - Circus.mp3')
      expect(res.deletedRelPaths.length).toBe(1);
      expect(res.affectedAlbumDirs).toContain(albumDir);
    });
  });

  describe('lossless → opus transcode hook', () => {
    it.skipIf(!ffmpegAvailable())(
      'transcodes a lossless download to opus in place when enabled',
      async () => {
        const root = tmpRoot();
        const staging = join(root, '_staging');
        seedFlac(staging, 'Boards of Canada - Geogaddi/01 - Music Is Math.flac', {
          artist: 'Boards of Canada',
          album: 'Geogaddi',
          title: 'Music Is Math',
          trackNumber: 1,
        });
        const org = new LibraryOrganizer({
          musicDir: root,
          stagingDir: staging,
          transcodeLossless: { enabled: true, bitRate: 96 },
        });
        const result = await org.organizeBatch([
          {
            username: 'u',
            directory: 'Boards of Canada - Geogaddi',
            filename: '01 - Music Is Math.flac',
            directoryFileCount: 1,
          },
        ]);

        expect(result.moved).toBe(1);
        const opus = join(root, 'Boards of Canada', 'Geogaddi', '01 - Music Is Math.opus');
        expect(existsSync(opus)).toBe(true);
        // The lossless original is gone (replaced in place).
        expect(
          existsSync(join(root, 'Boards of Canada', 'Geogaddi', '01 - Music Is Math.flac')),
        ).toBe(false);
      },
    );

    it.skipIf(!ffmpegAvailable())('leaves lossless untouched when the hook is disabled', async () => {
      const root = tmpRoot();
      const staging = join(root, '_staging');
      seedFlac(staging, 'Boards of Canada - Geogaddi/01 - Music Is Math.flac', {
        artist: 'Boards of Canada',
        album: 'Geogaddi',
        title: 'Music Is Math',
        trackNumber: 1,
      });
      const org = new LibraryOrganizer({ musicDir: root, stagingDir: staging });
      const result = await org.organizeBatch([
        {
          username: 'u',
          directory: 'Boards of Canada - Geogaddi',
          filename: '01 - Music Is Math.flac',
          directoryFileCount: 1,
        },
      ]);

      expect(result.moved).toBe(1);
      expect(
        existsSync(join(root, 'Boards of Canada', 'Geogaddi', '01 - Music Is Math.flac')),
      ).toBe(true);
      expect(
        existsSync(join(root, 'Boards of Canada', 'Geogaddi', '01 - Music Is Math.opus')),
      ).toBe(false);
    });
  });
});
