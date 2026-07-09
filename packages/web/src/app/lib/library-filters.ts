/**
 * Pure resolution logic for the library Albums controls. Starred used to be
 * modeled as the server `type=starred` ordering; it now lives in the shared
 * `LibraryFilter` (a real WHERE filter, independent of sort), so `type` is
 * ordering-only. `splitAlbumListType` remains to map legacy `type=starred`
 * URLs / persisted state onto the new split. DI-free so unit-testable
 * without the component.
 */
export type AlbumListType =
  | 'newest'
  | 'frequent'
  | 'recent'
  | 'starred'
  | 'alphabeticalByName'
  | 'random';

export const ALBUM_LIST_TYPES: AlbumListType[] = [
  'newest',
  'frequent',
  'recent',
  'starred',
  'alphabeticalByName',
  'random',
];

/** Map a (possibly legacy `starred`) server `type` onto sort + starred filter. */
export function splitAlbumListType(type: AlbumListType): {
  sort: AlbumListType;
  starredOnly: boolean;
} {
  return type === 'starred'
    ? { sort: 'newest', starredOnly: true }
    : { sort: type, starredOnly: false };
}

/** Parse the Min-tracks `<select>` value; '' means "no minimum" (All). */
export function parseMinTracks(value: string): number | null {
  return value === '' ? null : Number(value);
}

/**
 * Count of the Albums tab's page-specific filters (projected into the shared
 * panel's content slot). The shared properties (starred, bpm, …) are counted
 * by `activeLibraryFilterCount` in @nicotind/core.
 */
export function activeExtraFilterCount(opts: {
  minTracks: number | null;
  showHidden: boolean;
}): number {
  return (opts.minTracks !== null ? 1 : 0) + (opts.showHidden ? 1 : 0);
}
