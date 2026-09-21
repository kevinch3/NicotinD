/**
 * Round-trips lyrics (and a sibling genre tag) through the ID3 path on a real
 * MP3 fixture via node-id3 — no ffmpeg needed. Guards the USLT write/read added
 * for the on-demand lyrics feature. The Vorbis/Opus round-trip below IS
 * ffmpeg-gated (skipped where ffmpeg is absent; CI runners have it).
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  copyFileSync,
  rmSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  featureTagsFromNative,
  readAudioTags,
  writeAudioTags,
  readMusicBrainzUfid,
} from './audio-tags.js';
import { ffmpegAvailable } from './transcode.js';

const FIXTURE = join(import.meta.dir, '../../test-fixtures/silence.mp3');

let dir: string;
let mp3: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nicotind-tags-'));
  mp3 = join(dir, 'track.mp3');
  copyFileSync(FIXTURE, mp3);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('audio-tags lyrics (ID3 USLT)', () => {
  it('writes and reads back plain lyrics', async () => {
    const lyrics = 'first line\nsecond line';
    expect(await writeAudioTags(mp3, { lyrics })).toBe(true);
    const tags = await readAudioTags(mp3);
    expect(tags.lyrics).toBe(lyrics);
  });

  it('preserves existing lyrics when a later write omits them', async () => {
    await writeAudioTags(mp3, { lyrics: 'keep me' });
    // node-id3 merges over existing tags, so an unrelated write keeps the USLT.
    await writeAudioTags(mp3, { genre: 'Rock' });
    const tags = await readAudioTags(mp3);
    expect(tags.lyrics).toBe('keep me');
  });
});

describe('audio-tags perceptual features (ID3 TXXX)', () => {
  it('round-trips all seven feature tags through the mp3 path', async () => {
    expect(
      await writeAudioTags(mp3, {
        energy: 0.72,
        loudness: -9.3,
        valence: 0.41,
        danceability: 0.88,
        acousticness: 0.05,
        instrumental: 0.97,
        mood: 'party',
      }),
    ).toBe(true);
    const tags = await readAudioTags(mp3);
    expect(tags.energy).toBeCloseTo(0.72, 3);
    expect(tags.loudness).toBeCloseTo(-9.3, 1);
    expect(tags.valence).toBeCloseTo(0.41, 3);
    expect(tags.danceability).toBeCloseTo(0.88, 3);
    expect(tags.acousticness).toBeCloseTo(0.05, 3);
    expect(tags.instrumental).toBeCloseTo(0.97, 3);
    expect(tags.mood).toBe('party');
  });

  it('rejects a mood outside the vocabulary on read', async () => {
    await writeAudioTags(mp3, { mood: 'party' });
    // Simulate a foreign tool writing a free-text mood by writing it raw.
    const { default: nodeId3 } = (await import('node-id3')) as unknown as {
      default: { update: (t: object, f: string) => boolean };
    };
    nodeId3.update({ userDefinedText: [{ description: 'MOOD', value: 'euphoric-gabber' }] }, mp3);
    const tags = await readAudioTags(mp3);
    expect(tags.mood).toBeUndefined();
  });
});

// Regression guard for the silent Vorbis-write failure: the ffmpeg tmp output
// ends in `.nicotind.tmp`, so without an explicit `-f <muxer>` EVERY
// Opus/FLAC/ogg tag write failed ("Unable to choose an output format") and the
// catch-all returned false — masked by the COALESCE durability contract.
describe.if(ffmpegAvailable())('audio-tags perceptual features (Opus/Vorbis round-trip)', () => {
  it('writes and reads back feature tags on a real opus file', async () => {
    const opus = join(dir, 'track.opus');
    const gen = spawnSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '1',
      '-c:a',
      'libopus',
      opus,
    ]);
    expect(gen.status).toBe(0);

    expect(
      await writeAudioTags(opus, {
        energy: 0.42,
        loudness: -12.5,
        mood: 'happy',
        valence: 0.61,
        danceability: 0.3,
        acousticness: 0.9,
        instrumental: 1,
      }),
    ).toBe(true);
    const tags = await readAudioTags(opus);
    expect(tags.energy).toBeCloseTo(0.42, 3);
    expect(tags.loudness).toBeCloseTo(-12.5, 1);
    expect(tags.mood).toBe('happy');
    expect(tags.valence).toBeCloseTo(0.61, 3);
    expect(tags.danceability).toBeCloseTo(0.3, 3);
    expect(tags.acousticness).toBeCloseTo(0.9, 3);
    expect(tags.instrumental).toBe(1);
  });

  it('classic tags (bpm/key/genre) also round-trip on opus', async () => {
    const opus = join(dir, 'classic.opus');
    spawnSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:sample_rate=48000',
      '-t',
      '1',
      '-c:a',
      'libopus',
      opus,
    ]);
    expect(await writeAudioTags(opus, { bpm: 128, key: 'A minor', genre: 'Techno' })).toBe(true);
    const tags = await readAudioTags(opus);
    expect(tags.key).toBe('A minor');
    // Issue #791: this test was named for genre while deliberately not
    // asserting it, because the reader never mapped the field both writers set.
    expect(tags.genre).toBe('Techno');
  });
});

/**
 * Issue #791: `AudioTags.genre` is declared and set by BOTH write paths, but
 * neither read branch mapped it back — so `readAudioTags(f).genre` was
 * `undefined` on a file that demonstrably carries the tag. A write-only field
 * on a symmetric read/write API hands the next caller a silent `undefined`
 * instead of an error.
 *
 * These assert through `readAudioTags` deliberately, never through
 * `ffprobe -show_entries format_tags`: on an Ogg container the Vorbis comment
 * lives in the STREAM, so that probe reports nothing for a correctly-tagged
 * file. Verifying a tag with the wrong scope is what produced a whole false
 * bug report (#790).
 */
