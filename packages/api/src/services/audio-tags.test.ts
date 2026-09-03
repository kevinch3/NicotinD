/**
 * Round-trips lyrics (and a sibling genre tag) through the ID3 path on a real
 * MP3 fixture via node-id3 — no ffmpeg needed. Guards the USLT write/read added
 * for the on-demand lyrics feature. The Vorbis/Opus round-trip below IS
 * ffmpeg-gated (skipped where ffmpeg is absent; CI runners have it).
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { featureTagsFromNative, readAudioTags, writeAudioTags } from './audio-tags.js';
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
  /** A one-second file of `ext`, already carrying TITLE/ARTIST/ALBUM. */
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
      path,
    ]);
    expect(gen.status).toBe(0);
    return path;
  }

  for (const ext of ['opus', 'ogg', 'flac', 'm4a']) {
    it(`replaces an existing title/artist/album on .${ext}`, async () => {
      const path = tagged(ext, `retag-${ext}`);
      expect(
        await writeAudioTags(path, {
          title: 'NEW TITLE',
          artist: 'NEW ARTIST',
          album: 'NEW ALBUM',
        }),
      ).toBe(true);
      const tags = await readAudioTags(path);
      expect(tags.title).toBe('NEW TITLE');
      expect(tags.artist).toBe('NEW ARTIST');
      expect(tags.album).toBe('NEW ALBUM');
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
 * `readAudioTags` reads `compilation` on the ID3 path (`TCMP`) but the
 * Vorbis/m4a branch never returned the field, so it was permanently
 * `undefined` for .flac/.ogg/.opus/.m4a.
 *
 * That asymmetry is load-bearing, not cosmetic. `library-organizer.ts` guards
 * its tag rewrite with `if (folderTags.compilation && !currentRaw.compilation)`
 * and documents the step as running "idempotently". With the read always
 * `undefined`, the guard is permanently true, so every organize pass re-writes
 * COMPILATION=1 — and on this family a tag write is a full ffmpeg remux of the
 * user's audio file. Opus is what the library transcodes everything into.
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

  // Deliberately no mp3 case here. node-id3 0.2.9 has no TCMP frame at all, so
  // the ID3 branch's write is a silent no-op and its read can never be true —
  // a separate defect that needs a dependency decision, not a code fix.
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
