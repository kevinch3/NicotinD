# Search Omnibox Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the Search page's two inputs (free-text search bar + bottom "Get from a link" URL box) into one omnibox: a pasted/shared URL renders as a single link-intent card in the Results area instead of a second input + standalone job list.

**Architecture:** A new pure lib (`lib/link-intent.ts`) classifies a submitted string as a URL vs. plain text and picks a cosmetic source label by hostname. `SearchComponent` consults it on submit (gated behind `plugins.hasResolve()` so the affordance stays compliance-silent pre-consent) and, when it matches, sets a `linkIntent` signal instead of running a search. The card's Get button reuses the existing `AcquireService.submit(url)` dispatch (same path the blended Results list already uses for `via: 'url'` candidates); the card then derives its own state by matching its URL against the already-polled `AcquireService.jobs()` list — no new job list, no new API routes.

**Tech Stack:** Angular v22 standalone component (signals, `@if`/`@switch` control flow), vitest (`ng test`), Playwright (`packages/e2e`).

**Design spec:** [docs/superpowers/specs/2026-07-09-search-omnibox-merge-design.md](../specs/2026-07-09-search-omnibox-merge-design.md) — read it first for the "why" behind each rule below.

## Global Constraints

- Node >=22.22.3 required for `ng build`/`ng test` (host default nvm node is 22.22.0 — run `nvm use 22.22.3` before any web command).
- Web unit tests: `cd packages/web && bun run test -- <path>` (vitest). Full typecheck: `bun run typecheck` from repo root (`tsc --build`) — this is the gate for template-binding correctness since these component specs use `NO_ERRORS_SCHEMA` and never call `fixture.detectChanges()`.
- Commit format is Conventional Commits (`type(scope): description`); a commitlint hook enforces it. Use `feat(web):` for user-facing behavior, `test(web):` for test-only commits, `docs:` for doc-only commits.
- **Do not add `Co-Authored-By` trailers or any Claude/agent attribution to commit messages.**
- e2e file suffix convention: `.spec.ts` runs in CI (`ci.yml`); `.screens.ts` (screenshot flows), `.playground.ts` (gated `PLAYGROUND=1`), and `.real.ts` (gated `PLAYGROUND_REAL=1`) are all out-of-CI and are edited here only to fix selectors broken by this change, not to add coverage.
- Compliance invariant (must not regress): acquisition UI never appears before a `resolve`-capable plugin is enabled. This is asserted by `packages/e2e/tests/plugins.spec.ts` and must continue to hold for the merged omnibox.

---

### Task 1: `link-intent.ts` — pure URL-vs-text classifier

**Files:**
- Create: `packages/web/src/app/lib/link-intent.ts`
- Test: `packages/web/src/app/lib/link-intent.spec.ts`

**Interfaces:**
- Produces: `export type LinkSource = 'youtube' | 'soundcloud' | 'bandcamp' | 'spotify' | 'archive' | 'link';`
- Produces: `export interface LinkIntent { url: string; source: LinkSource; sourceLabel: string; host: string; }`
- Produces: `export function parseLinkIntent(input: string): LinkIntent | null`

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/app/lib/link-intent.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseLinkIntent } from './link-intent';

