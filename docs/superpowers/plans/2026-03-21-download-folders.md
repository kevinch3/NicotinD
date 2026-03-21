# Download Folders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add folder-grouped search results and an inline user folder browser to NicotinD, so users can download a whole Soulseek directory in one click.

**Architecture:** Core types first (`BrowseDirectory`, `IBrowseProvider`), then the slskd HTTP client wrapper, then the API provider/registry/route changes, then the React frontend. Each layer depends strictly on the one before it — implement in the order listed.

**Tech Stack:** Bun (runtime + test runner), TypeScript, Hono (API routes), React + Zustand (frontend), `bun:test` for tests.

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Modify | `packages/core/src/types/provider.ts` | Add `BrowseDirectory`, `IBrowseProvider`, `BrowseUnavailableError`; extend `NetworkPollResult` |
| Create | `packages/slskd-client/src/api/users.ts` | `UsersApi` class wrapping slskd browse endpoint |
| Modify | `packages/slskd-client/src/index.ts` | Add `users: UsersApi` to `Slskd` facade |
| Modify | `packages/api/src/services/providers/slskd-provider.ts` | Implement `IBrowseProvider` on `SlskdSearchProvider` |
| Modify | `packages/api/src/services/provider-registry.ts` | Add `getBrowseProvider()` |
| Modify | `packages/api/src/routes/search.ts` | Append `canBrowse` to poll response |
| Create | `packages/api/src/routes/users.ts` | `GET /api/users/:username/browse` route |
| Modify | `packages/api/src/index.ts` | Wire users route + auth middleware |
| Modify | `packages/web/src/lib/api.ts` | Add `browseUser()`, update `pollNetwork` type |
| Create | `packages/web/src/lib/folderUtils.ts` | Pure helpers: extract directory, group by dir, build tree |
| Create | `packages/web/src/components/FolderBrowser.tsx` | Left tree + right file list component |
| Modify | `packages/web/src/pages/Search.tsx` | Tracks/Folders toggle + inline FolderBrowser |

---

## Task 1: Core types — `BrowseDirectory`, `IBrowseProvider`, `BrowseUnavailableError`

**Files:**
- Modify: `packages/core/src/types/provider.ts`

These are pure TypeScript types — no test needed. But we run typecheck after to confirm.

- [ ] **Step 1: Add types to `packages/core/src/types/provider.ts`**

  Append to the end of the file:

  ```typescript
  export interface BrowseDirectory {
    name: string;       // full directory path, e.g. "Music\\Babasonicos\\Repuesto de Fe"
    fileCount: number;
    files: Array<{
      filename: string; // full file path, e.g. "Music\\Babasonicos\\Repuesto de Fe\\01 - Impacto.mp3"
      size: number;
      bitRate?: number;
      length?: number;
    }>;
  }

  export interface IBrowseProvider {
    readonly name: string;
    browseUser(username: string): Promise<BrowseDirectory[]>;
  }

  export class BrowseUnavailableError extends Error {
    constructor() {
      super('browse provider not available');
      this.name = 'BrowseUnavailableError';
    }
  }
  ```

  Also extend `NetworkPollResult` — add one optional field:

  ```typescript
  // Before:
  export interface NetworkPollResult {
    state: 'searching' | 'complete';
    responseCount: number;
    results: Array<{ ... }>;
  }

  // After — add canBrowse at the end:
  export interface NetworkPollResult {
    state: 'searching' | 'complete';
    responseCount: number;
    results: Array<{ ... }>;
    canBrowse?: boolean;
  }
  ```

- [ ] **Step 2: Verify typecheck passes**

  Run: `bun run typecheck`
  Expected: no errors

- [ ] **Step 3: Commit**

  ```bash
  git add packages/core/src/types/provider.ts
  git commit -m "feat(core): add BrowseDirectory, IBrowseProvider, BrowseUnavailableError types"
  ```

---

## Task 2: slskd `UsersApi` and facade wiring

**Files:**
- Create: `packages/slskd-client/src/api/users.ts`
- Modify: `packages/slskd-client/src/index.ts`

The slskd REST endpoint `GET /api/v0/users/{username}/browse` returns a flat list of directories. `SlskdClient.request()` prepends `/api/v0` automatically, so paths passed to it start from `/users/...`. Verify the actual response shape in slskd's Swagger UI at `http://localhost:5030/swagger` if available — adjust field names if they differ.

- [ ] **Step 1: Create `packages/slskd-client/src/api/users.ts`**

  ```typescript
  import type { BrowseDirectory } from '@nicotind/core';
  import type { SlskdClient } from '../client.js';

  export class UsersApi {
    constructor(private readonly client: SlskdClient) {}

    async browseUser(username: string): Promise<BrowseDirectory[]> {
      const raw = await this.client.request<any[]>(
        `/users/${encodeURIComponent(username)}/browse`,
      );
      return raw.map((dir: any) => ({
        name: dir.name,
        fileCount: dir.fileCount,
        files: (dir.files ?? []).map((f: any) => ({
          filename: f.filename,
          size: f.size,
          bitRate: f.bitRate,
          length: f.length,
        })),
      }));
    }
  }
  ```

