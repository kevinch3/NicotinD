import { describe, expect, it } from 'bun:test';
import { checkHeadroom, freeBytes, type StatfsFn } from './disk-space.js';

/** 4 KiB blocks, `avail` of them free. */
const fs =
  (avail: number, bsize = 4096): StatfsFn =>
  () => ({
    bsize,
    blocks: avail * 2,
    bavail: avail,
  });
const throwing: StatfsFn = () => {
  throw new Error('EPERM: container mount does not implement statfs');
};

describe('freeBytes', () => {
  it('multiplies available blocks by block size', () => {
    expect(freeBytes('/x', fs(1000))).toBe(1000 * 4096);
  });

  it('uses bavail, not blocks', () => {
    // bfree/blocks include the reserved superuser pool; a backfill is not root.
    expect(freeBytes('/x', fs(10))).toBe(10 * 4096);
  });

  it('returns null when the probe throws', () => {
    expect(freeBytes('/x', throwing)).toBeNull();
  });

  it('returns null rather than NaN on a nonsense result', () => {
    const bad: StatfsFn = () => ({ bsize: Number.NaN, blocks: 1, bavail: 1 });
    expect(freeBytes('/x', bad)).toBeNull();
  });

  it('reports a genuinely full filesystem as 0, not null', () => {
    // The distinction the whole module turns on: 0 is an answer, null is not.
    expect(freeBytes('/x', fs(0))).toBe(0);
  });
});

describe('checkHeadroom', () => {
  it('passes when free space covers the requirement and margin', () => {
    const r = checkHeadroom('/x', 1000, { margin: 500, statfs: fs(1) });
    expect(r).toEqual({ sufficient: true, free: 4096, required: 1500 });
  });

  it('fails when free space is short', () => {
    const r = checkHeadroom('/x', 10_000, { margin: 0, statfs: fs(1) });
    expect(r.sufficient).toBe(false);
    expect(r.free).toBe(4096);
  });

  it('counts the margin toward the requirement', () => {
    // 4096 free covers 4000 alone, but not 4000 + 500.
    expect(checkHeadroom('/x', 4000, { margin: 0, statfs: fs(1) }).sufficient).toBe(true);
    expect(checkHeadroom('/x', 4000, { margin: 500, statfs: fs(1) }).sufficient).toBe(false);
  });

  it('FAILS OPEN when the filesystem cannot be probed', () => {
    // The load-bearing case. "Unknown is not full" — an unreadable statfs must
    // never block a run, and `free: null` is how a caller tells this apart from
    // a genuine pass so it can say it skipped the check.
    const r = checkHeadroom('/x', Number.MAX_SAFE_INTEGER, { statfs: throwing });
    expect(r.sufficient).toBe(true);
    expect(r.free).toBeNull();
  });

  it('still fails a full filesystem, which is not the same as unprobeable', () => {
    const r = checkHeadroom('/x', 1, { margin: 0, statfs: fs(0) });
    expect(r.sufficient).toBe(false);
    expect(r.free).toBe(0);
  });

  it('treats a negative requirement as zero rather than crediting it', () => {
    const r = checkHeadroom('/x', -5000, { margin: 0, statfs: fs(1) });
    expect(r.required).toBe(0);
    expect(r.sufficient).toBe(true);
  });
});
