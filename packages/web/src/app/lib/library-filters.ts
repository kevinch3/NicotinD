/**
 * Pure resolution logic for the consolidated library Albums controls. The
 * server models ordering AND the starred filter as a single `type` enum, while
 * the UI splits them into a Sort dropdown + a Starred checkbox; these helpers
 * convert between the two representations (and parse the Min-tracks select).
 * DI-free so they're unit-testable without the component.
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

/** Effective server `type` from the split Sort + Starred-filter controls. */
export function effectiveAlbumListType(sort: AlbumListType, starredOnly: boolean): AlbumListType {
  return starredOnly ? 'starred' : sort;
}

/** Inverse: map a server `type` back onto the split controls. */
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

/** Active-filter count for the Filters disclosure badge. */
export function activeFilterCount(opts: {
  starredOnly: boolean;
  minTracks: number | null;
  showHidden: boolean;
}): number {
  return (
    (opts.starredOnly ? 1 : 0) + (opts.minTracks !== null ? 1 : 0) + (opts.showHidden ? 1 : 0)
  );
}