- [ ] **Step 2: Wire `UsersApi` into the `Slskd` facade in `packages/slskd-client/src/index.ts`**

  Add the import:
  ```typescript
  import { UsersApi } from './api/users.js';
  ```

  Add the property declaration inside the `Slskd` class (after `options: OptionsApi`):
  ```typescript
  public users: UsersApi;
  ```

  Add the constructor line (after `this.options = new OptionsApi(this.client)`):
  ```typescript
  this.users = new UsersApi(this.client);
  ```

- [ ] **Step 3: Run typecheck**

  Run: `bun run typecheck`
  Expected: no errors

- [ ] **Step 4: Commit**

  ```bash
  git add packages/slskd-client/src/api/users.ts packages/slskd-client/src/index.ts
  git commit -m "feat(slskd-client): add UsersApi with browseUser endpoint"
  ```

---

## Task 3: `SlskdSearchProvider` implements `IBrowseProvider`

**Files:**
- Modify: `packages/api/src/services/providers/slskd-provider.ts`
- Test: `packages/api/src/routes/search.test.ts` (extend existing)

- [ ] **Step 1: Write the failing test**

  Open `packages/api/src/routes/search.test.ts`. Add a new `it` block inside the existing `describe('search routes', ...)`:

  ```typescript
  it('poll response includes canBrowse: true when provider supports browsing', async () => {
    const slskdRef = {
      current: {
        searches: {
          create: async () => ({ id: 'slskd-search-1' }),
          get: async () => ({ state: 'InProgress', responseCount: 0 }),
          getResponses: async () => [],
          list: async () => [],
          delete: async () => undefined,
          cancel: async () => undefined,
        },
        users: {
          browseUser: async () => [],
        },
      },
    } as any;

    const registry = new ProviderRegistry();
    registry.register(new SlskdSearchProvider(slskdRef));

    const app = new Hono();
    app.route('/', searchRoutes(registry));

    const searchRes = await app.request('/?q=test');
    const { searchId } = await searchRes.json();

    const pollRes = await app.request(`/${searchId}/network`);
    const body = await pollRes.json();

    expect(body.canBrowse).toBe(true);
  });
  ```

- [ ] **Step 2: Run test to confirm it fails**

  Run: `bun test packages/api/src/routes/search.test.ts`
  Expected: FAIL — `canBrowse` is undefined

- [ ] **Step 3: Implement `browseUser` on `SlskdSearchProvider`**

  In `packages/api/src/services/providers/slskd-provider.ts`, add the import at the top:

  ```typescript
  import type { ISearchProvider, ProviderType, NetworkPollResult, IBrowseProvider, BrowseDirectory, BrowseUnavailableError as BrowseUnavailableErrorType } from '@nicotind/core';
  import { BrowseUnavailableError } from '@nicotind/core';
  ```

  Change the class declaration:
  ```typescript
  export class SlskdSearchProvider implements ISearchProvider, IBrowseProvider {
  ```

  Add at the end of the class (before the closing `}`):
  ```typescript
  async browseUser(username: string): Promise<BrowseDirectory[]> {
    if (!this.slskdRef.current) throw new BrowseUnavailableError();
    return this.slskdRef.current.users.browseUser(username);
  }
  ```

- [ ] **Step 4: Extend the poll handler in `packages/api/src/routes/search.ts` to append `canBrowse`**

  Find the poll handler (around line 82). Replace the inner `try` block:

  ```typescript
  // Before:
  app.get('/:searchId/network', async (c) => {
    const searchId = c.req.param('searchId');

    for (const provider of registry.getByType('network')) {
      if (provider.pollResults) {
        try {
          return c.json(await provider.pollResults(searchId));
        } catch {
          return c.json({ state: 'complete', responseCount: 0, results: [] });
        }
      }
    }

    return c.json({ state: 'complete', responseCount: 0, results: [] });
  });

  // After:
  app.get('/:searchId/network', async (c) => {
    const searchId = c.req.param('searchId');

    for (const provider of registry.getByType('network')) {
      if (provider.pollResults) {
        const canBrowse =
          'browseUser' in provider &&
          typeof (provider as any).browseUser === 'function';
        try {
          const result = await provider.pollResults(searchId);
          return c.json({ ...result, canBrowse });
        } catch {
          return c.json({ state: 'complete', responseCount: 0, results: [], canBrowse });
        }
      }
    }

    return c.json({ state: 'complete', responseCount: 0, results: [], canBrowse: false });
  });
  ```

- [ ] **Step 5: Run tests to confirm they pass**

  Run: `bun test packages/api/src/routes/search.test.ts`
  Expected: all PASS

- [ ] **Step 6: Run typecheck**

  Run: `bun run typecheck`
  Expected: no errors

