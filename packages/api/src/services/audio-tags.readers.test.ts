/**
 * Two readers, one mp3 (issue #964).
 *
 * `readAudioTags` parses an mp3 with **node-id3**; the scanner parses the same
 * file with **music-metadata** (`parseTrack` → `mm.parseFile`). Every
 * post-write verification in the repo compares one side against the other —
 * `readOnDiskConfirmation` audits the file with node-id3 and the row it
 * disagrees with came from music-metadata — so a library-level disagreement
 * produces exactly the reported "the write vanished" divergence on a perfectly
 * good write, with no bug anywhere in the write path.
 *
 * This is the measurement: same file, both readers, field by field. Every shape
 * NicotinD itself produces must agree; where the two libraries genuinely differ
 * the divergence is pinned with its issue number, so closing that issue fails
 * this file rather than quietly making it a lie.
 */
import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAudioTags, writeAudioTags, type AudioTags } from './audio-tags.js';
import { ffmpegAvailable } from './transcode.js';

const FIXTURE = join(import.meta.dir, '../../test-fixtures/silence.mp3');

/** The fields BOTH readers map, projected onto one comparable shape. */
interface Common {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  track?: number;
  disc?: number;
  year?: number;
  bpm?: number;
  genre?: string;
}

const fromNodeId3 = (t: AudioTags): Common => ({
  title: t.title,
  artist: t.artist,
  albumArtist: t.albumArtist,
  album: t.album,
  track: t.trackNumber,
  disc: t.discNumber,
  year: t.year,
  bpm: t.bpm,
  genre: t.genre,
});

async function fromMusicMetadata(path: string): Promise<Common> {
  const mm = (await import('music-metadata')) as unknown as {
    parseFile: (
      p: string,
      o?: { duration?: boolean },
    ) => Promise<{
      common: {
        title?: string;
        artist?: string;
        albumartist?: string;
        album?: string;
        track?: { no?: number | null };
        disk?: { no?: number | null };
        year?: number;
        bpm?: number;
        genre?: string[];
      };
    }>;
  };
  const c = (await mm.parseFile(path, { duration: false })).common;
  return {
    title: c.title,
    artist: c.artist,
    albumArtist: c.albumartist,
    album: c.album,
    track: c.track?.no ?? undefined,
    disc: c.disk?.no ?? undefined,
    year: c.year,
    bpm: c.bpm,
    // `pickGenre`'s own contract: one entry per frame, joined on `; `.
    genre: c.genre?.length ? c.genre.join('; ') : undefined,
  };
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nicotind-readers-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A copy of the repo's mp3 fixture, optionally re-muxed with ffmpeg. */
function fixture(name: string, ffmpegArgs?: string[]): string {
  const out = join(dir, name);
  if (!ffmpegArgs) {
    copyFileSync(FIXTURE, out);
    return out;
  }
  const r = spawnSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    FIXTURE,
    '-c',
    'copy',
    ...ffmpegArgs,
    '-f',
    'mp3',
    out,
  ]);
  expect(r.status).toBe(0);
  return out;
}

const EXTERNAL_TAGS = [
  '-metadata',
  'title=Ojos Así',
  '-metadata',
  'artist=Shakira',
  '-metadata',
  'album_artist=Shakira',
  '-metadata',
  'album=MTV Unplugged',
  '-metadata',
  'track=7',
  '-metadata',
  'date=1999',
  '-metadata',
  'genre=Latin Pop',
];