describe.if(ffmpegAvailable())('genre round-trips through readAudioTags (#791)', () => {
  it('reads back a genre written to mp3', async () => {
    expect(await writeAudioTags(mp3, { genre: 'Cumbia Pop' })).toBe(true);
    expect((await readAudioTags(mp3)).genre).toBe('Cumbia Pop');
  });

  for (const ext of ['opus', 'ogg', 'flac'] as const) {
    it(`reads back a genre written to ${ext}`, async () => {
      const codec = { opus: 'libopus', ogg: 'libvorbis', flac: 'flac' }[ext];
      const path = join(dir, `genre.${ext}`);
      spawnSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=220:sample_rate=48000',
        '-t',
        '1',
        '-c:a',
        codec,
        path,
      ]);
      expect(await writeAudioTags(path, { genre: 'Flamenco Pop' })).toBe(true);
      expect((await readAudioTags(path)).genre).toBe('Flamenco Pop');
    });
  }

  it('overwrites an existing genre rather than keeping the old one', async () => {
    const path = join(dir, 'regenre.opus');
    spawnSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:sample_rate=48000',
      '-t',
      '1',
      '-c:a',
      'libopus',
      '-metadata',
      'GENRE=Wrong',
      '-metadata:s:a:0',
      'GENRE=Wrong',
      path,
    ]);
    expect((await readAudioTags(path)).genre).toBe('Wrong');
    expect(await writeAudioTags(path, { genre: 'Right' })).toBe(true);
    expect((await readAudioTags(path)).genre).toBe('Right');
  });
});

/**
 * Issue #760: a retag silently did nothing on `.opus`.
 *
 * On Ogg containers, Vorbis comments live in the **stream**, and `-metadata`
 * writes *global* metadata. The muxer merges global into the comment header
 * only where the stream has no value for that key — so a write lands on a
 * tagless file and is silently discarded on one that already carries the tag,
 * because `-c copy` brings the old comment along and it wins.
 *
 * The round-trip tests above never caught it because they generate their
 * fixture with NO metadata, which is the one input shape where the bug cannot
 * appear. Retagging is by definition the other shape. Every fixture here
 * therefore starts *already tagged* — that is the premise under test.
 *
 * The blast radius was the whole tag-writing surface (~19 call sites: BPM, key,
 * energy, genre, lyrics, the organizer's ingest tagging, `fix_song_metadata`),
 * on a library that transcodes lossless to Opus by default.
 */
