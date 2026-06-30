import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Manual artist-image overrides — a user-uploaded photo or a cover copied from
 * one of the artist's albums.
 *
 * Stored as raw bytes in a dedicated, *persistent* dir (`<dataDir>/artist-overrides`)
 * rather than the purgeable `cover-cache`, and keyed on the scanner's deterministic
 * artist id so the choice survives rescans. Bytes (not a URL) because an upload has
 * no URL and a disk-only album cover has no public one. The cover route serves these
 * ahead of canonical/auto artwork; `library_artists.manual_override = 1` then tells
 * the artist-image enrichment task to leave the artist alone.
 */

const SUBDIR = 'artist-overrides';
/** Image types we accept for an *upload* override (validated at the route boundary). */
export const ALLOWED_OVERRIDE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const VARIANT_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

/** Storage extension for an image content-type (substring match; defaults to .jpg). */
function extForContentType(contentType: string): string {
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('webp')) return '.webp';
  return '.jpg';
}

export interface ArtistImageBytes {
  data: Uint8Array;
  contentType: string;
}

function overrideDir(dataDir: string): string {
  return join(dataDir, SUBDIR);
}

function contentTypeForExt(ext: string): string {
  return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
}

/** True when a manual override image exists for the artist id. */
export function hasArtistImageOverride(dataDir: string, artistId: string): boolean {
  return VARIANT_EXTS.some((ext) => existsSync(join(overrideDir(dataDir), artistId + ext)));
}

/** Read the override image bytes for an artist id, or null when none is set. */
export async function readArtistImageOverride(
  dataDir: string,
  artistId: string,
): Promise<ArtistImageBytes | null> {
  for (const ext of VARIANT_EXTS) {
    const p = join(overrideDir(dataDir), artistId + ext);
    if (existsSync(p)) {
      try {
        return { data: await readFile(p), contentType: contentTypeForExt(ext) };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Persist override bytes, replacing any prior variant. `contentType` must be allowed. */
export function writeArtistImageOverride(
  dataDir: string,
  artistId: string,
  data: Uint8Array,
  contentType: string,
): void {
  deleteArtistImageOverride(dataDir, artistId);
  mkdirSync(overrideDir(dataDir), { recursive: true });
  writeFileSync(join(overrideDir(dataDir), artistId + extForContentType(contentType)), data);
}

/** Remove every override variant for an artist id (no-op when none exist). */
export function deleteArtistImageOverride(dataDir: string, artistId: string): void {
  for (const ext of VARIANT_EXTS) {
    const p = join(overrideDir(dataDir), artistId + ext);
    if (existsSync(p)) {
      try {
        rmSync(p);
      } catch {
        /* best-effort */
      }
    }
  }
}
