import { describe, it, expect } from 'bun:test';
import { diskFindings, type DiskScan } from './library-disk-audit.js';

describe('diskFindings', () => {
  it('flags missing files, orphan files, and empty dirs', () => {
    const scan: DiskScan = {
      audioPaths: ['Artist/Album/01.opus', 'Artist/Album/orphan.opus'],
      emptyDirs: ['Artist/Empty Album'],
    };
    const dbPaths = ['Artist/Album/01.opus', 'Artist/Album/02-gone.opus'];
    const byRule = (r: string) => diskFindings(scan, dbPaths).filter((f) => f.rule === r);

    expect(byRule('missing_file').map((f) => f.subject)).toEqual(['Artist/Album/02-gone.opus']);
    expect(byRule('orphan_file').map((f) => f.subject)).toEqual(['Artist/Album/orphan.opus']);
    expect(byRule('empty_dir').map((f) => f.subject)).toEqual(['Artist/Empty Album']);
  });

  it('returns nothing when disk and DB agree and no empty dirs', () => {
    const scan: DiskScan = { audioPaths: ['a/b/c.opus'], emptyDirs: [] };
    expect(diskFindings(scan, ['a/b/c.opus'])).toEqual([]);
  });

  it('marks missing files high and orphan files medium severity', () => {
    const scan: DiskScan = { audioPaths: ['x.opus'], emptyDirs: [] };
    const f = diskFindings(scan, ['y.opus']);
    expect(f.find((x) => x.rule === 'missing_file')!.severity).toBe('high');
    expect(f.find((x) => x.rule === 'orphan_file')!.severity).toBe('medium');
  });
});
