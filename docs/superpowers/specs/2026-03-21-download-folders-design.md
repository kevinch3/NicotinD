# Download Folders — Design Spec

**Date:** 2026-03-21
**Status:** Approved

## Overview

Two complementary features that give users folder-aware access to Soulseek search results:

1. **Folder-grouped results** — toggle on the network search panel that groups files by directory instead of listing individual tracks. Pure frontend concern; no new API needed.
2. **User folder browser** — inline expansion panel that lets a user browse a peer's full shared library, deep-linked to the folder that contained the search result. Downloads a whole directory in one click.

The approach is progressive: folder-grouped view is instant (derived from existing search data), and the full browse is on-demand (async request to the remote peer, with graceful fallback).

---

## Problem Statement

NicotinD currently presents Soulseek results at the track level. Experienced Soulseek users know that grabbing a complete folder from a trusted peer is often preferable — consistent bitrate, complete tracklist, properly tagged. There is no way to:

- See which users have a complete album folder
- Browse what else a peer has beyond the current search query
- Download a whole directory in one action

---

## User Flow

```
Search results (network tab)
  └── Toggle: [Tracks] / [Folders]
        └── Folders view groups files by directory
              Each folder group shows:
                - Username, bitrate, free upload slots, file count
                - [Download folder] — queues the files from this group (may be partial — known limitation)
                - [Browse library] — only shown when canBrowse === true (see §1 below)
                      └── Inline panel expands below the row
                            ├── Loading state (requesting shares from peer)
                            ├── On success: full tree, deep-linked to matched folder
                            │     ├── Left: folder tree (path-constructed from flat list)
                            │     └── Right: files in selected folder + [Download all (N)] button
                            └── On failure: search-result files + error notice
```

---

## Architecture

### What changes

#### 1. `packages/api/src/routes/search.ts` (extend) — add `canBrowse` to network poll response

The `GET /api/search/:searchId/network` response gains a `canBrowse: boolean` field at the top level, set by checking whether the network provider implements `IBrowseProvider`:

```typescript
const canBrowse = 'browseUser' in provider && typeof (provider as any).browseUser === 'function'
return c.json({ state, responseCount, results, canBrowse })
```

The frontend reads `canBrowse` from the poll response and uses it to conditionally render the "Browse library" button on all result rows. No per-row flag needed — all rows from the same search share the same provider.

#### 2. `packages/core/src/types/provider.ts` (extend)

Add `BrowseDirectory` (canonical shared type, exported from `@nicotind/core`) and `IBrowseProvider`:

```typescript
export interface BrowseDirectory {
  name: string        // full directory path, e.g. "Music\Babasonicos\Repuesto de Fe"
  fileCount: number
  files: Array<{
    filename: string  // full file path, e.g. "Music\Babasonicos\Repuesto de Fe\01 - Impacto.mp3"
    size: number
    bitRate?: number
    length?: number
  }>
}

export interface IBrowseProvider {
  readonly name: string
  browseUser(username: string): Promise<BrowseDirectory[]>
}
```

Also add a sentinel error class for the "provider not available" case:

```typescript
export class BrowseUnavailableError extends Error {
  constructor() { super('browse provider not available') }
}
```

#### 3. `packages/slskd-client/src/api/users.ts` (new)

New `UsersApi` class following the same pattern as `SearchesApi`, `TransfersApi`, etc.:

```typescript
import type { BrowseDirectory } from '@nicotind/core'
import type { SlskdClient } from '../client'

export class UsersApi {
  constructor(private readonly client: SlskdClient) {}

  async browseUser(username: string): Promise<BrowseDirectory[]> {
    // SlskdClient.request() prepends /api/v0 internally — path starts from /users/
    // Endpoint: GET /api/v0/users/{username}/browse (slskd REST API, standard endpoint)
    // Raw response is a flat array of directory objects; extra fields (e.g. lockedFiles) are stripped.
    const raw = await this.client.request<any[]>(`/users/${encodeURIComponent(username)}/browse`)
    return raw.map((dir: any) => ({
      name: dir.name,
      fileCount: dir.fileCount,
      files: (dir.files ?? []).map((f: any) => ({
        filename: f.filename,
        size: f.size,
        bitRate: f.bitRate,
        length: f.length,
      })),
    }))
  }
}
```

