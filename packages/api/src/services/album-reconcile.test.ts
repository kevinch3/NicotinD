// packages/api/src/services/album-reconcile.test.ts
import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseFolderKeepers, readFolderTracks, type ReconcileFile } from './album-reconcile.js';

const f = (
  name: string,
  title: string,
  suffix: string,
  bitRate: number,
  disc: number | null = null,
): ReconcileFile => ({
  name,
  title,
  suffix,
  bitRate,
  disc,
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

  it('never deletes the last copy of a track the canonical list omits (#968)', () => {
    // This pass unlinks files from disk. A pinned tracklist describing another
    // edition therefore did not merely hide music, it destroyed it — so the
    // "never deletes the last copy" invariant below must hold with a canonical
    // list exactly as it does without one.
    const files = [f('01 Circus.mp3', 'Circus', 'mp3', 320), f('bonus.mp3', 'DJ Drop', 'mp3', 320)];
    const { deletedNames } = chooseFolderKeepers(files, ['Circus', 'Womanizer']);
    expect(deletedNames).toEqual([]);
  });

  it('still deletes a redundant copy when the canonical list names the track', () => {
    const files = [
      f('01 Circus.mp3', 'Circus', 'mp3', 320),
      f('02 Circus.mp3', 'Circus', 'mp3', 128),
    ];
    const { deletedNames } = chooseFolderKeepers(files, ['Circus', 'Womanizer']);
    expect(deletedNames).toEqual(['02 Circus.mp3']);
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

  // This pass deletes files, so a title repeated across discs must survive it (issue #747).
  it('keeps both discs when a title repeats across them', () => {
    const files = [
      f('01 - Intro.flac', 'Intro', 'flac', 900, 1),
      f('01 - Intro (2).flac', 'Intro', 'flac', 900, 2),
    ];
    const { deletedNames, keptNames } = chooseFolderKeepers(files);
    expect(deletedNames).toEqual([]);
    expect(keptNames).toEqual(['01 - Intro.flac', '01 - Intro (2).flac']);
  });

  it('keeps both discs under a canonical tracklist too (a titles-only list matches both)', () => {
    const files = [
      f('01 - Intro.flac', 'Intro', 'flac', 900, 1),
      f('01 - Intro (2).flac', 'Intro', 'flac', 900, 2),
    ];
    const { deletedNames } = chooseFolderKeepers(files, ['Intro', 'Womanizer']);
    expect(deletedNames).toEqual([]);
  });

  it('still collapses format-duplicates within one disc', () => {
    const files = [f('a.flac', 'Intro', 'flac', 900, 2), f('b.mp3', 'Intro', 'mp3', 320, 2)];
    const { deletedNames } = chooseFolderKeepers(files);
    expect(deletedNames).toEqual(['b.mp3']);
  });

  it('treats an untagged disc as the only disc, so it collapses against a tagged disc 1', () => {
    const files = [f('a.flac', 'Intro', 'flac', 900), f('b.mp3', 'Intro', 'mp3', 320, 1)];
    const { deletedNames } = chooseFolderKeepers(files);
    expect(deletedNames).toEqual(['b.mp3']);
  });
});

describe('readFolderTracks', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'recon-'));
  writeFileSync(join(tmp, 'cover.jpg'), '');
  writeFileSync(join(tmp, 'track.flac'), '');

  afterAll(() => {
    try {
      rmSync(tmp, { recursive: true });
    } catch {
      /* ignore */
    }
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

// A disc field the reader never populates is the shape of issue #747, so this
// runs the real tag parse over a real MP3 rather than trusting the type.
describe('readFolderTracks disc tag', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'recon-disc-'));
  const fixture = join(import.meta.dir, '../../test-fixtures/silence.mp3');

  afterAll(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('reads the disc off a tagged file, leaves an untagged one null, and keeps both discs', async () => {
    const { default: nodeId3 } = (await import('node-id3')) as unknown as {
      default: { update: (t: object, f: string) => boolean };
    };
    for (const name of ['d1.mp3', 'd2.mp3', 'plain.mp3']) copyFileSync(fixture, join(tmp, name));
    nodeId3.update({ title: 'Intro', partOfSet: '1/2' }, join(tmp, 'd1.mp3'));
    nodeId3.update({ title: 'Intro', partOfSet: '2/2' }, join(tmp, 'd2.mp3'));
    nodeId3.update({ title: 'Intro' }, join(tmp, 'plain.mp3'));

    const tracks = await readFolderTracks(tmp);
    expect(tracks.find((t) => t.name === 'd1.mp3')?.disc).toBe(1);
    expect(tracks.find((t) => t.name === 'd2.mp3')?.disc).toBe(2);
    expect(tracks.find((t) => t.name === 'plain.mp3')?.disc).toBeNull();

    // Only the untagged twin of disc 1 collapses; disc 2's copy survives.
    expect(chooseFolderKeepers(tracks).deletedNames).toEqual(['plain.mp3']);
  });
});