- [ ] **Step 7: Commit**

  ```bash
  git add packages/api/src/services/providers/slskd-provider.ts packages/api/src/routes/search.ts packages/api/src/routes/search.test.ts
  git commit -m "feat(api): SlskdSearchProvider implements IBrowseProvider; poll response includes canBrowse"
  ```

---

## Task 4: `ProviderRegistry.getBrowseProvider()`

**Files:**
- Modify: `packages/api/src/services/provider-registry.ts`

No separate test file exists for the registry. We'll verify through the users route tests in Task 5.

- [ ] **Step 1: Add `getBrowseProvider()` to `packages/api/src/services/provider-registry.ts`**

  Add the import at the top:
  ```typescript
  import type { ISearchProvider, ProviderType, IBrowseProvider } from '@nicotind/core';
  ```

  Add the method inside `ProviderRegistry` (after `getAll()`):

  ```typescript
  getBrowseProvider(): IBrowseProvider | null {
    for (const provider of this.providers.values()) {
      if (
        'browseUser' in provider &&
        typeof (provider as IBrowseProvider).browseUser === 'function'
      ) {
        return provider as IBrowseProvider;
      }
    }
    return null;
  }
  ```

- [ ] **Step 2: Run typecheck**

  Run: `bun run typecheck`
  Expected: no errors

- [ ] **Step 3: Commit**

  ```bash
  git add packages/api/src/services/provider-registry.ts
  git commit -m "feat(api): add ProviderRegistry.getBrowseProvider()"
  ```

---

## Task 5: Users route `GET /api/users/:username/browse`

**Files:**
- Create: `packages/api/src/routes/users.ts`
- Create: `packages/api/src/routes/users.test.ts`
- Modify: `packages/api/src/index.ts`

The route has a 30-second timeout. We implement it with `Promise.race` against a timeout reject. `BrowseUnavailableError` → 503, timeout → 504, other errors → 502.

- [ ] **Step 1: Write the failing test — create `packages/api/src/routes/users.test.ts`**

  ```typescript
  import { describe, expect, it } from 'bun:test';
  import { Hono } from 'hono';
  import { usersRoutes } from './users.js';
  import { ProviderRegistry } from '../services/provider-registry.js';
  import { SlskdSearchProvider } from '../services/providers/slskd-provider.js';

  function makeRegistry(browseDirs: any[] = [], shouldThrow?: string) {
    const slskdRef = {
      current: {
        searches: {
          create: async () => ({ id: 'x' }),
          get: async () => ({ state: 'InProgress', responseCount: 0 }),
          getResponses: async () => [],
          list: async () => [],
          delete: async () => undefined,
          cancel: async () => undefined,
        },
        users: {
          browseUser: shouldThrow
            ? async () => { throw new Error(shouldThrow) }
            : async () => browseDirs,
        },
      },
    } as any;
    const registry = new ProviderRegistry();
    registry.register(new SlskdSearchProvider(slskdRef));
    return registry;
  }

  describe('users routes', () => {
    it('returns browse directories for a valid username', async () => {
      const dirs = [{ name: 'Music\\Artist', fileCount: 1, files: [{ filename: 'Music\\Artist\\01.mp3', size: 5000 }] }];
      const registry = makeRegistry(dirs);

      const app = new Hono();
      app.route('/', usersRoutes(registry));

      const res = await app.request('/testuser/browse');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(dirs);
    });

    it('returns 501 when no IBrowseProvider is registered', async () => {
      const registry = new ProviderRegistry();

      const app = new Hono();
      app.route('/', usersRoutes(registry));

      const res = await app.request('/testuser/browse');
      expect(res.status).toBe(501);
    });

    it('returns 503 when slskdRef.current is null', async () => {
      const slskdRef = { current: null } as any;
      const registry = new ProviderRegistry();
      registry.register(new SlskdSearchProvider(slskdRef));

      const app = new Hono();
      app.route('/', usersRoutes(registry));

      const res = await app.request('/testuser/browse');
      expect(res.status).toBe(503);
    });
  });
  ```

- [ ] **Step 2: Run test to confirm it fails**

  Run: `bun test packages/api/src/routes/users.test.ts`
  Expected: FAIL — `usersRoutes` not found

- [ ] **Step 3: Create `packages/api/src/routes/users.ts`**

  ```typescript
  import { Hono } from 'hono';
  import type { AuthEnv } from '../middleware/auth.js';
  import type { ProviderRegistry } from '../services/provider-registry.js';
  import { BrowseUnavailableError } from '@nicotind/core';

  const BROWSE_TIMEOUT_MS = 30_000;

  export function usersRoutes(registry: ProviderRegistry) {
    const app = new Hono<AuthEnv>();

    app.get('/:username/browse', async (c) => {
      const username = c.req.param('username');

      const provider = registry.getBrowseProvider();
      if (!provider) {
        return c.json({ error: 'Browse not supported' }, 501);
      }

      try {
        const dirs = await Promise.race([
          provider.browseUser(username),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('TIMEOUT')), BROWSE_TIMEOUT_MS),
          ),
        ]);
        return c.json(dirs);
      } catch (err) {
        if (err instanceof BrowseUnavailableError) {
          return c.json({ error: 'Browse provider not available' }, 503);
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'TIMEOUT') {
          return c.json({ error: 'Browse request timed out' }, 504);
        }
        return c.json({ error: `Browse failed: ${msg}` }, 502);
      }
    });

    return app;
  }
  ```