describe.if(ffmpegAvailable())('overwriting an existing tag (#760)', () => {
  /**
   * A one-second file of `ext`, already carrying TITLE/ARTIST/ALBUM/album artist.
   *
   * The album artist is generated under ffmpeg's generic `album_artist` key, not
   * the Vorbis `ALBUMARTIST` — the ipod muxer only knows the generic one, so the
   * Vorbis spelling would leave the `.m4a` fixture tagless and the assertion
   * vacuous on the container where the write never worked at all (issue #914).
   */
  function tagged(ext: string, name: string): string {
    const codec = { opus: 'libopus', ogg: 'libvorbis', flac: 'flac', m4a: 'aac' }[ext]!;
    const path = join(dir, `${name}.${ext}`);
    const gen = spawnSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '1',
      '-c:a',
      codec,
      '-metadata',
      'TITLE=OLD TITLE',
      '-metadata',
      'ARTIST=OLD ARTIST',
      '-metadata',
      'ALBUM=OLD ALBUM',
      '-metadata',
      'album_artist=OLD ALBUM ARTIST',
      path,
    ]);
    expect(gen.status).toBe(0);
    return path;
  }

  for (const ext of ['opus', 'ogg', 'flac', 'm4a']) {
    it(`replaces an existing title/artist/album/album artist on .${ext}`, async () => {
      const path = tagged(ext, `retag-${ext}`);
      expect(
        await writeAudioTags(path, {
          title: 'NEW TITLE',
          artist: 'NEW ARTIST',
          album: 'NEW ALBUM',
          albumArtist: 'NEW ALBUM ARTIST',
        }),
      ).toBe(true);
      const tags = await readAudioTags(path);
      expect(tags.title).toBe('NEW TITLE');
      expect(tags.artist).toBe('NEW ARTIST');
      expect(tags.album).toBe('NEW ALBUM');
      expect(tags.albumArtist).toBe('NEW ALBUM ARTIST');

      // Retagging a retag: a key written under a name ffmpeg does not recognise
      // lands *beside* its own old value instead of replacing it, and the pair
      // then concatenates on the next pass (issue #914).
      expect(await writeAudioTags(path, { albumArtist: 'NEWER ALBUM ARTIST' })).toBe(true);
      expect((await readAudioTags(path)).albumArtist).toBe('NEWER ALBUM ARTIST');
    });

    // `writeFfmpegTags` has always emitted DISC and BPM here; until #1151 no
    // read branch mapped either, so both were write-only on this family too —
    // the same asymmetry the mp3 side carried, one container over.
    it(`reads back disc and bpm on .${ext} (#1151)`, async () => {
      const path = tagged(ext, `numbers-${ext}`);
      expect(await writeAudioTags(path, { discNumber: 2, bpm: 128 })).toBe(true);
      const tags = await readAudioTags(path);
      expect(tags.discNumber).toBe(2);
      if (ext === 'm4a') {
        // Measured, not assumed: the file carries `disk` and NO tempo atom at
        // all, so this one is a WRITE gap, not the read gap #1151 closed.
        // ffmpeg's mov muxer ignores `-metadata BPM=`; the key it maps to the
        // tempo atom is `tmpo`. Filed as #1177 — invert this branch there.
        expect(tags.bpm).toBeUndefined();
      } else {
        expect(tags.bpm).toBe(128);
      }
    });
  }

  /**
   * Prod's actual file: `CD A 2000.opus`, whose scrambled title matched its
   * filename — so when the write vanished, the scanner's filename fallback
   * refilled the same wrong value and the revert looked like a scanner bug.
   */
  it('persists a retag on an opus whose filename matches its old title', async () => {
    const path = join(dir, 'CD A 2000.opus');
    spawnSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '1',
      '-c:a',
      'libopus',
      '-metadata',
      'TITLE=CD A 2000',
      '-metadata',
      'ALBUM=CD A 2000',
      path,
    ]);
    expect(await writeAudioTags(path, { title: 'El Aprendiz', album: 'Soy Cordobés' })).toBe(true);
    const tags = await readAudioTags(path);
    expect(tags.title).toBe('El Aprendiz');
    expect(tags.album).toBe('Soy Cordobés');
  });

  /** A partial write must not blank the fields it was not asked to change. */
  it('leaves untouched fields alone on opus', async () => {
    const path = tagged('opus', 'partial');
    expect(await writeAudioTags(path, { title: 'ONLY TITLE' })).toBe(true);
    const tags = await readAudioTags(path);
    expect(tags.title).toBe('ONLY TITLE');
    expect(tags.artist).toBe('OLD ARTIST');
    expect(tags.album).toBe('OLD ALBUM');
  });
});

