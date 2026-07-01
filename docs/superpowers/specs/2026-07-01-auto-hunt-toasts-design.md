# Auto-Hunt + Toast Notifications — Design Spec

**Date:** 2026-07-01  
**Status:** Approved

## Problem

"Find Album" opens a full modal that requires the user to review candidates and click Download. The best match is almost always correct, so this is unnecessary friction. There is also no global feedback mechanism — success and failure states are silent once the modal is dismissed.

## Solution

Make album acquisition automatic (hunt → auto-download best match) with a 3-second cancellable countdown, plus a global toast notification system for outcomes. The existing manual modal is preserved as an escape hatch.

---

## 1. Toast System

### `ToastService` (provided in root)

Signal-based singleton managing an array of active toasts.

```ts
interface ToastAction {
  label: string;
  callback: () => void;
}

interface ToastConfig {
  message: string;
  kind: 'info' | 'success' | 'error';
  actions?: ToastAction[];
  countdown?: number;   // seconds; first action fires on expiry
  duration?: number;    // seconds; auto-dismiss if no countdown (default 4s)
}

interface Toast extends ToastConfig {
  id: string;
}
```

Public API:
- `show(config: ToastConfig): string` — adds toast, returns ID
- `dismiss(id: string)` — removes by ID
- `toasts: Signal<Toast[]>` — reactive list for the outlet

Capacity: maximum 3 active toasts. If a 4th arrives, the oldest non-countdown toast is dropped first; if all are countdowns the new one is queued until one clears.

### `ToastOutletComponent`

Mounted once inside `AppComponent`. Reads `ToastService.toasts()` and renders them as a fixed overlay — bottom center of the screen, stacked vertically above the mini-player (same `z-50` layer, `mb-[mini-player-height]` offset).

Each toast:
- Displays message and action buttons
- If `countdown` is set: shows a shrinking progress bar (CSS transition driven by a `setInterval` tick in the component); when countdown reaches 0, invokes `actions[0].callback()` then dismisses
- Non-countdown toasts auto-dismiss after `duration` (default 4s)
- Countdown toasts only dismiss via an action or explicit `dismiss(id)`

Animations: slide-in from bottom, fade-out on dismiss.

---

## 2. AutoHuntService

Provided in root. One public method:

```ts
hunt(
  album: DiscographyAlbum,
  artistName: string,
  openManual: () => void,
): void
```

### State machine

```
idle
  → searching (silent — no toast until result arrives)
    → [best ≥ 60%] countdown (show countdown toast)
        → [countdown expires or "Download Now"] downloading
            → [success] success toast (auto-dismiss 4s) + kickPoll()
            → [error]   error toast with [Dismiss] [Find Manually]
        → [Cancel]        dismiss toast
        → [Choose Manually] dismiss toast + openManual()
    → [best < 60% or no candidates] error toast "No confident match for [Album]"
                                     with [Dismiss] [Find Manually → openManual()]
    → [hunt throws]       error toast "Search failed for [Album]"
                           with [Dismiss] [Try Again → re-run hunt()]
```

### Hunt logic

Reuses the same two-phase API calls as `AlbumHuntModalComponent`:
1. `DownloadsApiService.huntAlbumBase(lidarrId, { artistName, albumTitle, skewSearch: true })`
2. If `skewNeeded`: `DownloadsApiService.huntAlbumSkew(lidarrId, { artistName, albumTitle })`
3. Client-side merge via `mergeCandidates()` (extracted to a shared util in `lib/`)
4. Threshold: `bestCandidate.matchPct >= 60`

Download call:
- `DownloadsApiService.huntDownload(lidarrId, { selected, alternates }, false)`
- On 409 `already-complete` or `already-downloading`: show appropriate info toast (positive notice, not error)

### Concurrency

If `hunt()` is called while a hunt for the same `lidarrId` is already in progress, the second call is a no-op (guard by a `Set<string>` of in-flight IDs).

---

## 3. Caller Changes

**`artist-detail.component.ts`** and **`search.component.ts`**:

- Inject `AutoHuntService`
- Replace `openHunt(album)` with:
  ```ts
  this.autoHunt.hunt(album, artistName, () => this.huntingAlbum.set(album));
  ```
- The existing `huntingAlbum` signal, `closeHunt()`, and `<app-album-hunt-modal>` wiring remain — the manual modal is still reachable via the escape hatch

Button labels ("Find Album" / "Complete Album") and styling are unchanged.

---

## 4. Shared Utility

Extract `mergeCandidates()` from `album-hunt-modal.component.ts` into `packages/web/src/app/lib/merge-candidates.ts` so `AutoHuntService` can reuse it without importing from a component.

---

## 5. Testing

### `ToastService` unit tests
- `show()` adds a toast with a generated ID
- `dismiss(id)` removes the correct toast
- Capacity cap: 4th non-countdown toast evicts the oldest
- Countdown toasts survive eviction pressure

### `ToastOutletComponent` tests
- Renders toasts from the service
- Action button click invokes the callback
- Countdown progress bar renders when `countdown` is set

### `AutoHuntService` unit tests
- Hunt success ≥60%: shows countdown toast then downloads
- Hunt success <60%: shows "no confident match" error toast
- Hunt throws: shows "search failed" error toast
- Cancel action: dismisses toast without downloading
- "Choose Manually" action: calls `openManual()` callback
- Already-downloading 409: shows info toast, not error toast
- Concurrency guard: second `hunt()` for same lidarrId is no-op

### `merge-candidates.ts` unit tests (extracted from existing modal spec)
- De-duplication by `username::directory`
- Higher `matchPct` wins on collision
- Output sorted descending by `matchPct`

### Callers (`artist-detail`, `search`)
- Clicking "Find Album" calls `AutoHuntService.hunt()` (not `huntingAlbum.set()` directly)
- Manual modal still opens when `huntingAlbum` is set

---

## 6. Files Changed

| Action | Path |
|--------|------|
| new | `packages/web/src/app/services/toast.service.ts` |
| new | `packages/web/src/app/services/toast.service.spec.ts` |
| new | `packages/web/src/app/services/auto-hunt.service.ts` |
| new | `packages/web/src/app/services/auto-hunt.service.spec.ts` |
| new | `packages/web/src/app/components/toast-outlet/toast-outlet.component.ts` |
| new | `packages/web/src/app/components/toast-outlet/toast-outlet.component.html` |
| new | `packages/web/src/app/components/toast-outlet/toast-outlet.component.spec.ts` |
| new | `packages/web/src/app/lib/merge-candidates.ts` |
| new | `packages/web/src/app/lib/merge-candidates.spec.ts` |
| edit | `packages/web/src/app/components/album-hunt-modal/album-hunt-modal.component.ts` (remove inline `mergeCandidates`, import from lib) |
| edit | `packages/web/src/app/app.component.ts` (import `ToastOutletComponent`) |
| edit | `packages/web/src/app/app.component.html` (add `<app-toast-outlet />`) |
| edit | `packages/web/src/app/pages/library/artist-detail.component.ts` |
| edit | `packages/web/src/app/pages/search/search.component.ts` |