- [ ] **Step 4: Run tests to confirm they pass**

  Run: `bun test packages/api/src/routes/users.test.ts`
  Expected: all PASS

- [ ] **Step 5: Wire the route into `packages/api/src/index.ts`**

  Add the import (alongside other route imports):
  ```typescript
  import { usersRoutes } from './routes/users.js';
  ```

  Add auth middleware (alongside the other `app.use` lines, around line 108):
  ```typescript
  app.use('/api/users/*', auth);
  ```

  Add the route (after the last `app.route` call, before the static file serving block):
  ```typescript
  app.route('/api/users', usersRoutes(registry));
  ```

- [ ] **Step 6: Run typecheck**

  Run: `bun run typecheck`
  Expected: no errors

- [ ] **Step 7: Commit**

  ```bash
  git add packages/api/src/routes/users.ts packages/api/src/routes/users.test.ts packages/api/src/index.ts
  git commit -m "feat(api): add GET /api/users/:username/browse route with timeout handling"
  ```

---

## Task 6: Frontend API client — `browseUser` + updated `pollNetwork` type

**Files:**
- Modify: `packages/web/src/lib/api.ts`

No test here — this is a thin typed wrapper. Typecheck is the guard.

- [ ] **Step 1: Update `pollNetwork` return type to include `canBrowse`**

  Find the `pollNetwork` entry in `api.ts`. Update its return type annotation:

  ```typescript
  // Before:
  pollNetwork: (searchId: string) =>
    request<{
      state: 'searching' | 'complete';
      responseCount: number;
      results: Array<{ ... }>;
    }>(`/api/search/${searchId}/network`),

  // After — add canBrowse:
  pollNetwork: (searchId: string) =>
    request<{
      state: 'searching' | 'complete';
      responseCount: number;
      canBrowse?: boolean;
      results: Array<{
        username: string;
        freeUploadSlots: boolean;
        uploadSpeed: number;
        files: Array<{
          filename: string;
          size: number;
          bitRate?: number;
          length?: number;
          title?: string;
          artist?: string;
          album?: string;
          trackNumber?: string;
        }>;
      }>;
    }>(`/api/search/${searchId}/network`),
  ```

- [ ] **Step 2: Add `browseUser` to the `api` object**

  Add after the `enqueueDownload` entry:

  ```typescript
  browseUser: (username: string) =>
    request<Array<{
      name: string;
      fileCount: number;
      files: Array<{ filename: string; size: number; bitRate?: number; length?: number }>;
    }>>(`/api/users/${encodeURIComponent(username)}/browse`),
  ```

- [ ] **Step 3: Run typecheck**

  Run: `bun run typecheck`
  Expected: no errors

- [ ] **Step 4: Commit**

  ```bash
  git add packages/web/src/lib/api.ts
  git commit -m "feat(web): add browseUser API call and canBrowse to pollNetwork type"
  ```

---

## Task 7: Frontend folder utilities (pure functions, fully testable)

**Files:**
- Create: `packages/web/src/lib/folderUtils.ts`
- Create: `packages/web/src/lib/folderUtils.test.ts`

These are pure functions — no DOM, no React. Test them in isolation.

> **Background:** Soulseek paths use backslash as separator (e.g. `Music\Artist\Album\01.mp3`). The directory `name` field from slskd also uses backslash. JavaScript's path utilities don't handle backslash on Linux, so we split manually.