/**
 * `compilation` is a Vorbis/m4a-only field: the ID3 path deliberately does not
 * claim it, because node-id3 0.2.9 has no `TCMP` frame and both dead halves
 * were removed rather than pretended (issue #917).
 *
 * This round-trip is load-bearing, not cosmetic. `library-organizer.ts` guards
 * its tag rewrite with `if (folderTags.compilation && !currentRaw.compilation)`
 * and documents the step as running "idempotently". While this branch returned
 * no `compilation` at all the guard was permanently true, so every organize
 * pass re-wrote COMPILATION=1 — and on this family a tag write is a full ffmpeg
 * remux of the user's audio file (issue #916). Opus is what the library
 * transcodes everything into.
 */
describe.if(ffmpegAvailable())('compilation flag round-trip (Vorbis/Opus)', () => {
  const genOpus = (name: string): string => {
    const out = join(dir, name);
    const gen = spawnSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '1',
      '-c:a',
      'libopus',
      out,
    ]);
    expect(gen.status).toBe(0);
    return out;
  };

  it('reads back a compilation flag written to opus', async () => {
    const opus = genOpus('comp.opus');
    expect(await writeAudioTags(opus, { compilation: true })).toBe(true);
    expect((await readAudioTags(opus)).compilation).toBe(true);
  });

  it('reports a non-compilation opus as not a compilation', async () => {
    // The guard must distinguish "no flag" from "flag set"; if this returned
    // `true` the organizer would stop tagging real compilations.
    expect((await readAudioTags(genOpus('plain.opus'))).compilation).toBeFalsy();
  });

  // Deliberately no mp3 case here: ID3 compilation support was removed in #932
  // (issue #917), not left broken. `library-organizer.test.ts` covers the mp3 side.
});

/**
 * Issue #964: node-id3's in-place merge reports success on a write it did not
 * land, so `writeAudioTags` believes an mp3 write only where the file reads it
 * back — and falls through to the container rewrite when it does not. The
 * failure returned TRUE, so nothing keyed on the boolean can see this class.
 */