**Note on endpoint verification:** `GET /api/v0/users/{username}/browse` is a standard slskd REST endpoint (visible in slskd's Swagger UI at `/swagger`). If the slskd instance is running, the implementer should verify the response shape at `/api/v0/users/{username}/browse` before relying on the mapping above. The `dir.name`, `dir.fileCount`, and `dir.files[].filename` field names are assumed based on slskd's documented API; adjust the mapping if the actual response differs.

The `Slskd` facade class (`packages/slskd-client/src/index.ts`) gains:
- `public users: UsersApi` property
- `this.users = new UsersApi(this.client)` wired in its constructor alongside existing sub-APIs

`SlskdClient` (low-level HTTP primitive) is unchanged.

#### 4. `packages/api/src/services/providers/slskd-provider.ts` (extend)

`SlskdSearchProvider` declares it implements `IBrowseProvider` and adds:

```typescript
async browseUser(username: string): Promise<BrowseDirectory[]> {
  if (!this.slskdRef.current) throw new BrowseUnavailableError()
  return this.slskdRef.current.users.browseUser(username)
}
```

Uses `this.slskdRef.current` — the `Slskd` facade ref pattern used throughout this class. Throws `BrowseUnavailableError` (not a generic `Error`) so the route can distinguish this case from network failures.

#### 5. `packages/api/src/services/provider-registry.ts` (extend)

Add `getBrowseProvider()` only. `register()` signature and the internal map type are **unchanged** — `SlskdSearchProvider` satisfies `ISearchProvider` (its existing registered type), so no call sites change. The duck-type check works at runtime because `SlskdSearchProvider` will have the `browseUser` method:

```typescript
getBrowseProvider(): IBrowseProvider | null {
  for (const provider of this.providers.values()) {
    if ('browseUser' in provider && typeof (provider as IBrowseProvider).browseUser === 'function') {
      return provider as IBrowseProvider
    }
  }
  return null
}
```

#### 6. `packages/api/src/routes/users.ts` (new)

Route factory: `usersRoutes(registry: ProviderRegistry): Hono`

```
GET /api/users/:username/browse
```

- `registry.getBrowseProvider()` → `null` → 501
- 30-second timeout on `browseUser()` call using `AbortSignal.timeout(30_000)` passed through the call chain (or a `Promise.race` with a timeout reject) → 504 on timeout
- `BrowseUnavailableError` thrown by provider → 503
- Any other error from slskd → 502
- Returns `BrowseDirectory[]`

**Wiring in `packages/api/src/index.ts`** (following the exact pattern of existing routes):

```typescript
app.use('/api/users/*', auth)           // JWT guard — add alongside existing auth lines (line ~108)
app.route('/api/users', usersRoutes(registry))  // add after other app.route() calls
```

Confirmed: no existing routes use the `/api/users/*` path — no conflict.

#### 7. Frontend — `packages/web/` (extend)

**Folder toggle on network results:**
- Toggle: `Tracks | Folders` on the network results panel
- Folders mode: group result files by extracted directory path (strip basename from `filename`)
- Each folder group row: username · inferred bitrate · free slots · file count · `[Download folder]` · `[Browse library]`
- `[Browse library]` rendered only when `canBrowse === true` (from poll response)

**Inline folder browser:**
- Expands below the user's result row (collapsible)
- Immediate state: shows search-result-derived files for that directory (no loading delay). Matched directory path extracted from the first file's `filename` by stripping the basename.
- Fires `GET /api/users/:username/browse` in the background on expand
- On load: renders full tree; left panel expanded to the matched directory path
- On failure (4xx / 5xx / 504): retains search-result files, shows notice: *"Couldn't load full library — showing files from search results"*

**Tree construction:**
- Single-pass over flat `BrowseDirectory[]` — split each `name` on `\` to build a nested node tree
- Left panel: tree navigation. Right panel: direct files of the currently selected left-tree node.
- "Direct files" = files whose `filename` path begins with the selected node's `name` and has no further subdirectory separator after it.

**`[Download all (N)]`:**
- N = count of direct files in the currently selected left-tree node (non-recursive)
- Payload: `POST /api/downloads` with `{ username, files: [{ filename, size }] }` using full-path `filename` values

### What does NOT change

- `ISearchProvider` interface — unchanged
- Existing search routes (`/api/search/*`) — unchanged except `canBrowse` addition to poll response
- Download endpoint (`POST /api/downloads`) — unchanged
- Download watcher, metadata fixer — unchanged

---

## Error Handling

| Scenario | API response | Frontend behavior |
|---|---|---|
| Peer offline / denies browse | 4xx from slskd → propagated as 502 | Fallback to search-result files + notice |
| Browse times out (>30s) | 504 | Same fallback |
| No `IBrowseProvider` registered | 501 | "Browse library" button hidden (`canBrowse = false`) |
| `slskdRef.current` null | 503 (`BrowseUnavailableError`) | Same fallback |
| No files in search results for folder | — | "Download folder" button disabled / hidden |
| `POST /api/downloads` failure | — | Existing error handling (unchanged) |

---

## Known Limitation

`[Download folder]` on the folder-grouped row uses only the files that appeared in the search result for that directory. Soulseek searches frequently return a subset of an album's tracks. Users who want the complete folder should use **Browse library** to get the authoritative file list before downloading.

---

## Out of Scope

- Search-by-folder as a new query mode (the toggle is a presentation change only)
- Caching browse results (slskd handles its own internal cache)
- Recursive / multi-folder download
- The unrelated download error reporting bug ("0 of 1 tracks / Error") — separate issue