describe('readAudioTags and the scanner read the same mp3 the same way (#964)', () => {
  it('agrees on an untagged file', async () => {
    const f = fixture('bare.mp3');
    expect(fromNodeId3(await readAudioTags(f))).toEqual(await fromMusicMetadata(f));
  });

  it('agrees on the tag shape NicotinD itself writes', async () => {
    const f = fixture('written.mp3');
    expect(
      await writeAudioTags(f, {
        title: 'Ojos Así',
        artist: 'Shakira',
        albumArtist: 'Shakira',
        album: 'MTV Unplugged',
        trackNumber: 7,
        discNumber: 1,
        year: 1999,
        bpm: 108,
        genre: 'Latin Pop; Rock en Español',
      }),
    ).toBe(true);
    const viaId3 = fromNodeId3(await readAudioTags(f));
    expect(viaId3).toEqual(await fromMusicMetadata(f));
    // Not a vacuous agreement between two empty reads.
    expect(viaId3.title).toBe('Ojos Así');
    expect(viaId3.year).toBe(1999);
    expect(viaId3.bpm).toBe(108);
    expect(viaId3.disc).toBe(1);
    expect(viaId3.genre).toBe('Latin Pop; Rock en Español');
  });

  it.if(ffmpegAvailable())('agrees on an externally written ID3v2.3 file', async () => {
    const f = fixture('v23.mp3', ['-id3v2_version', '3', ...EXTERNAL_TAGS]);
    const viaId3 = fromNodeId3(await readAudioTags(f));
    expect(viaId3).toEqual(await fromMusicMetadata(f));
    expect(viaId3.year).toBe(1999);
  });

  it.if(ffmpegAvailable())(
    'agrees on what the container-rewrite fallback leaves behind',
    async () => {
      // The fallback's own output is the one shape this repo now creates with
      // ffmpeg on mp3; if the two readers disagreed about it, the repair would
      // manufacture the divergence it exists to fix.
      const f = fixture('rewritten.mp3', ['-map_metadata', '0', ...EXTERNAL_TAGS]);
      await writeAudioTags(
        f,
        { title: 'Ojos Así' },
        { readTags: async () => ({ title: 'stale' }) },
      );
      const viaId3 = fromNodeId3(await readAudioTags(f));
      expect(viaId3).toEqual(await fromMusicMetadata(f));
      expect(viaId3).toMatchObject({ title: 'Ojos Así', artist: 'Shakira', track: 7, year: 1999 });
    },
  );
});

/**
 * The divergences the measurement found, now closed (#1151). Each used to be a
 * write `readAudioTags` could not read back while music-metadata — the reader
 * the SCANNER uses — could, so the row and the file audit disagreed with no
 * fault in the write path. These assertions were inverted rather than deleted:
 * they are the regression tests for the three frames.
 */
describe('the frames that used to be write-only on mp3 (#1151)', () => {
  it.if(ffmpegAvailable())('reads an ID3v2.4 year (TDRC)', async () => {
    // node-id3 surfaces TDRC as `recordingTime`; the reader used to map only
    // `year` (TYER, ID3v2.3). ffmpeg's mp3 muxer defaults to v2.4, so this is
    // the shape most foreign taggers produce.
    const f = fixture('v24.mp3', ['-id3v2_version', '4', ...EXTERNAL_TAGS]);
    expect((await readAudioTags(f)).year).toBe(1999);
    expect(fromNodeId3(await readAudioTags(f))).toEqual(await fromMusicMetadata(f));
  });

  it('reads back bpm and discNumber', async () => {
    // `writeId3Tags` emits TBPM/TPOS. The BPM endpoint and analyze-bpm.ts both
    // prefer a file's own BPM tag over a DSP run, so while this was unmapped
    // that preference could never fire on an mp3.
    const f = fixture('numbers.mp3');
    expect(await writeAudioTags(f, { bpm: 128, discNumber: 2, key: 'Am' })).toBe(true);
    const viaId3 = await readAudioTags(f);
    expect(viaId3.bpm).toBe(128);
    expect(viaId3.discNumber).toBe(2);
    // `key` is the control: TKEY was always mapped, so a regression here would
    // be per-field rather than the whole ID3 read path going dark.
    expect(viaId3.key).toBe('Am');
    expect(fromNodeId3(viaId3)).toEqual(await fromMusicMetadata(f));
  });

  it.if(ffmpegAvailable())('prefers TYER over a stale TDRC left behind by a rewrite', async () => {
    // node-id3's `update` downgrades the header to v2.3 and writes TYER while
    // LEAVING the v2.4 TDRC frame in place, so a retagged file carries both.
    // TDRC is then the older value, and reading it would silently revert a
    // correction the curator just made.
    const f = fixture('both-year-frames.mp3', ['-id3v2_version', '4', ...EXTERNAL_TAGS]);
    expect(await writeAudioTags(f, { year: 2007 })).toBe(true);
    expect((await readAudioTags(f)).year).toBe(2007);
  });

  it.if(ffmpegAvailable())('reads a disc number written as "2/3"', async () => {
    // TPOS carries a position/total pair at least as often as a bare number,
    // and a foreign tagger is where that shape comes from.
    const f = fixture('discpair.mp3', ['-id3v2_version', '3', '-metadata', 'disc=2/3']);
    expect((await readAudioTags(f)).discNumber).toBe(2);
    // The total is what tells disc 1 of a set from a single-disc album (#747).
    expect((await readAudioTags(f)).discTotal).toBe(3);
  });
});