describe.if(ffmpegAvailable())('mp3 container-rewrite fallback (#964)', () => {
  let ffmpegLog: string;
  let prevFfmpeg: string | undefined;

  /** An ffmpeg that records its argv, so "did not spawn" is observable. */
  const recordingFfmpeg = (realBinary = 'ffmpeg'): string => {
    const wrapper = join(dir, 'ffmpeg-wrapper.sh');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ffmpegLog}'\nexec ${realBinary} "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    return wrapper;
  };
  const spawns = (): string[] =>
    existsSync(ffmpegLog) ? readFileSync(ffmpegLog, 'utf8').trim().split('\n').filter(Boolean) : [];

  beforeEach(() => {
    ffmpegLog = join(dir, 'ffmpeg.log');
    prevFfmpeg = process.env.NICOTIND_FFMPEG_PATH;
    process.env.NICOTIND_FFMPEG_PATH = recordingFfmpeg();
  });
  afterEach(() => {
    if (prevFfmpeg === undefined) delete process.env.NICOTIND_FFMPEG_PATH;
    else process.env.NICOTIND_FFMPEG_PATH = prevFfmpeg;
  });

  it('never reaches ffmpeg when the in-place write sticks', async () => {
    expect(
      await writeAudioTags(mp3, {
        title: 'T',
        artist: 'A',
        album: 'Al',
        albumArtist: 'AA',
        genre: 'Cumbia; Pop',
        key: 'Am',
        year: 2001,
        trackNumber: 5,
        lyrics: 'L1',
        energy: 0.72,
        mbRecordingId: 'mbr',
      }),
    ).toBe(true);
    expect(spawns()).toEqual([]);
    expect((await readAudioTags(mp3)).title).toBe('T');
  });

  it('does not rewrite for a field the reader cannot see', async () => {
    // TBPM and TPOS are written and never read back, so comparing them would
    // remux every BPM/disc write forever.
    expect(await writeAudioTags(mp3, { bpm: 128, discNumber: 2 })).toBe(true);
    expect(spawns()).toEqual([]);
  });

  it('rewrites the container when the read-back still shows the old value', async () => {
    await writeAudioTags(mp3, { title: 'OLD TITLE' });
    // The reported class: node-id3 returns true, the file still reads old.
    expect(
      await writeAudioTags(
        mp3,
        { title: 'NEW TITLE' },
        { readTags: async () => ({ title: 'OLD TITLE' }) },
      ),
    ).toBe(true);
    expect(spawns()).toHaveLength(1);
    expect(spawns()[0]).toContain('-map_metadata 0');
    // ID3v2.4 carries a year as TDRC, which node-id3 maps to `recordingTime`
    // and `readAudioTags` therefore never sees.
    expect(spawns()[0]).toContain('-id3v2_version 3');
    expect((await readAudioTags(mp3)).title).toBe('NEW TITLE');
  });

  it('preserves the TXXX feature frames the analysis writers own', async () => {
    await writeAudioTags(mp3, {
      title: 'OLD TITLE',
      artist: 'KEEP ARTIST',
      year: 1988,
      energy: 0.72,
      loudness: -9.3,
      mood: 'party',
      mbRecordingId: 'mbr-1',
      acoustIdId: 'aid-1',
    });
    expect(
      await writeAudioTags(
        mp3,
        { title: 'NEW TITLE' },
        { readTags: async () => ({ title: 'OLD TITLE' }) },
      ),
    ).toBe(true);
    expect(spawns()).toHaveLength(1);
    const tags = await readAudioTags(mp3);
    expect(tags.title).toBe('NEW TITLE');
    expect(tags.artist).toBe('KEEP ARTIST');
    expect(tags.energy).toBeCloseTo(0.72, 3);
    expect(tags.loudness).toBeCloseTo(-9.3, 1);
    expect(tags.mood).toBe('party');
    expect(tags.mbRecordingId).toBe('mbr-1');
    expect(tags.acoustIdId).toBe('aid-1');
    // The id3v2.3 pin: a v2.4 rewrite would leave this undefined.
    expect(tags.year).toBe(1988);
  });

  it('keeps the lyrics readable across the rewrite', async () => {
    // ffmpeg carries an inherited USLT across but re-emits it as TXXX, which no
    // reader here maps to `lyrics`, so node-id3 puts the frame back.
    await writeAudioTags(mp3, { title: 'OLD TITLE', lyrics: 'first line\nsecond line' });
    expect(
      await writeAudioTags(
        mp3,
        { title: 'NEW TITLE' },
        { readTags: async () => ({ title: 'OLD TITLE' }) },
      ),
    ).toBe(true);
    expect(spawns()).toHaveLength(1);
    const tags = await readAudioTags(mp3);
    expect(tags.title).toBe('NEW TITLE');
    expect(tags.lyrics).toBe('first line\nsecond line');
  });

  it('reports false when the rewrite itself cannot run', async () => {
    process.env.NICOTIND_FFMPEG_PATH = join(dir, 'no-such-ffmpeg');
    expect(
      await writeAudioTags(
        mp3,
        { title: 'NEW TITLE' },
        { readTags: async () => ({ title: 'OLD TITLE' }) },
      ),
    ).toBe(false);
  });
});