- [ ] **Step 1: Write the failing tests — create `packages/web/src/lib/folderUtils.test.ts`**

  ```typescript
  import { describe, expect, it } from 'bun:test';
  import {
    extractDirectory,
    groupByDirectory,
    buildFolderTree,
    getDirectFiles,
    type FolderNode,
  } from './folderUtils';

  describe('extractDirectory', () => {
    it('extracts the directory from a backslash-separated path', () => {
      expect(extractDirectory('Music\\Artist\\Album\\01.mp3')).toBe('Music\\Artist\\Album');
    });

    it('returns empty string for a bare filename', () => {
      expect(extractDirectory('song.mp3')).toBe('');
    });
  });

  describe('groupByDirectory', () => {
    it('groups files by their directory path', () => {
      const files = [
        { username: 'alice', uploadSpeed: 1000, filename: 'A\\B\\01.mp3', size: 100, bitRate: 320 },
        { username: 'alice', uploadSpeed: 1000, filename: 'A\\B\\02.mp3', size: 100, bitRate: 320 },
        { username: 'bob', uploadSpeed: 500, filename: 'A\\C\\01.mp3', size: 100, bitRate: 192 },
      ];
      const groups = groupByDirectory(files);
      expect(groups).toHaveLength(2);
      expect(groups[0].directory).toBe('A\\B');
      expect(groups[0].username).toBe('alice');
      expect(groups[0].files).toHaveLength(2);
    });
  });

  describe('buildFolderTree', () => {
    it('builds a nested tree from a flat directory list', () => {
      const dirs = [
        { name: 'Music', fileCount: 0, files: [] },
        { name: 'Music\\Artist', fileCount: 0, files: [] },
        { name: 'Music\\Artist\\Album', fileCount: 2, files: [
          { filename: 'Music\\Artist\\Album\\01.mp3', size: 100 },
          { filename: 'Music\\Artist\\Album\\02.mp3', size: 100 },
        ]},
      ];
      const tree = buildFolderTree(dirs);
      expect(tree).toHaveLength(1);
      expect(tree[0].segment).toBe('Music');
      expect(tree[0].children).toHaveLength(1);
      expect(tree[0].children[0].segment).toBe('Artist');
    });
  });

  describe('getDirectFiles', () => {
    it('returns only files whose directory is the selected node path', () => {
      const dirs = [
        { name: 'Music\\Artist\\Album', fileCount: 2, files: [
          { filename: 'Music\\Artist\\Album\\01.mp3', size: 100 },
          { filename: 'Music\\Artist\\Album\\02.mp3', size: 100 },
        ]},
      ];
      const files = getDirectFiles(dirs, 'Music\\Artist\\Album');
      expect(files).toHaveLength(2);
    });

    it('does not include files from subdirectories', () => {
      const dirs = [
        { name: 'Music\\Artist', fileCount: 1, files: [
          { filename: 'Music\\Artist\\01.mp3', size: 100 },
        ]},
        { name: 'Music\\Artist\\Album', fileCount: 1, files: [
          { filename: 'Music\\Artist\\Album\\01.mp3', size: 100 },
        ]},
      ];
      const files = getDirectFiles(dirs, 'Music\\Artist');
      expect(files).toHaveLength(1);
      expect(files[0].filename).toBe('Music\\Artist\\01.mp3');
    });
  });
  ```

- [ ] **Step 2: Run tests to confirm they fail**

  Run: `bun test packages/web/src/lib/folderUtils.test.ts`
  Expected: FAIL — module not found

- [ ] **Step 3: Create `packages/web/src/lib/folderUtils.ts`**

  ```typescript
  export interface BrowseFile {
    filename: string;
    size: number;
    bitRate?: number;
    length?: number;
  }

  export interface BrowseDir {
    name: string;
    fileCount: number;
    files: BrowseFile[];
  }

  export interface FolderGroup {
    username: string;
    uploadSpeed: number;
    directory: string;
    bitRate?: number;
    files: Array<{
      filename: string;
      size: number;
      bitRate?: number;
      length?: number;
      title?: string;
      artist?: string;
      album?: string;
      trackNumber?: string;
    }>;
  }

  export interface FolderNode {
    segment: string;   // just this level's name, e.g. "Album"
    fullPath: string;  // e.g. "Music\\Artist\\Album"
    dir: BrowseDir | null;
    children: FolderNode[];
  }

  /** Strips the basename to get the directory portion of a backslash-separated path */
  export function extractDirectory(filepath: string): string {
    const lastSep = filepath.lastIndexOf('\\');
    return lastSep === -1 ? '' : filepath.slice(0, lastSep);
  }

  /** Groups a flat list of network result files by their directory path */
  export function groupByDirectory(
    files: Array<{
      username: string;
      uploadSpeed: number;
      filename: string;
      size: number;
      bitRate?: number;
      length?: number;
      title?: string;
      artist?: string;
      album?: string;
      trackNumber?: string;
    }>,
  ): FolderGroup[] {
    const map = new Map<string, FolderGroup>();

    for (const file of files) {
      const dir = extractDirectory(file.filename);
      const key = `${file.username}::${dir}`;
      if (!map.has(key)) {
        map.set(key, {
          username: file.username,
          uploadSpeed: file.uploadSpeed,
          directory: dir,
          bitRate: file.bitRate,
          files: [],
        });
      }
      map.get(key)!.files.push({
        filename: file.filename,
        size: file.size,
        bitRate: file.bitRate,
        length: file.length,
        title: file.title,
        artist: file.artist,
        album: file.album,
        trackNumber: file.trackNumber,
      });
    }

    return Array.from(map.values());
  }

  /** Builds a nested FolderNode tree from a flat BrowseDir[] list */
  export function buildFolderTree(dirs: BrowseDir[]): FolderNode[] {
    const root: FolderNode[] = [];

    for (const dir of dirs) {
      const segments = dir.name.split('\\');
      let currentLevel = root;
      let currentPath = '';

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        currentPath = currentPath ? `${currentPath}\\${segment}` : segment;

        let node = currentLevel.find((n) => n.segment === segment);
        if (!node) {
          node = {
            segment,
            fullPath: currentPath,
            dir: null,
            children: [],
          };
          currentLevel.push(node);
        }

        if (i === segments.length - 1) {
          node.dir = dir;
        }

        currentLevel = node.children;
      }
    }

    return root;
  }

  /** Returns the files directly in the given directory path (non-recursive) */
  export function getDirectFiles(dirs: BrowseDir[], selectedPath: string): BrowseFile[] {
    const dir = dirs.find((d) => d.name === selectedPath);
    return dir?.files ?? [];
  }
  ```

