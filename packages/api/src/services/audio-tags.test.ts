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
import {
  featureTagsFromNative,
  licenceFromTags,
  readAudioTags,
  writeAudioTags,
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

describe('audio-tags licence (ID3 LICENSE TXXX)', () => {
  it('round-trips a canonical licence code', async () => {
    expect(await writeAudioTags(mp3, { licence: 'cc-by-sa' })).toBe(true);
    const tags = await readAudioTags(mp3);
    expect(tags.licence).toBe('cc-by-sa');
  });

  it('folds a raw CC URL written into the LICENSE frame to a canonical code on read', async () => {
    await writeAudioTags(mp3, { licence: 'https://creativecommons.org/licenses/by/4.0/' });
    const tags = await readAudioTags(mp3);
    expect(tags.licence).toBe('cc-by');
  });
});

describe('licenceFromTags (pure)', () => {
  it('prefers the LICENSE frame over a copyright frame', () => {
    expect(
      licenceFromTags({
        vorbis: [
          { id: 'COPYRIGHT', value: '© 2020 Some Label' },
          { id: 'LICENSE', value: 'CC BY-NC' },
        ],
      }),
    ).toBe('cc-by-nc');
  });

  it('falls back to a recognisable copyright text', () => {
    expect(licenceFromTags({ vorbis: [{ id: 'COPYRIGHT', value: 'Public Domain' }] })).toBe(
      'public-domain',
    );
  });

  it('returns undefined for no tags or an unrecognised copyright notice', () => {
    expect(licenceFromTags(undefined)).toBeUndefined();
    expect(licenceFromTags({ vorbis: [{ id: 'COPYRIGHT', value: '© 2020 Artist' }] })).toBeUndefined();
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
    // genre is written but readAudioTags doesn't surface it (scanner reads it
    // via common.genre) — assert the fields this module reads back.
    expect(tags.key).toBe('A minor');
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