describe('featureTagsFromNative (pure)', () => {
  it('reads Vorbis comment frames case-insensitively', () => {
    const out = featureTagsFromNative({
      vorbis: [
        { id: 'ENERGY', value: '0.750' },
        { id: 'loudness_lufs', value: '-11.2' },
        { id: 'Valence', value: '0.300' },
        { id: 'DANCEABILITY', value: '0.640' },
        { id: 'ACOUSTICNESS', value: '0.100' },
        { id: 'INSTRUMENTALNESS', value: '0.020' },
        { id: 'MOOD', value: 'relaxed' },
      ],
    });
    expect(out).toEqual({
      energy: 0.75,
      loudness: -11.2,
      valence: 0.3,
      danceability: 0.64,
      acousticness: 0.1,
      instrumental: 0.02,
      mood: 'relaxed',
    });
  });

  it('reads ID3 native frames via the TXXX: prefix', () => {
    const out = featureTagsFromNative({
      'ID3v2.4': [{ id: 'TXXX:ENERGY', value: '0.5' }],
    });
    expect(out.energy).toBe(0.5);
  });

  it('clamps unit scores into 0..1 and drops garbage', () => {
    const out = featureTagsFromNative({
      vorbis: [
        { id: 'ENERGY', value: '1.7' },
        { id: 'VALENCE', value: '-0.2' },
        { id: 'DANCEABILITY', value: 'not-a-number' },
        { id: 'LOUDNESS_LUFS', value: '-500' }, // outside the plausible LUFS range
        { id: 'MOOD', value: 'blissful' }, // not in the vocabulary
      ],
    });
    expect(out.energy).toBe(1);
    expect(out.valence).toBe(0);
    expect(out.danceability).toBeUndefined();
    expect(out.loudness).toBeUndefined();
    expect(out.mood).toBeUndefined();
  });

  it('prefers common.mood over the native frame when both are valid', () => {
    const out = featureTagsFromNative({ vorbis: [{ id: 'MOOD', value: 'sad' }] }, 'Happy');
    expect(out.mood).toBe('happy');
  });

  it('returns all-undefined for missing native maps', () => {
    expect(featureTagsFromNative(undefined)).toEqual({
      energy: undefined,
      loudness: undefined,
      valence: undefined,
      danceability: undefined,
      acousticness: undefined,
      instrumental: undefined,
      mood: undefined,
    });
  });
});

describe('readMusicBrainzUfid — the recording id lives in UFID, not TXXX', () => {
  // The exact shape observed on the real library: node-id3 hands back the
  // identifier as a serialized Buffer, i.e. an object with numeric keys.
  const asBytes = (s: string) =>
    Object.fromEntries([...Buffer.from(s, 'ascii')].map((b, i) => [String(i), b]));
  const UUID = '4f6edf56-d83b-4d8f-b216-2b17c2a9daab';

  it('reads the id from a byte-array identifier', () => {
    // 20% of the library carries it this way and none carries a
    // `TXXX:MusicBrainz Track Id`, so this is the only path that finds it.
    expect(
      readMusicBrainzUfid({
        uniqueFileIdentifier: {
          owner_identifier: 'http://musicbrainz.org',
          identifier: asBytes(UUID),
        },
      }),
    ).toBe(UUID);
  });

  it('accepts a real Buffer and a plain string too', () => {
    expect(
      readMusicBrainzUfid({
        uniqueFileIdentifier: { ownerIdentifier: 'http://musicbrainz.org', identifier: UUID },
      }),
    ).toBe(UUID);
  });

  it('picks the MusicBrainz frame out of several owners', () => {
    expect(
      readMusicBrainzUfid({
        uniqueFileIdentifier: [
          { owner_identifier: 'http://example.com', identifier: asBytes('not-ours') },
          { owner_identifier: 'http://musicbrainz.org', identifier: asBytes(UUID) },
        ],
      }),
    ).toBe(UUID);
  });

  it('ignores another owner rather than guessing', () => {
    expect(
      readMusicBrainzUfid({
        uniqueFileIdentifier: { owner_identifier: 'http://example.com', identifier: asBytes(UUID) },
      }),
    ).toBeUndefined();
  });

  it('rejects a payload that is not a UUID', () => {
    // Same namespace, different payload. A recording id is a UUID; anything
    // else would be a confident wrong answer.
    expect(
      readMusicBrainzUfid({
        uniqueFileIdentifier: {
          owner_identifier: 'http://musicbrainz.org',
          identifier: asBytes('hello'),
        },
      }),
    ).toBeUndefined();
  });

  it('is quiet on a file with no UFID at all', () => {
    expect(readMusicBrainzUfid({})).toBeUndefined();
    expect(readMusicBrainzUfid({ uniqueFileIdentifier: null })).toBeUndefined();
  });
});
