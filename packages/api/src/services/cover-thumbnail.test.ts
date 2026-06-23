import { describe, expect, it } from 'bun:test';
import { bucketCoverSize, resizeCover, COVER_SIZE_BUCKETS } from './cover-thumbnail.js';

describe('bucketCoverSize', () => {
  it('returns null for missing / empty / unparseable input (serve original)', () => {
    expect(bucketCoverSize(undefined)).toBeNull();
    expect(bucketCoverSize(null)).toBeNull();
    expect(bucketCoverSize('')).toBeNull();
    expect(bucketCoverSize('abc')).toBeNull();
    expect(bucketCoverSize('0')).toBeNull();
    expect(bucketCoverSize('-10')).toBeNull();
  });

  it('snaps a requested size up to the nearest bucket', () => {
    expect(bucketCoverSize('40')).toBe(40);
    expect(bucketCoverSize('41')).toBe(80);
    expect(bucketCoverSize('80')).toBe(80);
    expect(bucketCoverSize('200')).toBe(320); // the grid's size=300 → 320
    expect(bucketCoverSize('300')).toBe(320);
    expect(bucketCoverSize('320')).toBe(320);
  });

  it('returns null for sizes larger than the biggest bucket', () => {
    const biggest = COVER_SIZE_BUCKETS[COVER_SIZE_BUCKETS.length - 1];
    expect(bucketCoverSize(String(biggest + 1))).toBeNull();
    expect(bucketCoverSize('4000')).toBeNull();
  });
});

describe('resizeCover', () => {
  // A 1000x1000 solid-red PNG is large; the resized thumbnail must be smaller.
  async function bigPng(): Promise<Uint8Array> {
    const sharp = (await import('sharp')).default;
    const out = await sharp({
      create: { width: 1000, height: 1000, channels: 3, background: { r: 200, g: 30, b: 30 } },
    })
      .png()
      .toBuffer();
    return new Uint8Array(out);
  }

  it('produces a smaller webp thumbnail of the requested square size', async () => {
    const sharp = (await import('sharp')).default;
    const src = await bigPng();
    const resized = await resizeCover(src, 80);
    expect(resized.contentType).toBe('image/webp');
    expect(resized.data.length).toBeLessThan(src.length);
    const meta = await sharp(Buffer.from(resized.data)).metadata();
    expect(meta.width).toBe(80);
    expect(meta.height).toBe(80);
    expect(meta.format).toBe('webp');
  });

  it('rejects undecodable input so callers can fall back to the original', async () => {
    await expect(resizeCover(new Uint8Array([1, 2, 3, 4]), 80)).rejects.toBeDefined();
  });
});
