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
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import nodeId3 from 'node-id3';
import { LibraryOrganizer } from './library-organizer.js';

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
      { username: 'u', directory: 'Daft Punk - Discovery', filename: '01 - Get Lucky.mp3', directoryFileCount: 1 },
    ]);
    expect(result.moved).toBe(1);
    expect(existsSync(join(root, 'Daft Punk', 'Discovery', '01 - Get Lucky.mp3'))).toBe(true);
    expect(existsSync(join(root, 'Daft Punk feat. Pharrell'))).toBe(false);
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
    expect(existsSync(join(root, 'Pink Floyd', 'The Dark Side of the Moon', '02 - Breathe.mp3'))).toBe(true);
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
      expect(existsSync(join(root, 'Various Artists', peer, `0${i + 1} - ${artists[i]}.mp3`))).toBe(true);
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
    const org = makeOrg(root, staging);
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
      { username: 'u', directory: 'Babasonicos', filename: '01-Demasiado.mp3', directoryFileCount: 1 },
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
      { username: 'u', directory: 'Babasonicos', filename: '01-Demasiado.mp3', directoryFileCount: 1 },
    ]);
    // Singles fallback: no album tag → <Artist>/Singles/
    const dest = join(root, 'Babasónicos', 'Singles', '01 - Demasiado.mp3');
    expect(existsSync(dest)).toBe(true);
    const tags = nodeId3.read(dest) as { title?: string; album?: string } | false;
    expect(tags && typeof tags === 'object' ? tags.title : undefined).toBe('Demasiado');
    expect(tags && typeof tags === 'object' ? tags.album : undefined).toBe('Singles');
  });

  it('removes the source file from staging after a successful move', async () => {
    const root = tmpRoot();
    const staging = join(root, '_staging');
    const src = seed(staging, 'src/song.mp3', { artist: 'A', album: 'B', title: 'C', trackNumber: 1 });
    await makeOrg(root, staging).organizeBatch([
      { username: 'u', directory: 'src', filename: 'song.mp3', directoryFileCount: 1 },
    ]);
    expect(existsSync(src)).toBe(false);
    expect(existsSync(join(root, 'A', 'B', '01 - C.mp3'))).toBe(true);
  });
});