- [ ] **Step 4: Run tests to confirm they pass**

  Run: `bun test packages/web/src/lib/folderUtils.test.ts`
  Expected: all PASS

- [ ] **Step 5: Commit**

  ```bash
  git add packages/web/src/lib/folderUtils.ts packages/web/src/lib/folderUtils.test.ts
  git commit -m "feat(web): add folder utility functions (extract, group, tree builder)"
  ```

---

## Task 8: `FolderBrowser` component

**Files:**
- Create: `packages/web/src/components/FolderBrowser.tsx`

This component receives a `username`, a `matchedPath` (deep-link target), and a `fallbackFiles` list (from search results). It fires the browse request on mount and renders the tree once loaded. On failure it shows the fallback files.

- [ ] **Step 1: Create `packages/web/src/components/FolderBrowser.tsx`**

  ```tsx
  import { useState, useEffect } from 'react';
  import { api } from '@/lib/api';
  import {
    buildFolderTree,
    getDirectFiles,
    type BrowseDir,
    type BrowseFile,
    type FolderNode,
  } from '@/lib/folderUtils';

  interface FolderBrowserProps {
    username: string;
    matchedPath: string;
    fallbackFiles: BrowseFile[];
    onDownload: (files: Array<{ filename: string; size: number }>) => void;
  }

  function formatSize(bytes: number) {
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
    return `${(bytes / 1_000).toFixed(0)} KB`;
  }

  function extractBasename(filepath: string): string {
    const parts = filepath.split(/[\\/]/);
    return parts[parts.length - 1];
  }

  function TreeNode({
    node,
    selected,
    onSelect,
  }: {
    node: FolderNode;
    selected: string;
    onSelect: (path: string) => void;
  }) {
    const [expanded, setExpanded] = useState(
      selected.startsWith(node.fullPath),
    );

    return (
      <div>
        <button
          onClick={() => {
            setExpanded((e) => !e);
            onSelect(node.fullPath);
          }}
          className={`w-full text-left flex items-center gap-1 px-2 py-1 rounded text-xs transition ${
            selected === node.fullPath
              ? 'bg-zinc-700 text-zinc-100'
              : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
          }`}
        >
          <span>{expanded ? '▾' : '▸'}</span>
          <span className="truncate">{node.segment}</span>
        </button>
        {expanded && node.children.length > 0 && (
          <div className="pl-3">
            {node.children.map((child) => (
              <TreeNode
                key={child.fullPath}
                node={child}
                selected={selected}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  export function FolderBrowser({
    username,
    matchedPath,
    fallbackFiles,
    onDownload,
  }: FolderBrowserProps) {
    const [dirs, setDirs] = useState<BrowseDir[] | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [selected, setSelected] = useState(matchedPath);

    useEffect(() => {
      let cancelled = false;
      api
        .browseUser(username)
        .then((result) => {
          if (!cancelled) {
            setDirs(result);
            setLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setError(true);
            setLoading(false);
          }
        });
      return () => { cancelled = true; };
    }, [username]);

    const tree = dirs ? buildFolderTree(dirs) : [];
    const directFiles: BrowseFile[] = dirs
      ? getDirectFiles(dirs, selected)
      : fallbackFiles;

    return (
      <div className="mt-2 border border-zinc-800 rounded-lg overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 bg-zinc-900 border-b border-zinc-800">
          <span className="text-xs text-zinc-400 truncate">
            {username}'s library
          </span>
          {loading && (
            <span className="text-[11px] text-zinc-600 flex items-center gap-1">
              <span className="inline-block w-3 h-3 border border-zinc-600 border-t-zinc-400 rounded-full animate-spin" />
              Loading…
            </span>
          )}
          {error && (
            <span className="text-[11px] text-amber-600">
              Couldn't load full library — showing files from search results
            </span>
          )}
        </div>

        <div className="flex min-h-[120px] max-h-64">
          {/* Tree panel — only shown after successful load */}
          {!loading && !error && dirs && (
            <div className="w-44 shrink-0 overflow-y-auto border-r border-zinc-800 p-1">
              {tree.map((node) => (
                <TreeNode
                  key={node.fullPath}
                  node={node}
                  selected={selected}
                  onSelect={setSelected}
                />
              ))}
            </div>
          )}

          {/* File list panel */}
          <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
            {directFiles.length === 0 ? (
              <p className="text-xs text-zinc-600 p-2">No files</p>
            ) : (
              <>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] text-zinc-600">
                    {directFiles.length} file{directFiles.length !== 1 ? 's' : ''}
                  </span>
                  <button
                    onClick={() => onDownload(
                      directFiles.map((f) => ({ filename: f.filename, size: f.size }))
                    )}
                    className="px-2 py-0.5 rounded text-[11px] font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition"
                  >
                    Download all ({directFiles.length})
                  </button>
                </div>
                {directFiles.map((file) => (
                  <div
                    key={file.filename}
                    className="flex items-center justify-between text-[11px] text-zinc-500 hover:text-zinc-300 px-1"
                  >
                    <span className="truncate flex-1">{extractBasename(file.filename)}</span>
                    <span className="shrink-0 ml-2 text-zinc-700">
                      {file.bitRate ? `${file.bitRate} kbps · ` : ''}{formatSize(file.size)}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    );
  }
  ```

