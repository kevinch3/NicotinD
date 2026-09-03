import { describe, expect, it } from 'vitest';
import { buildUploadManifest, chunkRanges, uploadPercent, type DroppedFile } from './upload-plan';

function f(path: string, size = 10): DroppedFile {
  return { path, size, blob: new Blob([]) as unknown as File };
}

describe('buildUploadManifest', () => {
  it('keeps audio and conventional cover art, and reports what it dropped', () => {
    const plan = buildUploadManifest([
      f('Album/01.flac', 100),
      f('Album/cover.jpg', 20),
      f('Album/notes.nfo', 5),
      f('Album/._Track.flac', 4),
    ]);
    expect(plan.files.map((x) => x.path)).toEqual(['Album/01.flac', 'Album/cover.jpg']);
    expect(plan.skipped).toEqual(['Album/notes.nfo', 'Album/._Track.flac']);
    expect(plan.totalBytes).toBe(120);
  });

  // Chrome hands back the dropped folder's own name as the first segment; the
  // server groups by directory, so stripping it would flatten a multi-disc
  // release into one folder.
  it('preserves nested directories', () => {
    const plan = buildUploadManifest([f('Album/CD1/01.flac'), f('Album/CD2/01.flac')]);
    expect(plan.files.map((x) => x.path)).toEqual(['Album/CD1/01.flac', 'Album/CD2/01.flac']);
  });

  it('reports an all-junk drop as having nothing to upload', () => {
    const plan = buildUploadManifest([f('readme.txt'), f('list.m3u')]);
    expect(plan.files).toEqual([]);
    expect(plan.totalBytes).toBe(0);
  });
});

describe('chunkRanges', () => {
  it('splits a file into whole chunks plus a remainder', () => {
    expect(chunkRanges(25, 10)).toEqual([
      { offset: 0, end: 10 },
      { offset: 10, end: 20 },
      { offset: 20, end: 25 },
    ]);
  });

  it('emits one range for a file smaller than a chunk', () => {
    expect(chunkRanges(4, 10)).toEqual([{ offset: 0, end: 4 }]);
  });

  // A zero-byte file still has to be created server-side, or the manifest and
  // the staged directory disagree about what exists.
  it('emits one empty range for a zero-byte file', () => {
    expect(chunkRanges(0, 10)).toEqual([{ offset: 0, end: 0 }]);
  });

  // Resume: everything already on disk is skipped, and the partial chunk
  // restarts at the byte the server actually has — not at a chunk boundary.
  it('resumes from the received offset', () => {
    expect(chunkRanges(25, 10, 12)).toEqual([
      { offset: 12, end: 20 },
      { offset: 20, end: 25 },
    ]);
  });

  it('emits nothing when the file is already complete', () => {
    expect(chunkRanges(25, 10, 25)).toEqual([]);
  });
});

describe('uploadPercent', () => {
  it('is bytes-weighted so one big track does not read like one small one', () => {
    expect(uploadPercent(0, 100)).toBe(0);
    expect(uploadPercent(50, 100)).toBe(50);
  });

  // The card hands off to the job card at commit; showing 100% while the
  // server has not accepted the commit yet would claim more than is true.
  it('caps below 100 until the caller says it is done', () => {
    expect(uploadPercent(100, 100)).toBe(99);
  });

  it('is 0 rather than NaN for an empty upload', () => {
    expect(uploadPercent(0, 0)).toBe(0);
  });
});
