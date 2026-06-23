/**
 * Cover thumbnail resizing. The cover route serves the same source image for
 * every slot — a 40px player thumbnail and a 300px grid tile alike — which meant
 * shipping multi-MB album art to render a tiny icon (the "thumbnails load super
 * slow" report). We snap the requested `size` to a small set of buckets and cache
 * one resized WebP per (id, bucket) so repeat hits are a single small file read.
 */

/** Sizes we materialize. The frontend requests 40/80/200/300; snapping up keeps
 *  the cache bounded (5 variants/cover) while never under-serving a slot. */
export const COVER_SIZE_BUCKETS = [40, 80, 160, 320, 640] as const;

/**
 * Snap a requested cover dimension to a cache bucket. Returns `null` to mean
 * "serve the original" — no `size`, unparseable, or larger than the biggest
 * bucket (full-resolution callers, e.g. a future download, still get the source).
 */
export function bucketCoverSize(raw: string | null | undefined): number | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  for (const b of COVER_SIZE_BUCKETS) {
    if (n <= b) return b;
  }
  return null; // larger than the largest bucket → original
}

export interface ResizedCover {
  data: Uint8Array;
  contentType: string;
}

/**
 * Resize cover bytes to a square `size` WebP thumbnail. `sharp` is imported
 * lazily so merely importing this module (e.g. for the pure `bucketCoverSize`
 * test) doesn't load the native binding. Throws on undecodable input; callers
 * fall back to the original bytes.
 */
export async function resizeCover(bytes: Uint8Array, size: number): Promise<ResizedCover> {
  const sharp = (await import('sharp')).default;
  const out = await sharp(Buffer.from(bytes))
    .resize(size, size, { fit: 'cover', position: 'centre' })
    .webp({ quality: 80 })
    .toBuffer();
  return { data: new Uint8Array(out), contentType: 'image/webp' };
}
