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
  year?: number;
  genre?: string;
}

const fromNodeId3 = (t: AudioTags): Common => ({
  title: t.title,
  artist: t.artist,
  albumArtist: t.albumArtist,
  album: t.album,
  track: t.trackNumber,
  year: t.year,
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
        year?: number;
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
    year: c.year,
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
        year: 1999,
        genre: 'Latin Pop; Rock en Español',
      }),
    ).toBe(true);
    const viaId3 = fromNodeId3(await readAudioTags(f));
    expect(viaId3).toEqual(await fromMusicMetadata(f));
    // Not a vacuous agreement between two empty reads.
    expect(viaId3.title).toBe('Ojos Así');
    expect(viaId3.year).toBe(1999);
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
 * The divergences the measurement found. Each is a write `readAudioTags` cannot
 * read back while music-metadata — the reader the SCANNER uses — can, so the
 * row and the file audit disagree with no fault in the write path. Filed as
 * issue #1151; these assertions state today's truth and must be inverted, not
 * deleted, when it closes.
 */
describe('known reader disagreements on mp3 (#1151)', () => {
  it.if(ffmpegAvailable())('an ID3v2.4 year is invisible to readAudioTags', async () => {
    // node-id3 surfaces TDRC as `recordingTime`; the reader only maps `year`
    // (TYER, ID3v2.3). ffmpeg's mp3 muxer defaults to v2.4, so this is the
    // shape most foreign taggers produce.
    const f = fixture('v24.mp3', ['-id3v2_version', '4', ...EXTERNAL_TAGS]);
    expect((await readAudioTags(f)).year).toBeUndefined();
    expect((await fromMusicMetadata(f)).year).toBe(1999);
  });

  it('bpm and discNumber are written and never read back', async () => {
    // `writeId3Tags` emits TBPM/TPOS; the ID3 read branch maps neither. The BPM
    // endpoint and analyze-bpm.ts both prefer a file's own BPM tag over a DSP
    // run, so on mp3 that preference can never fire.
    const f = fixture('numbers.mp3');
    expect(await writeAudioTags(f, { bpm: 128, discNumber: 2, key: 'Am' })).toBe(true);
    const viaId3 = await readAudioTags(f);
    expect(viaId3.bpm).toBeUndefined();
    expect(viaId3.discNumber).toBeUndefined();
    // `key` is the control: TKEY is mapped, so the gap is per-field, not the
    // whole ID3 read path.
    expect(viaId3.key).toBe('Am');
  });
});
