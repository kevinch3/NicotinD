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
                - [Download folder] — queues all files from this group
                - [Browse library] — opens inline expansion
                      └── Inline panel expands below the row
                            ├── Loading state (requesting shares from peer)
                            ├── On success: full tree, deep-linked to matched folder
                            │     ├── Left: folder tree (path-constructed from flat list)
                            │     └── Right: file list + [Download all (N)] button
                            └── On failure: search-result files + error notice
```

---

## Architecture

### What changes

#### 1. `packages/slskd-client/src/api/users.ts` (new)

Wraps slskd's `GET /api/v0/users/{username}/browse`:

```typescript
browse(username: string): Promise<SlskdUserDirectory[]>
```

#### 2. `packages/core/src/types/slskd.ts` (extend)

```typescript
interface SlskdUserDirectory {
  name: string        // full path string, e.g. "Music\Babasonicos\Repuesto de Fe"
  fileCount: number
  files: Array<{
    filename: string  // filename only, not full path
    size: number
    bitRate?: number
    length?: number
  }>
}
```

slskd returns a flat list of directories (not a tree). The frontend constructs the tree from the path strings.

#### 3. `packages/api/src/routes/users.ts` (new)

```
GET /api/users/:username/browse
```

- Requires JWT auth
- Proxies to slskd `users.browse(username)`
- Returns `SlskdUserDirectory[]`
- On slskd error: propagates HTTP status + message for frontend to display

#### 4. Frontend — `packages/web/` (extend)

**Folder toggle on network results:**
- Toggle button: `Tracks | Folders` on the network results panel
- In Folders mode: group result files by extracted directory path
- Each folder group row: username · inferred bitrate · free slots · file count · `[Download folder]` · `[Browse library]`

**Inline folder browser:**
- Expands below the user's result row (collapsible)
- Initial state: shows search-result-derived files for that folder (instant)
- Fires `GET /api/users/:username/browse` in background
- On load: replaces content with full tree, scrolled/expanded to matched directory
- On failure: retains search-result files, shows notice: *"Couldn't load full library — showing files from search results"*
- Tree construction: single-pass path parsing to build nested structure from flat directory list
- `[Download all (N)]` sends all files in current directory to `POST /api/downloads`

### What does NOT change

- `ISearchProvider` interface — unchanged
- Existing search routes (`/api/search/*`) — unchanged
- Download endpoint (`POST /api/downloads`) — unchanged
- Download watcher, metadata fixer — unchanged

---

## Provider Flexibility

Folder browsing is intentionally decoupled from `ISearchProvider`. A separate optional `IBrowseProvider` interface allows future providers to opt in:

```typescript
interface IBrowseProvider {
  browseUser(username: string): Promise<SlskdUserDirectory[]>
}
```

The users route routes to whichever registered provider implements this interface. slskd is the only one today. Providers that don't implement `IBrowseProvider` don't expose the "Browse library" button in their result rows.

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Peer offline / denies browse | 4xx from slskd → inline panel shows search-result files + notice |
| Browse times out | Treat as failure, same fallback |
| No files in search results for folder | "Download folder" button disabled / hidden |
| `POST /api/downloads` failure | Existing error handling (unchanged) |

---

## Out of Scope

- Search-by-folder as a new query mode (the toggle is a presentation change only)
- Caching browse results (slskd handles its own internal cache)
- Multi-folder selection or batch folder queuing
- The unrelated download error reporting bug ("0 of 1 tracks / Error") — separate issue
