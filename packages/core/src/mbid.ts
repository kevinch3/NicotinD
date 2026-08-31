/**
 * Canonical MusicBrainz id shape — a plain UUID (issue #610).
 *
 * A file tag is not a trusted source for one: external taggers write Discogs
 * release refs (`5333377-B5`) into MUSICBRAINZ_TRACKID, and a batch API rejects
 * the whole request on the first invalid id — so one bad tag costs every song
 * batched beside it (issue #851). Validate before a tag-sourced id goes out.
 */
const MBID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isMbidShape(value: string | null | undefined): boolean {
  return typeof value === 'string' && MBID_SHAPE.test(value.trim().toLowerCase());
}
