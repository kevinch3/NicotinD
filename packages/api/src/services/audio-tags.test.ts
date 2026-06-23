/**
 * Round-trips lyrics (and a sibling genre tag) through the ID3 path on a real
 * MP3 fixture via node-id3 — no ffmpeg needed. Guards the USLT write/read added
 * for the on-demand lyrics feature.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAudioTags, writeAudioTags } from './audio-tags.js';

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