- [ ] **Step 2: Run typecheck**

  Run: `bun run typecheck`
  Expected: no errors

- [ ] **Step 3: Commit**

  ```bash
  git add packages/web/src/components/FolderBrowser.tsx
  git commit -m "feat(web): add FolderBrowser component with tree nav and download-all"
  ```

---

## Task 9: Wire folder features into `Search.tsx`

**Files:**
- Modify: `packages/web/src/pages/Search.tsx`
- Modify: `packages/web/src/stores/search.ts`

This task integrates everything into the existing search page. Changes:
1. Add `canBrowse` to the search store (persists between poll ticks)
2. Update the poll handler in `SearchPage` to capture `canBrowse`
3. Add a `Tracks | Folders` toggle below the Soulseek divider
4. In Folders mode, render `FolderGroup` rows instead of flat tracks
5. Each `FolderGroup` row has a `[Browse library]` button that toggles an inline `FolderBrowser`

- [ ] **Step 1: Extend the search store to hold `canBrowse`**

  In `packages/web/src/stores/search.ts`, add `canBrowse` to `SearchState`:

  ```typescript
  // Add to interface:
  canBrowse: boolean;
  setCanBrowse: (v: boolean) => void;

  // Add to initial state:
  canBrowse: false,

  // Add setter:
  setCanBrowse: (canBrowse) => set({ canBrowse }),

  // Add to reset():
  reset: () => set({ local: null, network: [], networkState: 'idle', canBrowse: false }),
  ```

- [ ] **Step 2: Update the poll handler in `Search.tsx` to capture `canBrowse`**

  At the top of `SearchPage`, add:
  ```tsx
  const canBrowse = useSearchStore((s) => s.canBrowse);
  const setCanBrowse = useSearchStore((s) => s.setCanBrowse);
  ```

  Inside the `setInterval` in the `useEffect` for polling, update:
  ```tsx
  const res = await api.pollNetwork(searchId);
  setNetwork(res.results);
  if (res.canBrowse !== undefined) setCanBrowse(res.canBrowse);
  if (res.state === 'complete') setNetworkState('complete');
  ```

- [ ] **Step 3: Add local state for the view toggle and open browser panels**

  In `SearchPage`, add:
  ```tsx
  const [viewMode, setViewMode] = useState<'tracks' | 'folders'>('tracks');
  const [openBrowserKey, setOpenBrowserKey] = useState<string | null>(null);
  ```

- [ ] **Step 4: Add imports for folder utilities and `FolderBrowser`**

  ```tsx
  import { FolderBrowser } from '@/components/FolderBrowser';
  import { groupByDirectory, extractDirectory } from '@/lib/folderUtils';
  ```

