# Download Feedback & Folder Bug Fix — Design Spec

**Date:** 2026-03-22
**Status:** Approved

---

## Problem

Two related issues with the Search page download experience:

1. **Folder ghost entry bug** — Selecting "Download folder" sometimes enqueues a 0-byte directory stub (a Soulseek protocol artifact where some peer clients include a placeholder "file" entry named after the directory itself). slskd resolves it instantly as `Completed, Succeeded` (nothing to transfer), producing a phantom "track" named after the folder that flashes through the queue and never appears in the library.

2. **No live download feedback in Search** — After clicking Download or Download folder, buttons change to "Queued" and go silent. There's no path from the actual slskd transfer state (InProgress, Done, Error) back to the search result buttons. The Downloads page has this feedback but Search doesn't.

---

## Solution

### Bug fix
Filter out files with `size === 0` before calling `enqueueDownload` at all three call sites:
- `handleDownload` (single track)
- Folder Download button handler (all files in group)
- FolderBrowser "Download all" handler

### Live feedback architecture
A global Zustand `useTransferStore` polls `GET /api/downloads` every 3 seconds — once for the entire app. It maintains:
- A flat `Map<"username:filename", TransferEntry>` for O(1) button state lookups
- A raw `SlskdUserTransferGroup[]` copy for the Downloads page

The Downloads page migrates to consume from the store, eliminating duplicate polling. Search buttons and the FolderBrowser Download button derive their display from a pure `downloadStatus.ts` helper.

---

## Button States

| Condition | Label | Style |
|---|---|---|
| Not started | `Download` / `Download folder` | zinc-800 (default) |
| Just queued (optimistic) | `Queued` | zinc-700, 75% opacity |
| slskd: Queued, Locally/Remotely/Requested | `Queued` | zinc-700, 75% opacity |
| slskd: InProgress / Initializing | `↓ 42%` | blue-900 |
| slskd: Completed, Succeeded | `✓ Done` | green-900 |
| slskd: Completed, Cancelled/TimedOut/Errored/Rejected | `✗ Error` | red-900 |

For folder buttons, states aggregate across all files: error wins over all, then progress (averaged), then done (all must succeed), then queued.

---

## Key Design Decisions

**Why `transferTypes.ts` exists:** `downloadStatus.ts` and its bun:test tests must share the `TransferEntry` type. `bun test` does not resolve `@/` tsconfig aliases, so the type lives in a plain file with no Zustand or API imports, imported via relative paths.

**Why `downloads: SlskdUserTransferGroup[]` in the store:** Downloads.tsx uses the grouped structure from `groupByAlbum()`. Exposing the raw grouped data from the store alongside the flat map means Downloads.tsx can migrate without restructuring its display logic.

**FolderBrowser optimistic gap:** The FolderBrowser "Download all" button does not show an immediate "Queued" state after clicking (unlike the Search page buttons which use `addDownloading` from the search store). The button will update to `Queued` or `↓ X%` on the next poll cycle (~3s). This is a known, accepted limitation — wiring `addDownloading` into FolderBrowser would couple it to the search store.

---

## Files Changed

| File | Action |
|---|---|
| `packages/web/src/lib/transferTypes.ts` | New — shared `TransferEntry` type |
| `packages/web/src/stores/transfers.ts` | New — global polling store |
| `packages/web/src/lib/downloadStatus.ts` | New — pure button state helpers |
| `packages/web/src/lib/downloadStatus.test.ts` | New — full test coverage |
| `packages/web/src/lib/api.ts` | Type `getDownloads()` return |
| `packages/web/src/App.tsx` | Start/stop polling on auth |
| `packages/web/src/pages/Downloads.tsx` | Migrate to store, remove local polling |
| `packages/web/src/pages/Search.tsx` | Size filter + button feedback |
| `packages/web/src/components/FolderBrowser.tsx` | Size filter + getStatus prop |
