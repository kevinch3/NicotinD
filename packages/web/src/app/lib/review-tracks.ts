/**
 * Pure helpers for the metadata fix modal's per-track review grid (issue
 * #411, Task 12) — DI-free so the edit/dirty-tracking/identify-merge logic is
 * unit-testable without Angular. The modal owns the `signal<EditableTrack[]>`
 * and calls these on init, on every keystroke, and after a per-track
 * fingerprint identify.
 */

/** One editable row in the review grid. `dirty*` flags gate what
 *  `dirtyTrackPayload` sends — an untouched field is never re-sent. */
export interface EditableTrack {
  id: string;
  track: number | null;
  title: string;
  artist: string;
  dirtyTitle: boolean;
  dirtyArtist: boolean;
}

/**
 * Build the initial grid state from the review queue's songs, ordered by
 * track number (nulls last — an untracked track has no natural position).
 * `artist` defaults to `''` since `QuarantineSong` carries no artist field.
 */
export function toEditableTracks(
  songs: Array<{ id: string; title: string; track: number | null; artist?: string }>,
): EditableTrack[] {
  return [...songs]
    .sort((a, b) => {
      if (a.track == null && b.track == null) return 0;
      if (a.track == null) return 1;
      if (b.track == null) return -1;
      return a.track - b.track;
    })
    .map((s) => ({
      id: s.id,
      track: s.track,
      title: s.title,
      artist: s.artist ?? '',
      dirtyTitle: false,
      dirtyArtist: false,
    }));
}

/** Only dirty rows, only their dirty fields — an untouched title/artist is
 *  never sent so the server doesn't overwrite a field the curator never saw. */
export function dirtyTrackPayload(
  tracks: EditableTrack[],
): Array<{ id: string; title?: string; artist?: string }> {
  return tracks
    .filter((t) => t.dirtyTitle || t.dirtyArtist)
    .map((t) => {
      const payload: { id: string; title?: string; artist?: string } = { id: t.id };
      if (t.dirtyTitle) payload.title = t.title;
      if (t.dirtyArtist) payload.artist = t.artist;
      return payload;
    });
}

/**
 * Merge a fingerprint identify result into a row: only non-empty fields
 * overwrite, and only those set the corresponding dirty flag — a `{}` (no
 * match) result is a no-op, leaving the row exactly as the curator left it.
 */
export function applyIdentify(
  t: EditableTrack,
  r: { title?: string; artist?: string },
): EditableTrack {
  const next = { ...t };
  if (r.title && r.title.trim()) {
    next.title = r.title;
    next.dirtyTitle = true;
  }
  if (r.artist && r.artist.trim()) {
    next.artist = r.artist;
    next.dirtyArtist = true;
  }
  return next;
}
