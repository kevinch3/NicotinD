import { isUploadableName } from '@nicotind/core';

/** A file the user dropped or picked, with its path relative to the drop root. */
export interface DroppedFile {
  /** Posix-separated, relative to the dropped folder. Untrusted — the server revalidates. */
  path: string;
  size: number;
  blob: File;
}

export interface UploadPlan {
  files: DroppedFile[];
  /** Entries the allowlist rejected, echoed so the card can say what it ignored. */
  skipped: string[];
  totalBytes: number;
}

/** One request's worth of bytes, mirrored from the server's own cap. */
export interface ChunkRange {
  offset: number;
  end: number;
}

/**
 * Filter a drop down to what is worth uploading.
 *
 * The client filters purely to save the user's bandwidth — the server enforces
 * the same list, from the same `@nicotind/core` helper, because a client's word
 * is not a permission. Sharing the predicate is what stops the two drifting
 * into "the browser uploaded it and the server threw it away".
 */
export function buildUploadManifest(dropped: DroppedFile[]): UploadPlan {
  const files: DroppedFile[] = [];
  const skipped: string[] = [];
  for (const f of dropped) {
    if (isUploadableName(f.path)) files.push(f);
    else skipped.push(f.path);
  }
  return { files, skipped, totalBytes: files.reduce((n, f) => n + f.size, 0) };
}

/**
 * The byte ranges still to send for one file.
 *
 * `received` makes this the resume plan as well as the initial one: whole
 * chunks already on disk are skipped, and the first range restarts at the exact
 * byte the server reported rather than at a chunk boundary — re-sending the
 * whole partial chunk would be correct too (writes are offset-addressed and
 * idempotent) but wastes what was already transferred.
 */
export function chunkRanges(size: number, chunkBytes: number, received = 0): ChunkRange[] {
  // A zero-byte file still needs one empty write, or the staged directory and
  // the manifest disagree about which files exist.
  if (size === 0) return received > 0 ? [] : [{ offset: 0, end: 0 }];
  if (received >= size) return [];
  const ranges: ChunkRange[] = [];
  let offset = received;
  while (offset < size) {
    // Align every range to a chunk boundary, so only the *first* one after a
    // resume can be short. Advancing by a flat `chunkBytes` instead would shift
    // every later boundary by the resume offset, and a second resume would then
    // re-send bytes under different ranges than the first — correct, since
    // writes are offset-addressed and idempotent, but needlessly re-transferred.
    const boundary = (Math.floor(offset / chunkBytes) + 1) * chunkBytes;
    const end = Math.min(boundary, size);
    ranges.push({ offset, end });
    offset = end;
  }
  return ranges;
}

/**
 * Bytes-weighted, so a 90 MB FLAC does not advance the bar the same as a 3 MB
 * MP3. Capped at 99: the card only reaches 100 when the *commit* is accepted,
 * and showing 100 while the server has not taken the job yet claims more than
 * is true — the same rule `jobPercent` follows for downloads.
 */
export function uploadPercent(sentBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0;
  return Math.min(99, Math.floor((sentBytes / totalBytes) * 100));
}