describe('parseLinkIntent', () => {
  it('returns null for plain search text', () => {
    expect(parseLinkIntent('pink floyd dark side of the moon')).toBeNull();
  });

  it('returns null for a single non-url word', () => {
    expect(parseLinkIntent('beatles')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseLinkIntent('   ')).toBeNull();
  });

  it('returns null for a bare scheme with no host', () => {
    expect(parseLinkIntent('http://')).toBeNull();
  });

  it('detects a youtube.com URL', () => {
    expect(parseLinkIntent('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      source: 'youtube',
      sourceLabel: 'YouTube',
      host: 'www.youtube.com',
    });
  });

  it('detects a youtu.be short link', () => {
    const result = parseLinkIntent('https://youtu.be/dQw4w9WgXcQ');
    expect(result?.source).toBe('youtube');
    expect(result?.sourceLabel).toBe('YouTube');
  });

  it('detects a soundcloud.com URL', () => {
    const result = parseLinkIntent('https://soundcloud.com/artist/track');
    expect(result?.source).toBe('soundcloud');
    expect(result?.sourceLabel).toBe('SoundCloud');
  });

  it('detects a bandcamp subdomain URL', () => {
    const result = parseLinkIntent('https://artistname.bandcamp.com/album/name');
    expect(result?.source).toBe('bandcamp');
    expect(result?.sourceLabel).toBe('Bandcamp');
  });

  it('detects an open.spotify.com URL', () => {
    const result = parseLinkIntent('https://open.spotify.com/album/abc123');
    expect(result?.source).toBe('spotify');
    expect(result?.sourceLabel).toBe('Spotify');
  });

  it('detects an archive.org URL', () => {
    const result = parseLinkIntent('https://archive.org/details/some-item');
    expect(result?.source).toBe('archive');
    expect(result?.sourceLabel).toBe('Internet Archive');
  });

  it('falls back to a generic "Link" label for an unrecognized host', () => {
    const result = parseLinkIntent('https://example.com/track.mp3');
    expect(result?.source).toBe('link');
    expect(result?.sourceLabel).toBe('Link');
  });

  it('tolerates a bare www. host with no protocol', () => {
    const result = parseLinkIntent('www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(result?.source).toBe('youtube');
    expect(result?.url).toBe('www.youtube.com/watch?v=dQw4w9WgXcQ');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/web && bun run test -- src/app/lib/link-intent.spec.ts`
Expected: FAIL — `Cannot find module './link-intent'`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/app/lib/link-intent.ts`:

```ts
// Detects a pasted/shared URL in the search omnibox and classifies it by host
// for a neutral chip label ("YouTube", "SoundCloud", …). Purely cosmetic — the
// server's registry.getEnabledForUrl() still picks the real backend at submit
// time. See docs/source-agnostic-acquisition.md.

export type LinkSource = 'youtube' | 'soundcloud' | 'bandcamp' | 'spotify' | 'archive' | 'link';

export interface LinkIntent {
  url: string;
  source: LinkSource;
  sourceLabel: string;
  host: string;
}

interface HostRule {
  test: (host: string) => boolean;
  source: LinkSource;
  label: string;
}

const HOST_RULES: HostRule[] = [
  {
    test: (h) =>
      h === 'youtube.com' || h === 'www.youtube.com' || h === 'm.youtube.com' || h === 'youtu.be',
    source: 'youtube',
    label: 'YouTube',
  },
  {
    test: (h) => h === 'soundcloud.com' || h === 'www.soundcloud.com',
    source: 'soundcloud',
    label: 'SoundCloud',
  },
  {
    test: (h) => h === 'bandcamp.com' || h.endsWith('.bandcamp.com'),
    source: 'bandcamp',
    label: 'Bandcamp',
  },
  {
    test: (h) => h === 'spotify.com' || h === 'www.spotify.com' || h === 'open.spotify.com',
    source: 'spotify',
    label: 'Spotify',
  },
  {
    test: (h) => h === 'archive.org' || h === 'www.archive.org',
    source: 'archive',
    label: 'Internet Archive',
  },
];

/**
 * Parses free-text search input as a link intent. Returns null for anything
 * that isn't clearly a URL (no whitespace tolerated) so ordinary search text
 * never misfires as a link.
 */
export function parseLinkIntent(input: string): LinkIntent | null {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  const hasProtocol = /^https?:\/\//i.test(trimmed);
  const looksLikeWww = /^www\./i.test(trimmed);
  if (!hasProtocol && !looksLikeWww) return null;

  const candidate = hasProtocol ? trimmed : `https://${trimmed}`;
  if (!URL.canParse(candidate)) return null;

  const host = new URL(candidate).hostname.toLowerCase();
  const rule = HOST_RULES.find((r) => r.test(host));
  return {
    url: trimmed,
    source: rule?.source ?? 'link',
    sourceLabel: rule?.label ?? 'Link',
    host,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/web && bun run test -- src/app/lib/link-intent.spec.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/app/lib/link-intent.ts packages/web/src/app/lib/link-intent.spec.ts
git commit -m "feat(web): add parseLinkIntent to classify pasted URLs by host"
```

---

### Task 2: Widen `SourceChipComponent` to accept link-intent sources

**Files:**
- Modify: `packages/web/src/app/components/source-chip/source-chip.component.ts`
- Modify: `packages/web/src/app/components/source-chip/source-chip.component.spec.ts`

**Interfaces:**
- Consumes: `LinkSource` from Task 1 (`packages/web/src/app/lib/link-intent.ts`)
- Produces: `export type ChipSource = CandidateSource | LinkSource;` — Task 3's template binds `app-source-chip`'s `[source]` to a `LinkIntent.source`, which needs this widened type to typecheck.

- [ ] **Step 1: Write the failing test**

Add to `packages/web/src/app/components/source-chip/source-chip.component.spec.ts` (append inside the existing `describe` block, after the "never emits raw Tailwind..." test):

```ts
  it('falls back to neutral tone for link-intent hosts without a dedicated tone', () => {
    expect(sourceChipToneClass('youtube')).toBe('bg-theme-surface-2 text-theme-muted');
    expect(sourceChipToneClass('soundcloud')).toBe('bg-theme-surface-2 text-theme-muted');
    expect(sourceChipToneClass('bandcamp')).toBe('bg-theme-surface-2 text-theme-muted');
    expect(sourceChipToneClass('link')).toBe('bg-theme-surface-2 text-theme-muted');
  });
```

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `bun run typecheck`
Expected: FAIL — TS2345, `'youtube'` is not assignable to parameter of type `CandidateSource` in the new test.
(Note: `vitest` alone won't fail here since esbuild doesn't type-check — `typecheck` is the real gate for this widening.)

- [ ] **Step 3: Write the implementation**

In `packages/web/src/app/components/source-chip/source-chip.component.ts`, replace:

```ts
import { Component, input, computed } from '@angular/core';
import type { CandidateSource } from '../../lib/acquisition-candidate';
```

with:

```ts
import { Component, input, computed } from '@angular/core';
import type { CandidateSource } from '../../lib/acquisition-candidate';
import type { LinkSource } from '../../lib/link-intent';

/** Sources the chip can render: blended-result sources plus link-intent hosts. */
export type ChipSource = CandidateSource | LinkSource;
```

Then replace the two remaining `CandidateSource` usages:

```ts
export function sourceChipToneClass(source: CandidateSource): string {
```
→
```ts
export function sourceChipToneClass(source: ChipSource): string {
```

```ts
  readonly source = input.required<CandidateSource>();
```
→
```ts
  readonly source = input.required<ChipSource>();
```

- [ ] **Step 4: Run typecheck and tests to verify they pass**

Run: `bun run typecheck && cd packages/web && bun run test -- src/app/components/source-chip/source-chip.component.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/app/components/source-chip/source-chip.component.ts packages/web/src/app/components/source-chip/source-chip.component.spec.ts
git commit -m "feat(web): let the source chip render link-intent hosts"
```

---

### Task 3: `SearchComponent` — link-intent detection, Get/Cancel/Retry, and template merge

**Files:**
- Modify: `packages/web/src/app/pages/search/search.component.ts`
- Modify: `packages/web/src/app/pages/search/search.component.html`
- Modify: `packages/web/src/app/pages/search/search.component.spec.ts`

**Interfaces:**
- Consumes: `parseLinkIntent`, `LinkIntent` (Task 1); `ChipSource` (Task 2, transitively via the widened `app-source-chip`); `AcquireJob` (`packages/web/src/app/services/acquire.service.ts`, already exists — `{ id, backend, url, label, state, progress, error, created_at }`); `DownloadsApiService.retryAcquireJob(id: string): Observable<{ jobId: string }>` (already exists at `packages/web/src/app/services/api/downloads-api.service.ts:67`).
- Produces (new component API used by the template and by Task 4's e2e updates):
  - `readonly linkIntent: WritableSignal<LinkIntent | null>`
  - `readonly linkSubmitError: WritableSignal<string | null>`
  - `readonly linkJob: Signal<AcquireJob | null>`
  - `async submitLinkIntent(): Promise<void>`
  - `async cancelLinkJob(): Promise<void>`
  - `async retryLinkJob(): Promise<void>`
  - `dismissLinkIntent(): void`
  - Removes: `acquireUrl`, `acquireSubmitting`, `acquireError`, `submitAcquireUrl`, `startAcquire`, `cancelAcquireJob` (old public method — superseded by `cancelLinkJob`).
  - New `data-testid`s: `link-intent-section`, `link-intent-card`, `link-intent-get`, `link-intent-cancel`, `link-intent-retry`, `link-intent-dismiss`. Removed `data-testid`s: `acquire-url-input`, `acquire-submit`.

- [ ] **Step 1: Write the failing component tests**

In `packages/web/src/app/pages/search/search.component.spec.ts`, first update the top imports — replace:

```ts
import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA } from '@angular/core';
```

with:

```ts
import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
```

and add, after the `AcquireService` import:

```ts
import { AcquireService } from '../../services/acquire.service';
import type { AcquireJob } from '../../services/acquire.service';
```

(only the `import type { AcquireJob }` line is new — keep the existing `AcquireService` import as-is).

Now replace the entire `setup()` function and add an `enableResolve` helper. Replace:

```ts
function setup(apiOverrides: Partial<Record<keyof SearchApiService, unknown>> = {}) {
  const acquireSubmit = vi.fn(() => Promise.resolve('job1'));
  const autoHunt = { hunt: vi.fn() };
  const searchApi = {
    catalogSearch: () =>
      of({ artists: [{ mbid: 'pf-mbid', name: 'Pink Floyd' }], albums: [CATALOG_ALBUM] }),
    search: () =>
      of({ searchId: '11111111-1111-1111-1111-111111111111', errors: [], networkAvailable: false }),
    catalogResolve: () =>
      of({
        lidarrAlbumId: 55,
        totalTracks: 10,
        title: 'The Dark Side of the Moon',
        artistName: 'Pink Floyd',
      }),
    archiveSearch: () => of({ candidates: [] }),
    cancelSearch: () => of({ ok: true }),
    deleteSearch: () => of({ ok: true }),
    ...apiOverrides,
  };

  TestBed.configureTestingModule({
    imports: [SearchComponent],
    providers: [
      provideRouter([]),
      { provide: SearchApiService, useValue: searchApi },
      { provide: SystemApiService, useValue: { getSoulseekStatus: () => of({ connected: true }) } },
      { provide: DownloadsApiService, useValue: { enqueueDownload: () => of({ ok: true }) } },
      { provide: LibraryApiService, useValue: { resolveArtistIdByName: () => of(null) } },
      { provide: TransferService, useValue: { poll: () => {}, getStatus: () => undefined } },
      { provide: AcquireService, useValue: { submit: acquireSubmit } },
      { provide: AutoHuntService, useValue: autoHunt },
      SearchService,
      PluginService,
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  const fixture = TestBed.createComponent(SearchComponent);
  return {
    component: fixture.componentInstance,
    search: TestBed.inject(SearchService),
    plugins: TestBed.inject(PluginService),
    acquireSubmit,
    autoHunt,
  };
}
```

with:

```ts
function setup(
  apiOverrides: Partial<Record<keyof SearchApiService, unknown>> = {},
  acquireOverrides: { submit?: () => Promise<string> } = {},
) {
  const acquireSubmit = vi.fn(acquireOverrides.submit ?? (() => Promise.resolve('job1')));
  const acquireCancel = vi.fn(() => Promise.resolve());
  const acquireRefresh = vi.fn(() => Promise.resolve());
  const acquireJobs = signal<AcquireJob[]>([]);
  const retryAcquireJob = vi.fn(() => of({ jobId: 'job2' }));
  const autoHunt = { hunt: vi.fn() };
  const searchApi = {
    catalogSearch: () =>
      of({ artists: [{ mbid: 'pf-mbid', name: 'Pink Floyd' }], albums: [CATALOG_ALBUM] }),
    search: () =>
      of({ searchId: '11111111-1111-1111-1111-111111111111', errors: [], networkAvailable: false }),
    catalogResolve: () =>
      of({
        lidarrAlbumId: 55,
        totalTracks: 10,
        title: 'The Dark Side of the Moon',
        artistName: 'Pink Floyd',
      }),
    archiveSearch: () => of({ candidates: [] }),
    cancelSearch: () => of({ ok: true }),
    deleteSearch: () => of({ ok: true }),
    ...apiOverrides,
  };

  TestBed.configureTestingModule({
    imports: [SearchComponent],
    providers: [
      provideRouter([]),
      { provide: SearchApiService, useValue: searchApi },
      { provide: SystemApiService, useValue: { getSoulseekStatus: () => of({ connected: true }) } },
      {
        provide: DownloadsApiService,
        useValue: { enqueueDownload: () => of({ ok: true }), retryAcquireJob },
      },
      { provide: LibraryApiService, useValue: { resolveArtistIdByName: () => of(null) } },
      { provide: TransferService, useValue: { poll: () => {}, getStatus: () => undefined } },
      {
        provide: AcquireService,
        useValue: {
          submit: acquireSubmit,
          cancel: acquireCancel,
          refresh: acquireRefresh,
          jobs: acquireJobs,
        },
      },
      { provide: AutoHuntService, useValue: autoHunt },
      SearchService,
      PluginService,
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  const fixture = TestBed.createComponent(SearchComponent);
  return {
    component: fixture.componentInstance,
    search: TestBed.inject(SearchService),
    plugins: TestBed.inject(PluginService),
    acquireSubmit,
    acquireCancel,
    acquireRefresh,
    acquireJobs,
    retryAcquireJob,
    autoHunt,
  };
}

/** Flip a resolve-capable plugin on so link-intent detection is active. */
function enableResolve(plugins: PluginService): void {
  plugins.plugins.set([
    { id: 'ytdlp', enabled: true, capabilities: ['resolve'] } as unknown as PluginInfo,
  ]);
}
```

Now append a new `describe` block at the end of the file (after the existing `describe('SearchComponent — metadata-driven search', ...)` block's closing `});`):

```ts

describe('SearchComponent — link-intent card (merged URL acquisition)', () => {
  it('does not treat a pasted URL as a link intent when no resolve plugin is enabled', async () => {
    const { component, search } = setup();
    search.setQuery('https://youtu.be/dQw4w9WgXcQ');

    component.handleSearch(new Event('submit'));
    await flush();

    expect(component.linkIntent()).toBeNull();
  });

  it('renders a link intent and fires no search when a resolve plugin is enabled', async () => {
    const searchSpy = vi.fn(() =>
      of({ searchId: '11111111-1111-1111-1111-111111111111', errors: [], networkAvailable: false }),
    );
    const { component, search, plugins } = setup({ search: searchSpy });
    enableResolve(plugins);
    search.setQuery('https://youtu.be/dQw4w9WgXcQ');

    component.handleSearch(new Event('submit'));
    await flush();

    expect(component.linkIntent()).toEqual(
      expect.objectContaining({ source: 'youtube', sourceLabel: 'YouTube' }),
    );
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it('leaves normal text search unaffected when a resolve plugin is enabled', async () => {
    const { component, search, plugins } = setup();
    enableResolve(plugins);
    search.setQuery('pink floyd');

    component.handleSearch(new Event('submit'));
    await flush();

    expect(component.linkIntent()).toBeNull();
    expect(component.hasCatalog()).toBe(true);
  });

  it('submitLinkIntent submits the URL through the acquire pipeline', async () => {
    const { component, acquireSubmit } = setup();
    component.linkIntent.set({
      url: 'https://youtu.be/dQw4w9WgXcQ',
      source: 'youtube',
      sourceLabel: 'YouTube',
      host: 'youtu.be',
    });

    await component.submitLinkIntent();

    expect(acquireSubmit).toHaveBeenCalledWith('https://youtu.be/dQw4w9WgXcQ');
  });

  it('surfaces a submit failure on the card instead of throwing', async () => {
    const { component } = setup(
      {},
      { submit: () => Promise.reject(new Error('no plugin available')) },
    );
    component.linkIntent.set({
      url: 'https://example.com/track.mp3',
      source: 'link',
      sourceLabel: 'Link',
      host: 'example.com',
    });

    await component.submitLinkIntent();

    expect(component.linkSubmitError()).toBe('no plugin available');
  });

  it('opens Spotify instead of submitting when spotDL is unavailable', async () => {
    const { component, acquireSubmit } = setup();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    component.linkIntent.set({
      url: 'https://open.spotify.com/album/abc',
      source: 'spotify',
      sourceLabel: 'Spotify',
      host: 'open.spotify.com',
    });

    await component.submitLinkIntent();

    expect(openSpy).toHaveBeenCalledWith(
      'https://open.spotify.com/album/abc',
      '_blank',
      'noopener',
    );
    expect(acquireSubmit).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('derives linkJob from the shared acquire job list by URL', () => {
    const { component, acquireJobs } = setup();
    component.linkIntent.set({
      url: 'https://youtu.be/dQw4w9WgXcQ',
      source: 'youtube',
      sourceLabel: 'YouTube',
      host: 'youtu.be',
    });
    acquireJobs.set([
      {
        id: 'job1',
        backend: 'ytdlp',
        url: 'https://youtu.be/dQw4w9WgXcQ',
        label: null,
        state: 'running',
        progress: { done: 1, total: 3 },
        error: null,
        created_at: Date.now(),
      },
    ]);

    expect(component.linkJob()?.id).toBe('job1');
  });

  it('cancelLinkJob cancels the tracked job', async () => {
    const { component, acquireJobs, acquireCancel } = setup();
    component.linkIntent.set({
      url: 'https://youtu.be/dQw4w9WgXcQ',
      source: 'youtube',
      sourceLabel: 'YouTube',
      host: 'youtu.be',
    });
    acquireJobs.set([
      {
        id: 'job1',
        backend: 'ytdlp',
        url: 'https://youtu.be/dQw4w9WgXcQ',
        label: null,
        state: 'running',
        progress: null,
        error: null,
        created_at: Date.now(),
      },
    ]);

    await component.cancelLinkJob();

    expect(acquireCancel).toHaveBeenCalledWith('job1');
  });

  it('retryLinkJob calls the retry endpoint and refreshes the job list', async () => {
    const { component, acquireJobs, retryAcquireJob, acquireRefresh } = setup();
    component.linkIntent.set({
      url: 'https://youtu.be/dQw4w9WgXcQ',
      source: 'youtube',
      sourceLabel: 'YouTube',
      host: 'youtu.be',
    });
    acquireJobs.set([
      {
        id: 'job1',
        backend: 'ytdlp',
        url: 'https://youtu.be/dQw4w9WgXcQ',
        label: null,
        state: 'failed',
        progress: null,
        error: 'boom',
        created_at: Date.now(),
      },
    ]);

    await component.retryLinkJob();

    expect(retryAcquireJob).toHaveBeenCalledWith('job1');
    expect(acquireRefresh).toHaveBeenCalled();
  });

  it('dismissLinkIntent clears the card and any error', () => {
    const { component } = setup();
    component.linkIntent.set({
      url: 'https://example.com',
      source: 'link',
      sourceLabel: 'Link',
      host: 'example.com',
    });
    component.linkSubmitError.set('boom');

    component.dismissLinkIntent();

    expect(component.linkIntent()).toBeNull();
    expect(component.linkSubmitError()).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/web && bun run test -- src/app/pages/search/search.component.spec.ts`
Expected: FAIL — `component.linkIntent is not a function` / `component.submitLinkIntent is not a function` etc.

- [ ] **Step 3: Implement the component changes**

In `packages/web/src/app/pages/search/search.component.ts`:

3a. Add the new import. Replace:

```ts
import {
  songResultToCandidate,
  archiveToCandidate,
  spotifyToCandidate,
  mergeAndRank,
  type BlendedCandidate,
} from '../../lib/acquisition-candidate';
```

with:

```ts
import {
  songResultToCandidate,
  archiveToCandidate,
  spotifyToCandidate,
  mergeAndRank,
  type BlendedCandidate,
} from '../../lib/acquisition-candidate';
import { parseLinkIntent, type LinkIntent } from '../../lib/link-intent';
```

3b. Widen the `AcquireService` import to also bring in its job type. Replace:

```ts
import { AcquireService } from '../../services/acquire.service';
```

with:

```ts
import { AcquireService, type AcquireJob } from '../../services/acquire.service';
```

3c. Replace the URL-acquisition fields. Replace:

```ts
  // URL acquisition (yt-dlp / spotdl)
  acquireUrl = '';
  readonly acquireSubmitting = signal(false);
  readonly acquireError = signal<string | null>(null);
```

with:

```ts
  // Link-intent card: a pasted/shared URL recognized as one acquisition
  // candidate. Replaces the old standalone "Get from a link" box + job list —
  // the card itself carries the job lifecycle via `linkJob`. See
  // docs/source-agnostic-acquisition.md.
  readonly linkIntent = signal<LinkIntent | null>(null);
  readonly linkSubmitError = signal<string | null>(null);
```

3d. Add the `linkJob` computed. Replace:

```ts
  readonly availableSources = computed(() => {
    const names: string[] = [];
    if (this.networkConnected()) names.push('Soulseek');
    if (this.plugins.hasArchive()) names.push('Internet Archive');
    if (this.plugins.hasSpotify()) names.push('Spotify');
    return names;
  });

  private pollInterval: ReturnType<typeof setInterval> | null = null;
```

with:

```ts
  readonly availableSources = computed(() => {
    const names: string[] = [];
    if (this.networkConnected()) names.push('Soulseek');
    if (this.plugins.hasArchive()) names.push('Internet Archive');
    if (this.plugins.hasSpotify()) names.push('Spotify');
    return names;
  });

  // The link card's own job, tracked by URL against the shared acquire job
  // list (already polled by AcquireService) — no separate job list needed.
  readonly linkJob = computed<AcquireJob | null>(() => {
    const intent = this.linkIntent();
    if (!intent) return null;
    return this.acquire.jobs().find((j) => j.url === intent.url) ?? null;
  });

  private pollInterval: ReturnType<typeof setInterval> | null = null;
```

3e. Rewrite the share-target handling in `ngOnInit`. Replace:

```ts
    // PWA share-target: a link shared from another app lands here as ?url=/?text=.
    // Auto-start an acquisition job for it so "Share → NicotinD" just works.
    const qp = this.route.snapshot.queryParamMap;
    const shared = extractSharedUrl(qp.get('url'), qp.get('text'), qp.get('title'));
    if (shared) {
      void this.startAcquire(shared);
      // Drop the share params so a refresh doesn't re-submit.
      void this.router.navigate([], { queryParams: {}, replaceUrl: true });
    }
  }
```

with:

```ts
    // PWA share-target: a link shared from another app lands here as ?url=/?text=.
    // Sharing is an explicit intent, so this submits regardless of the
    // hasResolve() gate in handleSearch below — a plugin that can't handle it
    // surfaces as the card's failed state instead of a silent drop.
    const qp = this.route.snapshot.queryParamMap;
    const shared = extractSharedUrl(qp.get('url'), qp.get('text'), qp.get('title'));
    const sharedIntent = shared ? parseLinkIntent(shared) : null;
    if (sharedIntent) {
      this.linkIntent.set(sharedIntent);
      void this.submitLinkIntent();
      // Drop the share params so a refresh doesn't re-submit.
      void this.router.navigate([], { queryParams: {}, replaceUrl: true });
    }
  }
```

3f. Rewrite `handleSearch`. Replace:

```ts
  handleSearch(e: Event): void {
    e.preventDefault();
    this.executeSearch();
  }
```

with:

```ts
  handleSearch(e: Event): void {
    e.preventDefault();
    // A pasted URL becomes a link-intent card, not a search — but detection
    // stays behind the hasResolve() gate so acquisition UI never appears
    // before a plugin is enabled (compliance; see packages/e2e/tests/plugins.spec.ts).
    const intent = this.plugins.hasResolve() ? parseLinkIntent(this.search.query()) : null;
    if (intent) {
      this.linkSubmitError.set(null);
      this.linkIntent.set(intent);
      return;
    }
    this.linkIntent.set(null);
    this.executeSearch();
  }
```

3g. Replace the old URL-acquisition methods. Replace:

```ts
  async submitAcquireUrl(e: Event): Promise<void> {
    e.preventDefault();
    await this.startAcquire(this.acquireUrl.trim());
  }

  private async startAcquire(url: string): Promise<void> {
    if (!url) return;
    this.acquireError.set(null);
    this.acquireSubmitting.set(true);
    try {
      await this.acquire.submit(url);
      this.acquireUrl = '';
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to start download';
      this.acquireError.set(msg);
    } finally {
      this.acquireSubmitting.set(false);
    }
  }

  async cancelAcquireJob(jobId: string): Promise<void> {
    await this.acquire.cancel(jobId).catch(() => {});
  }
```

with:

```ts
  // ─── Link-intent card (merged "Get from a link") ────────────────────
  // Get dispatches through the same AcquireService.submit(url) as every
  // via:'url' blended candidate; the card then tracks its own job by URL
  // against acquire.jobs() instead of a separate job list.

  async submitLinkIntent(): Promise<void> {
    const intent = this.linkIntent();
    if (!intent) return;
    // Spotify gives metadata only — without spotDL there's nothing to resolve
    // the URL, so open it in Spotify instead of queuing a doomed acquire job
    // (mirrors getBlended's rule for Spotify blended candidates).
    if (intent.source === 'spotify' && !this.plugins.hasSpotdl()) {
      window.open(intent.url, '_blank', 'noopener');
      return;
    }
    this.linkSubmitError.set(null);
    try {
      await this.acquire.submit(intent.url);
    } catch (err: unknown) {
      this.linkSubmitError.set(err instanceof Error ? err.message : 'Failed to start download');
    }
  }

  async cancelLinkJob(): Promise<void> {
    const job = this.linkJob();
    if (!job) return;
    await this.acquire.cancel(job.id).catch(() => {});
  }

  async retryLinkJob(): Promise<void> {
    const job = this.linkJob();
    if (!job) return;
    this.linkSubmitError.set(null);
    try {
      await firstValueFrom(this.downloadsApi.retryAcquireJob(job.id));
      await this.acquire.refresh();
    } catch (err: unknown) {
      this.linkSubmitError.set(err instanceof Error ? err.message : 'Retry failed');
    }
  }

  dismissLinkIntent(): void {
    this.linkIntent.set(null);
    this.linkSubmitError.set(null);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/web && bun run test -- src/app/pages/search/search.component.spec.ts`
Expected: PASS (all prior tests + the 10 new ones).

- [ ] **Step 5: Update the template**

In `packages/web/src/app/pages/search/search.component.html`:

5a. Update the placeholder. Replace:

```html
        placeholder="Search for music..."
```

with:

```html
        placeholder="Search music or paste a link…"
```

5b. Insert the link-intent card. Replace:

```html
  @if (errors().length > 0) {
    <div class="mb-6 px-4 py-3 rounded-lg bg-amber-950/50 border border-amber-900/50 space-y-1">
      @for (err of errors(); track $index) {
        <p class="text-sm text-amber-400">{{ err }}</p>
      }
    </div>
  }

  <!-- Loading spinner -->
  @if (loading()) {
```

with:

```html
  @if (errors().length > 0) {
    <div class="mb-6 px-4 py-3 rounded-lg bg-amber-950/50 border border-amber-900/50 space-y-1">
      @for (err of errors(); track $index) {
        <p class="text-sm text-amber-400">{{ err }}</p>
      }
    </div>
  }

  <!-- Link-intent card: a pasted/shared URL is one acquisition candidate,
       styled like a blended Results row but rendered standalone (no search
       runs for a URL). The card itself carries the job lifecycle — no
       separate job list (replaces the old bottom "Get from a link" section).
       See docs/source-agnostic-acquisition.md. -->
  @if (linkIntent(); as intent) {
    <section class="mb-6" data-testid="link-intent-section">
      <ul class="divide-y divide-zinc-800 rounded-lg border border-zinc-800 overflow-hidden">
        <li
          class="flex items-center gap-3 px-3 py-2.5 bg-zinc-900/40"
          data-testid="link-intent-card"
        >
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <app-source-chip [source]="intent.source" [label]="intent.sourceLabel" />
              <p class="truncate text-sm text-zinc-200">{{ intent.url }}</p>
            </div>
            @if (linkJob()?.state === 'failed') {
              <p class="truncate text-xs text-red-400 mt-0.5">
                {{ linkJob()?.error ?? 'Download failed' }}
              </p>
            } @else if (linkSubmitError()) {
              <p class="truncate text-xs text-red-400 mt-0.5">{{ linkSubmitError() }}</p>
            }
          </div>

          @if (linkJob(); as job) {
            @switch (job.state) {
              @case ('done') {
                <a
                  routerLink="/library"
                  class="shrink-0 px-3 py-1.5 rounded-md text-xs font-semibold"
                  style="
                    background: var(--theme-status-done-bg);
                    color: var(--theme-status-done-text);
                  "
                >
                  Added to library ✓ · Open
                </a>
              }
              @case ('failed') {
                <button
                  (click)="retryLinkJob()"
                  data-testid="link-intent-retry"
                  class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
                >
                  Retry
                </button>
              }
              @default {
                <span class="shrink-0 text-xs text-zinc-400">
                  {{ job.progress ? job.progress.done + '/' + job.progress.total : 'Starting…' }}
                </span>
                <button
                  (click)="cancelLinkJob()"
                  data-testid="link-intent-cancel"
                  class="shrink-0 text-zinc-600 hover:text-zinc-300 transition text-base leading-none"
                  title="Cancel"
                >
                  ×
                </button>
              }
            }
          } @else {
            <button
              (click)="submitLinkIntent()"
              data-testid="link-intent-get"
              class="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
            >
              {{ intent.source === 'spotify' && !plugins.hasSpotdl() ? 'Open in Spotify' : 'Get' }}
            </button>
          }
          <button
            (click)="dismissLinkIntent()"
            data-testid="link-intent-dismiss"
            class="shrink-0 text-zinc-600 hover:text-zinc-300 transition text-base leading-none"
            title="Dismiss"
          >
            ×
          </button>
        </li>
      </ul>
    </section>
  }

  <!-- Loading spinner -->
  @if (loading()) {
```

5c. Remove the bottom "Get from a link" section entirely. Replace:

```html
  <!-- URL acquisition (yt-dlp / spotdl) — only when a resolve-capable plugin is enabled -->
  @if (plugins.hasResolve()) {
    <div class="mt-10 border-t border-zinc-800 pt-8">
      <h2 class="text-sm font-semibold text-zinc-400 uppercase tracking-wider mb-1">
        Get from a link
      </h2>
      <p class="text-xs text-zinc-500 mb-3">
        Paste a YouTube, SoundCloud, Bandcamp, Spotify or archive.org link — we pick the right
        source.
      </p>
      <form (submit)="submitAcquireUrl($event)" class="flex gap-2">
        <input
          type="url"
          [(ngModel)]="acquireUrl"
          name="acquireUrl"
          placeholder="Paste a link…"
          data-testid="acquire-url-input"
          class="flex-1 px-4 py-2.5 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-600 transition text-sm"
        />
        <button
          type="submit"
          [disabled]="acquireSubmitting()"
          data-testid="acquire-submit"
          class="px-4 py-2.5 rounded-xl bg-zinc-700 text-zinc-200 text-sm font-medium hover:bg-zinc-600 transition disabled:opacity-50 whitespace-nowrap"
        >
          {{ acquireSubmitting() ? 'Starting…' : 'Download' }}
        </button>
      </form>
      @if (acquireError()) {
        <p class="mt-2 text-xs text-red-400">{{ acquireError() }}</p>
      }

      @if (acquire.jobs().length > 0) {
        <ul class="mt-4 space-y-2">
          @for (job of acquire.jobs(); track job.id) {
            <li
              class="flex items-center gap-3 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm"
            >
              <span class="shrink-0 w-16 text-xs text-zinc-500 uppercase font-medium">{{
                job.backend
              }}</span>
              <span class="flex-1 truncate text-zinc-300" [title]="job.url">{{
                job.label ?? job.url
              }}</span>

              @if (job.state === 'running' && job.progress) {
                <span class="shrink-0 text-xs text-blue-400"
                  >{{ job.progress.done }}/{{ job.progress.total }}</span
                >
              }
              @if (job.state === 'queued' || job.state === 'running') {
                <span class="shrink-0 w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span>
              }               @else if (job.state === 'done') {
                <span class="shrink-0 text-xs text-emerald-400">Added to library</span>
              } @else if (job.state === 'failed') {
                <span class="shrink-0 text-xs text-red-400" [title]="job.error ?? ''">Failed</span>
              }

              @if (job.state === 'queued' || job.state === 'running') {
                <button
                  (click)="cancelAcquireJob(job.id)"
                  class="shrink-0 text-zinc-600 hover:text-zinc-300 transition text-base leading-none"
                  title="Cancel"
                >
                  ×
                </button>
              }
            </li>
          }
        </ul>
      }
    </div>
  }
</div>
```

with:

```html
</div>
```

- [ ] **Step 6: Run typecheck and the full component test file**

Run: `bun run typecheck && cd packages/web && bun run test -- src/app/pages/search/search.component.spec.ts`
Expected: PASS — typecheck confirms the template's `intent.source`/`job.state`/etc. bindings match the component's new public API.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/app/pages/search/search.component.ts packages/web/src/app/pages/search/search.component.html packages/web/src/app/pages/search/search.component.spec.ts
git commit -m "feat(web): merge the URL acquire box into the search omnibox"
```

---

### Task 4: Fix e2e selectors for the merged omnibox

**Files:**
- Modify: `packages/e2e/tests/plugins.spec.ts` (runs in CI)
- Modify: `packages/e2e/tests/downloads-acquire.screens.ts` (out-of-CI screenshot flow)
- Modify: `packages/e2e/tests/song-acquisition.playground.ts` (out-of-CI playground)
- Modify: `packages/e2e/tests/real-roundtrip.real.ts` (out-of-CI real round-trip)

**Interfaces:**
- Consumes: `data-testid`s from Task 3 — `link-intent-card`, `link-intent-get`. The old `acquire-url-input`/`acquire-submit` testids no longer exist.

- [ ] **Step 1: Update the CI compliance test**

In `packages/e2e/tests/plugins.spec.ts`, replace the test:

```ts
  test('enabling yt-dlp reveals the URL acquire box; disabling hides it', async ({ page }) => {
    // Baseline: no resolve plugin -> the acquire box is absent on the search page.
    await page.goto('/');
    await expect(page.getByTestId('search-input')).toBeVisible();
    await expect(page.getByTestId('acquire-url-input')).toHaveCount(0);

    // Enable yt-dlp (consent-gated) on the admin plugins page.
    await page.goto('/settings/plugins');
    const card = ytdlpCard(page);
    await expect(card.getByTestId('plugin-toggle')).toHaveText('Enable');
    await card.getByTestId('plugin-toggle').click();
    await page.getByTestId('confirm-ok').click(); // acknowledge the disclaimer
    await expect(card.getByTestId('plugin-toggle')).toHaveText('Disable');

    // Now the acquire box is exposed on the search page.
    await page.goto('/');
    await expect(page.getByTestId('acquire-url-input')).toBeVisible();

    // Disabling it removes the capability again.
    await page.goto('/settings/plugins');
    await card.getByTestId('plugin-toggle').click();
    await expect(card.getByTestId('plugin-toggle')).toHaveText('Enable');
    await page.goto('/');
    await expect(page.getByTestId('acquire-url-input')).toHaveCount(0);
  });
```

with:

```ts
  test('enabling yt-dlp reveals the link-intent card for a pasted URL; disabling hides it', async ({
    page,
  }) => {
    const pasteUrl = async () => {
      await page.getByTestId('search-input').fill('https://youtu.be/dQw4w9WgXcQ');
      await page.getByTestId('search-submit').click();
    };

    // Baseline: no resolve plugin -> pasting a URL just searches, no card.
    await page.goto('/');
    await expect(page.getByTestId('search-input')).toBeVisible();
    await pasteUrl();
    await expect(page.getByTestId('link-intent-card')).toHaveCount(0);

    // Enable yt-dlp (consent-gated) on the admin plugins page.
    await page.goto('/settings/plugins');
    const card = ytdlpCard(page);
    await expect(card.getByTestId('plugin-toggle')).toHaveText('Enable');
    await card.getByTestId('plugin-toggle').click();
    await page.getByTestId('confirm-ok').click(); // acknowledge the disclaimer
    await expect(card.getByTestId('plugin-toggle')).toHaveText('Disable');

    // Now pasting a URL renders the link-intent card instead of searching.
    await page.goto('/');
    await pasteUrl();
    await expect(page.getByTestId('link-intent-card')).toBeVisible();

    // Disabling it removes the capability again.
    await page.goto('/settings/plugins');
    await card.getByTestId('plugin-toggle').click();
    await expect(card.getByTestId('plugin-toggle')).toHaveText('Enable');
    await page.goto('/');
    await pasteUrl();
    await expect(page.getByTestId('link-intent-card')).toHaveCount(0);
  });
```

- [ ] **Step 2: Run the CI e2e test**

Run: `cd packages/e2e && npx playwright test plugins.spec.ts`
Expected: PASS.

- [ ] **Step 3: Fix the out-of-CI screenshot flow**

In `packages/e2e/tests/downloads-acquire.screens.ts`, replace:

```ts
  // 1) Search page — the "Get from a link" box. It renders only once plugin
  //    state loads and a resolve-capable plugin is enabled, so wait for it.
  await page.goto('/');
  await expect(page.getByTestId('search-input')).toBeVisible();
  const acquireBox = page.getByTestId('acquire-url-input');
  if (await appeared(acquireBox, 8000)) {
    await acquireBox.scrollIntoViewIfNeeded();
    await shot(page, FLOW, 1, 'acquire box', { settleMs: 300 });
  } else {
    obs.record({
      kind: 'gap',
      title: 'URL acquire box not shown despite resolve plugins',
      severity: 'medium',
      detail: 'No acquire-url-input after 8s — expected when a resolve plugin (ytdlp/spotdl/archive) is enabled.',
      suggestion: 'Confirm PluginService.hasResolve drives the box; investigate if a resolve plugin is enabled but it stays hidden.',
    });
    await shot(page, FLOW, 1, 'search idle', { settleMs: 300 });
  }
```

with:

```ts
  // 1) Search page — pasting a link renders the link-intent card. It only
  //    appears once plugin state loads and a resolve-capable plugin is
  //    enabled, so wait for it after submitting a recognizable URL.
  await page.goto('/');
  await expect(page.getByTestId('search-input')).toBeVisible();
  await page.getByTestId('search-input').fill('https://youtu.be/dQw4w9WgXcQ');
  await page.getByTestId('search-submit').click();
  const linkCard = page.getByTestId('link-intent-card');
  if (await appeared(linkCard, 8000)) {
    await linkCard.scrollIntoViewIfNeeded();
    await shot(page, FLOW, 1, 'link intent card', { settleMs: 300 });
  } else {
    obs.record({
      kind: 'gap',
      title: 'Link-intent card not shown despite resolve plugins',
      severity: 'medium',
      detail: 'No link-intent-card after 8s — expected when a resolve plugin (ytdlp/spotdl/archive) is enabled.',
      suggestion: 'Confirm PluginService.hasResolve gates SearchComponent.handleSearch; investigate if a resolve plugin is enabled but the card stays hidden.',
    });
    await shot(page, FLOW, 1, 'search idle', { settleMs: 300 });
  }
```

Then replace the optional-acquire step further down:

```ts
  // 7) Optional: paste a URL and capture the in-flight Active card.
  if (ACQUIRE_URL) {
    await page.goto('/');
    const box = page.getByTestId('acquire-url-input');
    if (await appeared(box, 8000)) {
      await box.fill(ACQUIRE_URL);
      await page.getByTestId('acquire-submit').click();
      await page.goto('/downloads');
      const tab = await firstPresent(
        page.getByTestId('downloads-tab-active'),
        page.getByRole('button', { name: /^Active/ }),
      );
      if (tab) await appeared(tab, 8000);
      await page.waitForTimeout(1500);
      await shot(page, FLOW, 8, 'acquire inflight', { settleMs: 500 });
    } else {
      obs.record({
        kind: 'degraded',
        title: 'Cannot acquire URL — box hidden',
        severity: 'medium',
        suggestion: 'Enable a resolve plugin to test URL acquisition.',
      });
    }
  }
});
```

with:

```ts
  // 7) Optional: paste a URL, click Get on the link-intent card, and capture
  //    the in-flight Active card.
  if (ACQUIRE_URL) {
    await page.goto('/');
    await page.getByTestId('search-input').fill(ACQUIRE_URL);
    await page.getByTestId('search-submit').click();
    const linkCard = page.getByTestId('link-intent-card');
    if (await appeared(linkCard, 8000)) {
      await linkCard.getByTestId('link-intent-get').click();
      await page.goto('/downloads');
      const tab = await firstPresent(
        page.getByTestId('downloads-tab-active'),
        page.getByRole('button', { name: /^Active/ }),
      );
      if (tab) await appeared(tab, 8000);
      await page.waitForTimeout(1500);
      await shot(page, FLOW, 8, 'acquire inflight', { settleMs: 500 });
    } else {
      obs.record({
        kind: 'degraded',
        title: 'Cannot acquire URL — card hidden',
        severity: 'medium',
        suggestion: 'Enable a resolve plugin to test URL acquisition.',
      });
    }
  }
});
```

- [ ] **Step 4: Fix the out-of-CI playground metric**

In `packages/e2e/tests/song-acquisition.playground.ts`, replace:

```ts
  // 4. UI affordance: the curated acquire box is the URL box (resolve plugins),
  // never a per-song control. Note its presence so the report shows what IS there.
  const hasUrlAcquire = (await page.getByTestId('acquire-url-input').count()) > 0;
  obs.record({
    kind: 'metric',
    title: 'URL acquire box present (resolve plugin enabled)',
    value: hasUrlAcquire ? 'yes' : 'no',
    severity: 'info',
  });
```

with:

```ts
  // 4. UI affordance: the curated acquire path is the link-intent card that
  // appears in the search omnibox when a resolve plugin is enabled — never a
  // per-song control. Paste a harmless URL (non-mutating: only clicking Get
  // would submit) to check for it, then clear the box.
  await page.getByTestId('search-input').fill('https://youtu.be/dQw4w9WgXcQ');
  await page.getByTestId('search-submit').click();
  const hasUrlAcquire = (await page.getByTestId('link-intent-card').count()) > 0;
  await page.getByTestId('search-input').fill('');
  obs.record({
    kind: 'metric',
    title: 'Link-intent card present (resolve plugin enabled)',
    value: hasUrlAcquire ? 'yes' : 'no',
    severity: 'info',
  });
```

- [ ] **Step 5: Fix the out-of-CI real round-trip**

In `packages/e2e/tests/real-roundtrip.real.ts`, replace the doc comment:

```ts
 * SAFETY: every album this run adds is tracked and DELETED in `finally`, even on
 * failure, so prod is left clean. Drive it by URL ("Get from a link") with
 * PLAYGROUND_REAL_URL, or by artist/album with PLAYGROUND_REAL_ARTIST/_ALBUM.
```

with:

```ts
 * SAFETY: every album this run adds is tracked and DELETED in `finally`, even on
 * failure, so prod is left clean. Drive it by URL (pasted into the search
 * omnibox as a link-intent card) with PLAYGROUND_REAL_URL, or by artist/album
 * with PLAYGROUND_REAL_ARTIST/_ALBUM.
```

Then replace the acquisition block:

```ts
    if (REAL_URL) {
      await page.goto('/');
      const input = page.getByTestId('acquire-url-input');
      if ((await input.count()) === 0) {
        j.deadEnd('URL acquire box not present (resolve plugin disabled?)');
        obs.outcome('failed', 'no acquire box');
        return;
      }
      await input.fill(REAL_URL);
      j.step('paste URL into "Get from a link"');
      const submit = page.getByRole('button', { name: /acquire|get|download|add/i }).first();
      if ((await submit.count()) > 0) await submit.click();
      else await input.press('Enter');
      j.step('submit acquisition');
    } else {
```

with:

```ts
    if (REAL_URL) {
      await page.goto('/');
      await page.getByTestId('search-input').fill(REAL_URL);
      await page.getByTestId('search-submit').click();
      j.step('paste URL into the search omnibox');
      const linkCard = page.getByTestId('link-intent-card');
      if ((await linkCard.count()) === 0) {
        j.deadEnd('link-intent card not present (resolve plugin disabled?)');
        obs.outcome('failed', 'no link-intent card');
        return;
      }
      await linkCard.getByTestId('link-intent-get').click();
      j.step('submit acquisition');
    } else {
```

- [ ] **Step 6: Commit**

```bash
git add packages/e2e/tests/plugins.spec.ts packages/e2e/tests/downloads-acquire.screens.ts packages/e2e/tests/song-acquisition.playground.ts packages/e2e/tests/real-roundtrip.real.ts
git commit -m "test(e2e): adapt acquire-url selectors to the merged search omnibox"
```

---

### Task 5: Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-07-09-search-omnibox-merge-design.md`
- Modify: `docs/source-agnostic-acquisition.md`
- Modify: `docs/design-patterns.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Correct the spec's edge rule to match the compliance-gated implementation**

In `docs/superpowers/specs/2026-07-09-search-omnibox-merge-design.md`, replace:

```
- **No resolve-capable plugin enabled:** the card still renders, Get disabled,
  hint: "Enable a download extension (yt-dlp / spotDL) to get links." (Today
  the whole capability is hidden by the `hasResolve()` gate; the card makes it
  discoverable instead.)
```

with:

```
- **No resolve-capable plugin enabled:** link-intent parsing is gated behind
  `plugins.hasResolve()` — a pasted URL is treated as plain search text (no
  card), preserving the existing compliance-critical invariant that
  acquisition UI never appears before a plugin is enabled
  (`packages/e2e/tests/plugins.spec.ts`). This tightens the original design:
  during planning, a "disabled Get + hint" card was found to conflict with
  that invariant, so the card only appears once a resolve-capable plugin is
  enabled. A small × dismiss control (matching the existing banner-dismiss
  pattern elsewhere on the page) resets the card without requiring a new
  search.
```

- [ ] **Step 2: Update the source-agnostic-acquisition doc**

In `docs/source-agnostic-acquisition.md`, after the line (in the "Unified search" section):

```
- **Network song hits are blended, not a separate lane.** `lib/song-results.ts` `groupBySong()` (dedupe + best-copy pick: FLAC > other lossless > highest-bitrate lossy, then peer availability) feeds `songResultToCandidate` and is merged into the **one source-agnostic Results list** (`data-testid="results"`, rows `acquire-result` + `source-chip`) alongside archive.org/Spotify candidates (from `GET /api/sources/search`), each with a single Get. The raw folder-tree browser stays under the demoted "Advanced" disclosure for whole-album peer grabs. The source-status line (`data-testid="source-status"`) is neutral ("Sources: …").
```

add a new bullet immediately after it:

```
- **A pasted/shared link is a candidate too, not a second input.** The search omnibox recognizes a URL on submit (`parseLinkIntent`, `lib/link-intent.ts`) and renders one link-intent card (chip + Get, `data-testid="link-intent-card"`) in place of running a search — no separate "Get from a link" box or job list. Detection is gated behind `plugins.hasResolve()` so the affordance stays compliance-silent until a resolve-capable plugin is enabled (the PWA share-target is the one exception: sharing is an explicit intent, so it submits regardless and surfaces failure on the card). Get dispatches through the same `AcquireService.submit(url)` as every `via: 'url'` blended candidate; the card then tracks its own job by URL against `AcquireService.jobs()` — the Downloads feed remains the durable record.
```

- [ ] **Step 3: Update the design-patterns.md index bullet**

In `docs/design-patterns.md`, replace:

```
The URL box is framed as **"Get from a link"** (auto-detects YouTube/SoundCloud/Bandcamp/Spotify/archive.org via `AcquireService.submit` — no backend choice exposed).
```

with:

```
A pasted/shared link is recognized in the same search omnibox as one more acquisition candidate — a **link-intent card** (chip auto-labelled YouTube/SoundCloud/Bandcamp/Spotify/Internet Archive/Link by `lib/link-intent.ts`, dispatched through `AcquireService.submit` — no backend choice exposed, no separate URL box or job list). → [docs/source-agnostic-acquisition.md](source-agnostic-acquisition.md)
```

- [ ] **Step 4: Update the CLAUDE.md index bullet**

In `CLAUDE.md`, replace:

```
- **URL acquisition (yt-dlp / spotdl / archive)**: `POST /api/acquire` routes a URL to an enabled `resolve`-capable plugin → the same organizer + scan pipeline. → [docs/download-pipeline.md](docs/download-pipeline.md)
```

with:

```
- **URL acquisition (yt-dlp / spotdl / archive)**: `POST /api/acquire` routes a URL to an enabled `resolve`-capable plugin → the same organizer + scan pipeline; entered via a link-intent card in the search omnibox (merged with search, no separate URL box). → [docs/download-pipeline.md](docs/download-pipeline.md), [docs/source-agnostic-acquisition.md](docs/source-agnostic-acquisition.md)
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-07-09-search-omnibox-merge-design.md docs/source-agnostic-acquisition.md docs/design-patterns.md CLAUDE.md
git commit -m "docs: document the merged search omnibox link-intent card"
```

---

## Definition of done

- [ ] All 5 tasks committed.
- [ ] `bun run typecheck` passes at repo root.
- [ ] `cd packages/web && bun run test` passes (full web suite).
- [ ] `cd packages/e2e && npx playwright test plugins.spec.ts search.spec.ts` passes.
- [ ] Manually verify in a browser: paste a YouTube URL with yt-dlp disabled → runs a (fruitless) search, no card. Enable yt-dlp → paste the same URL → card appears with "YouTube" chip → Get → card shows progress → done state links to `/library`. Paste an `open.spotify.com` URL with spotDL disabled → button reads "Open in Spotify" and opens a new tab instead of submitting.
