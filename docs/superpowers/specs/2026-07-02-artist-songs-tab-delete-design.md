# Artist Songs tab — admin delete parity

**Date:** 2026-07-02
**Type:** fix (parity gap)
**Status:** approved

## Problem

Albumless files (loose songs that never grouped into an album) surface **only** on
the artist page's **Songs** tab. Example:
`https://nicotined.kevinroberts.ar/library/artists/c1c862188e461ea92426e3c3c9076af47b44a0a2`

Every other song-list view offers admin-gated deletion:

- **Album detail** — bulk "Remove" on selection + per-row "Remove" + whole-album delete.
- **Genre detail** — bulk delete on selection + per-row "Remove".

The **artist Songs tab does not.** Its selection bar wires up play / queue / add /
download but omits delete, and its track rows carry no per-row actions menu. Result:
there is no view from which an admin can remove an albumless file. Files are stuck in
the library permanently.

## Root cause

Purely a frontend wiring gap in `packages/web/src/app/pages/library/artist-detail.component.{ts,html}`.
Everything else already exists:

- **Backend routes** (no change needed) — both admin-gated:
  - `DELETE /api/library/songs/:id` — `library.ts:1575` (`user.role !== 'admin'` → 403).
  - `POST /api/library/songs/bulk-delete` — `library.ts:1589` (same gate).
  - `deleteOne()` performs folder/file removal + canonical-row + orphan-artist prune.
- **UI primitives** (no change needed):
  - `SelectionBarComponent` already exposes `canDelete` / `deleteLabel` inputs and a
    `deleteSelected` output (`selection-bar.component.ts:18,19,32`).
  - `TrackRowComponent` already accepts an `actions: TrackAction[]` menu input
    (`track-row.component.ts:49`).
- **Reference implementation** — `genre-detail.component.ts` is a near-identical flat
  song list that already does exactly this (bulk `deleteSelectedSongs()` at `:120`,
  per-row admin `genreTrackActions()` at `:161`, `askConfirm` + `deleteError`).

## Decision

Mirror the genre-detail pattern into artist-detail. Both affordances; admins only
(matching the existing hard backend gate — no policy change).

## Changes

All in `packages/web/src/app/pages/library/artist-detail.*`:

### Component (`artist-detail.component.ts`)

- New imports: `TransferService`, `ConfirmDialogComponent`, and from `track-utils`
  `offlineTrackAction`, `addToPlaylistAction`, plus `type TrackAction`;
  `resolveArtistRoute` is already available via route-utils if needed (self-link
  omitted — we're already on the artist page).
- Inject `TransferService`.
- Confirm-dialog state copied from genre-detail: `confirmMessage`, `confirmCallback`,
  `showConfirm` (computed), `askConfirm()`, `onConfirm()`, `onCancel()`.
- `deleteError = signal<string | null>(null)`.
- `deleteSelectedSongs()` — confirm → `api.deleteSongs(ids)` →
  `transferService.addDeletedIds(ids)` → prune `songs` signal → `selection.exit()` →
  partial-failure message on `deletedCount < ids.length`.
- `artistTrackActions(song): TrackAction[]` — offline + add-to-playlist for everyone;
  an admin-only destructive **Remove** entry (confirm → `deleteSongs([id])` → prune).
  Gate with `this.auth.role() === 'admin'`.

### Template (`artist-detail.component.html`)

- Selection bar (Songs tab, ~line 194): add
  `[canDelete]="auth.role() === 'admin'"` and `(deleteSelected)="deleteSelectedSongs()"`.
- Track rows (~line 211): add `[actions]="artistTrackActions(song)"`.
- Render `<app-confirm-dialog>` bound to the confirm-dialog state (mirror genre-detail).
- Render the `deleteError` banner (mirror genre-detail's placement/style).

### Local-state hygiene

Deleting from the Songs tab must not leave stale album/singles counts referencing a
just-deleted-only artist. Deletion is per-song here (never the artist's last-and-only
album delete path), and the backend prunes orphan artists inside `deleteOne`; the tab
already reflects removals via the pruned `songs` signal + `TransferService.deletedSongIds`.
No extra client reconciliation beyond pruning `songs`.

## Testing

- Web unit test (`artist-detail.component.spec.ts`, JIT/vitest): follow the DI-free /
  instance-output conventions.
  - When `auth.role()` is `'admin'`, `artistTrackActions(song)` includes a `Remove`
    action; when `'user'`, it does not.
  - `deleteSelectedSongs()` with a stubbed `LibraryApiService.deleteSongs` calls the
    API with the selected ids, prunes the `songs` signal, and records deleted ids on
    `TransferService`.
  - Partial-failure (`deletedCount < ids.length`) sets `deleteError`.
- Confirm CI runs it: web unit tests execute under `ci.yml` (`ng test` / vitest).
- (Backend already covered — routes and gating unchanged.)

## Docs

- `CLAUDE.md` — update the "Artist page — tabbed" index line to note the Songs tab now
  includes admin-gated per-row + bulk delete.
- Detail in the web-ui / design-patterns doc: note artist Songs tab reached delete
  parity with album/genre detail; albumless files are removable there.

## Out of scope

- No backend/route changes; no permission-model change (stays admin-only).
- No whole-artist delete button (deletion remains per-song / per-selection).
- No changes to album or genre detail.
