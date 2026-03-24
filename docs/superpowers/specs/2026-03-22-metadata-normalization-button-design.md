# Metadata Normalization Button — Design Spec

**Date:** 2026-03-22
**Status:** Approved

---

## Problem

The Downloads view shows recently added songs. A `MetadataFixer` service runs automatically on download completion via `DownloadWatcher`, using MusicBrainz lookups and ID3 tag writes. However:

- It skips files that already have complete tags (even if the values are wrong)
- Some tracks end up with messy/incorrect metadata from incomplete Soulseek sources

Users need a manual way to re-trigger normalization on specific tracks after reviewing them.

---

## Solution

A **"Normalize metadata"** button in the bulk action bar of the Recently Added section. Users select one or more tracks via existing checkboxes, click the button, and see inline per-row status as each track is processed sequentially via MusicBrainz.

---

## Scope

- **Source:** MusicBrainz (existing integration in `MetadataFixer`)
- **Targets:** User-selected tracks from Recently Added list
- **Mode:** Force — always queries MusicBrainz even when tags are fully populated
- **Progress:** Inline per-row status icons (pending → running → fixed/skipped/failed)

---

## Architecture

### Backend

**New method: `MetadataFixer.fixFileAtAbsolutePath()`**
(`packages/api/src/services/metadata-fixer.ts`)

```typescript
async fixFileAtAbsolutePath(
  absolutePath: string,
  hint: ParsedMetadata,
): Promise<{ fixed: boolean; changes: Partial<ParsedMetadata> }>
```

- Takes an absolute path directly (no `resolveLocalPath` needed)
- Uses `hint` (Navidrome title/artist/album) as the MusicBrainz search query
- Force mode: does NOT skip when all tags already have values
- Only processes `.mp3` files; returns `{ fixed: false, changes: {} }` for others
- Reuses `lookupMusicBrainz()`, `chooseValue()`, `getNodeId3()`, rate-limiting logic

**New route: `POST /api/library/songs/:id/fix-metadata`**
(`packages/api/src/routes/library.ts`)

1. Guard: 500 if `musicDir` or `metadataFixer` not configured
2. `getSong(id)` → path, title, artist, album
3. Resolve + safety-check path with existing `resolveSongPath` / `isUnderMusicDir`
4. Call `metadataFixer.fixFileAtAbsolutePath(fullPath, hint)`
5. If fixed: trigger non-full Navidrome scan
6. Return `{ fixed: boolean; changes: { title?, artist?, album? } }`

**Wiring:** `libraryRoutes(navidrome, musicDir?, metadataFixer?)` — same `MetadataFixer` instance as `DownloadWatcher` so MusicBrainz rate limits are shared.

### Frontend

**New state in `DownloadsPage`:**
```typescript
type NormState = 'pending' | 'running' | 'fixed' | 'skipped' | 'failed';
const [normStatus, setNormStatus] = useState<Map<string, NormState>>(new Map());
const [normalizing, setNormalizing] = useState(false);
```

**`normalizeSelected()` function:**
- Sets all selected IDs to `'pending'`
- Loops sequentially: set `'running'` → POST → set `'fixed'`/`'skipped'`/`'failed'`
- Calls `fetchRecentSongs()` when done to reflect updated metadata

**Bulk action bar button:** "Normalize metadata" / "Normalizing…" (disabled during run), placed between "Add to playlist" and "Delete".

**Per-row indicators:** Small icon in the song row, visible only while/after normalization:
- `pending` → dim dot
- `running` → spinner
- `fixed` → ✓ emerald
- `skipped` → — zinc (no match found)
- `failed` → ✗ red

---

## Trade-offs Considered

| Option | Chosen? | Reason |
|--------|---------|--------|
| Sequential per-track API calls | ✅ | Natural per-row progress, simple, respects rate limit |
| Batch endpoint (all at once) | ✗ | No incremental feedback, long wait |
| SSE streaming batch | ✗ | Overkill given sequential calls already deliver real-time UX |
| AcoustID fingerprinting | ✗ | More accurate but adds dependency; MusicBrainz sufficient |
| Auto-clear status after timeout | ✗ | Not needed per user preference |

---

## Files Changed

| File | Change |
|------|--------|
| `packages/api/src/services/metadata-fixer.ts` | Add `fixFileAtAbsolutePath()` |
| `packages/api/src/routes/library.ts` | Add route + `metadataFixer` param |
| `src/main.ts` | Pass MetadataFixer to `libraryRoutes()` |
| `packages/web/src/lib/api.ts` | Add `fixSongMetadata()` |
| `packages/web/src/pages/Downloads.tsx` | State + function + button + indicators |
