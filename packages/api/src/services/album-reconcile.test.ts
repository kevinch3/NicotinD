// packages/api/src/services/album-reconcile.test.ts
import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseFolderKeepers, readFolderTracks, type ReconcileFile } from './album-reconcile.js';

const f = (name: string, title: string, suffix: string, bitRate: number): ReconcileFile => ({
  name, title, suffix, bitRate,
});

describe('chooseFolderKeepers', () => {
  it('collapses same-track different-filename copies, keeping FLAC', () => {
    const files = [
      f('05_circus.flac', 'Circus', 'flac', 900),
      f('02 - Circus.mp3', 'Circus', 'mp3', 320),
    ];
    const { deletedNames, keptNames } = chooseFolderKeepers(files);
    expect(keptNames).toEqual(['05_circus.flac']);
    expect(deletedNames).toEqual(['02 - Circus.mp3']);
  });

  it('within one format keeps the higher bitrate', () => {
    const files = [f('a.mp3', 'Toxic', 'mp3', 192), f('b.mp3', 'Toxic', 'mp3', 320)];
    const { keptNames } = chooseFolderKeepers(files);
    expect(keptNames).toEqual(['b.mp3']);
  });

  it('drops foreign rips when canonical titles are provided', () => {
    const files = [f('01 Circus.mp3', 'Circus', 'mp3', 320), f('bonus.mp3', 'DJ Drop', 'mp3', 320)];
    const { deletedNames } = chooseFolderKeepers(files, ['Circus', 'Womanizer']);
    expect(deletedNames).toEqual(['bonus.mp3']);
  });

  it('never deletes the last copy of a distinct track', () => {
    const files = [f('a.mp3', 'Circus', 'mp3', 320), f('b.mp3', 'Womanizer', 'mp3', 320)];
    const { deletedNames } = chooseFolderKeepers(files);
    expect(deletedNames).toEqual([]);
  });

  it('breaks equal-quality ties by lexicographically smallest name (deterministic)', () => {
    const files = [f('z.mp3', 'Circus', 'mp3', 320), f('a.mp3', 'Circus', 'mp3', 320)];
    const { keptNames } = chooseFolderKeepers(files);
    expect(keptNames).toEqual(['a.mp3']);
  });
});

describe('readFolderTracks', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'recon-'));
  writeFileSync(join(tmp, 'cover.jpg'), '');
  writeFileSync(join(tmp, 'track.flac'), '');

  afterAll(() => {
    try { rmSync(tmp, { recursive: true }); } catch { /* ignore */ }
  });

  it('excludes non-audio files (extension filter)', async () => {
    const result = await readFolderTracks(tmp);
    expect(result.find((r) => r.name === 'cover.jpg')).toBeUndefined();
  });

  it('includes .flac file with fallback title/suffix/bitRate when tag-parse yields nothing', async () => {
    const result = await readFolderTracks(tmp);
    const track = result.find((r) => r.name === 'track.flac');
    expect(track).toBeDefined();
    expect(track!.title).toBe('track');
    expect(track!.suffix).toBe('flac');
    expect(track!.bitRate).toBe(0);
  });

  it('returns [] for a missing directory', async () => {
    expect(await readFolderTracks(join(tmp, 'nonexistent'))).toEqual([]);
  });
});