- [ ] **Step 5: Add the toggle UI and folder-grouped rendering**

  In the JSX, replace the existing network results section:

  ```tsx
  {/* Network results */}
  {hasNetwork && (
    <section>
      {/* Track / Folder toggle */}
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={() => setViewMode('tracks')}
          className={`px-3 py-1 rounded-md text-xs font-medium transition ${
            viewMode === 'tracks'
              ? 'bg-zinc-700 text-zinc-200'
              : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          Tracks
        </button>
        <button
          onClick={() => setViewMode('folders')}
          className={`px-3 py-1 rounded-md text-xs font-medium transition ${
            viewMode === 'folders'
              ? 'bg-zinc-700 text-zinc-200'
              : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          Folders
        </button>
      </div>

      {viewMode === 'tracks' && (
        // Tracks view — this is the existing network results JSX, unchanged.
        // Move the existing flatNetwork.map(...) block here verbatim from Search.tsx lines 417–461.
        // Do not modify the track rendering in any way.
        <>
          {flatNetwork.map((file) => {
            const key = `${file.username}:${file.filename}`;
            const queued = downloading.has(key);
            const title = getDisplayTitle(file);
            const subtitle = getDisplaySubtitle(file);
            return (
              <div
                key={key}
                className="flex items-start gap-3 px-3 py-2 rounded-lg hover:bg-zinc-800/50 transition"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-zinc-300 truncate">{highlightText(title, highlightTerms)}</p>
                      {subtitle && (
                        <p className="text-xs text-zinc-500 truncate">
                          {highlightText(subtitle, highlightTerms)}
                        </p>
                      )}
                    </div>
                    {file.length ? (
                      <span className="shrink-0 pt-0.5 text-xs text-zinc-600">
                        {formatDuration(file.length)}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-[11px] text-zinc-600 truncate">
                    {file.bitRate ? `${file.bitRate} kbps` : 'Unknown bitrate'}
                    {file.bitRate || file.length ? ' · ' : ''}
                    {formatSize(file.size)}
                    {' · '}
                    <span className="text-emerald-600">{formatSpeed(file.uploadSpeed)}</span>
                  </p>
                </div>
                <button
                  onClick={() => handleDownload(file.username, { filename: file.filename, size: file.size })}
                  disabled={queued}
                  className="px-3 py-1 rounded-md text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition disabled:opacity-50"
                >
                  {queued ? 'Queued' : 'Download'}
                </button>
              </div>
            );
          })}
        </>
      )}

      {viewMode === 'folders' && (
        <>
          {groupByDirectory(flatNetwork).map((group) => {
            const browserKey = `${group.username}::${group.directory}`;
            const isOpen = openBrowserKey === browserKey;
            const dirBasename = group.directory.split('\\').at(-1) ?? group.directory;
            const folderQueued = group.files.every((f) =>
              downloading.has(`${group.username}:${f.filename}`),
            );

            return (
              <div key={browserKey} className="mb-1">
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-zinc-800/50 transition">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-300 truncate">{dirBasename}</p>
                    <p className="text-[11px] text-zinc-600 truncate">
                      {group.username}
                      {group.bitRate ? ` · ${group.bitRate} kbps` : ''}
                      {` · ${group.files.length} files`}
                    </p>
                  </div>
                  <button
                    onClick={async () => {
                      for (const f of group.files) addDownloading(`${group.username}:${f.filename}`);
                      await api.enqueueDownload(
                        group.username,
                        group.files.map((f) => ({ filename: f.filename, size: f.size })),
                      );
                    }}
                    disabled={folderQueued || group.files.length === 0}
                    className="px-2 py-1 rounded text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition disabled:opacity-50 shrink-0"
                  >
                    {folderQueued ? 'Queued' : 'Download folder'}
                  </button>
                  {canBrowse && (
                    <button
                      onClick={() => setOpenBrowserKey(isOpen ? null : browserKey)}
                      className="px-2 py-1 rounded text-xs text-zinc-500 hover:text-zinc-300 transition shrink-0"
                    >
                      {isOpen ? 'Close' : 'Browse library'}
                    </button>
                  )}
                </div>

                {isOpen && (
                  <div className="mx-3 mb-2">
                    <FolderBrowser
                      username={group.username}
                      matchedPath={group.directory}
                      fallbackFiles={group.files.map((f) => ({
                        filename: f.filename,
                        size: f.size,
                        bitRate: f.bitRate,
                        length: f.length,
                      }))}
                      onDownload={async (files) => {
                        for (const f of files) addDownloading(`${group.username}:${f.filename}`);
                        await api.enqueueDownload(group.username, files);
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </section>
  )}
  ```

- [ ] **Step 6: Run typecheck**

  Run: `bun run typecheck`
  Expected: no errors

- [ ] **Step 7: Run all tests**

  Run: `bun test`
  Expected: all PASS

- [ ] **Step 8: Commit**

  ```bash
  git add packages/web/src/pages/Search.tsx packages/web/src/stores/search.ts
  git commit -m "feat(web): add Tracks/Folders toggle and inline FolderBrowser to search results"
  ```

---

## Task 10: Manual smoke test checklist

Before closing the feature branch, manually verify the following:

- [ ] **Search → Folders mode:** Run a search, click "Folders" toggle. Results appear grouped by directory, not individual tracks.
- [ ] **Download folder:** Click "Download folder" on a folder group. Check the Downloads page to confirm files were queued.
- [ ] **Browse library (happy path):** Click "Browse library". Inline panel expands. After a moment the full tree loads. Clicking a folder in the left tree updates the file list on the right.
- [ ] **Download all:** Click "Download all (N)" in the browser panel. Verify all N files appear in Downloads.
- [ ] **Browse library (failure path):** Test with a user that can't be browsed (offline or nonexistent). The panel should show "Couldn't load full library — showing files from search results" with the search-result files still visible.
- [ ] **canBrowse false:** In a setup where slskd is unavailable, confirm the "Browse library" button is not shown.
- [ ] **Tracks mode:** Switch back to Tracks mode. Existing behaviour is unchanged.

- [ ] **Final commit**

  ```bash
  git commit --allow-empty -m "chore: download folders feature complete"
  ```
