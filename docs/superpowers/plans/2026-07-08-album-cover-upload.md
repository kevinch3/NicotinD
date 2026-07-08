# Album Cover Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin upload a local image file as an album's cover from the Fix-metadata modal, normalized to a standard square WebP before being written as the album's folder cover.

**Architecture:** A new `PUT /api/library/albums/:id/cover` route (sibling verb to the existing `POST` at that path) accepts multipart `image` form-data, validates it exactly like the existing artist-portrait upload, converts it via the already-existing `resizeCover(bytes, 1200)` (sharp, cover-fit square WebP — the same function thumbnails use), and writes it with the existing `writeFolderCover` + `deleteArtwork` + `purgeDiskArtCache` + `clearCoverNegativeCache` sequence the `songId` cover-picker branch already uses. The frontend adds an "Upload image…" button to the existing cover picker, wired through a new `LibraryApiService.uploadAlbumCover` call.

**Tech Stack:** Bun + Hono (API), `sharp` (image processing, already a dependency), Angular v22 standalone components with signals, `bun:test` (API), vitest (web).

## Global Constraints

- No new third-party dependencies — `sharp` is already used by `cover-thumbnail.ts`.
- Reuse existing exports (`resizeCover`, `writeFolderCover`, `deleteArtwork`, `purgeDiskArtCache`, `clearCoverNegativeCache`, `ALLOWED_OVERRIDE_TYPES`) rather than writing new image-processing or file-writing code.
- Admin-gated (`requireAdmin`), matching every other metadata-fix/cover-picker/artist-image route.
- New tests must land in files already picked up by CI's `bun test packages/api/src ...` (`ci.yml:52`) — extending an existing `*.test.ts` file satisfies this automatically, no workflow edit needed.
- Follow this repo's zero-comment-unless-non-obvious style; no docstrings.
- Every behavior change gets its doc update in the same task, per the project's Quality Gates (CLAUDE.md).

---

### Task 1: Backend — `PUT /api/library/albums/:id/cover` upload endpoint

**Files:**
- Modify: `packages/api/src/routes/library.ts:37` (add `resizeCover` import), `packages/api/src/routes/library.ts:884-930` (insert new route after the existing `POST /albums/:id/cover`), `packages/api/src/routes/library.ts:937` (rename constant)
- Test: `packages/api/src/routes/library.cover.test.ts` (extend)

**Interfaces:**
- Consumes: `resizeCover(bytes: Uint8Array, size: number): Promise<{ data: Uint8Array; contentType: string }>` (`services/cover-thumbnail.ts`, already exported); `writeFolderCover(albumDir: string, pic: { data: Uint8Array; contentType: string }): string`, `deleteArtwork(db, id, coverCacheDir?)`, `purgeDiskArtCache(coverCacheDir, key)` (`services/artwork-store.ts` / `services/cover-sources.ts`, already imported in `library.ts`); `clearCoverNegativeCache(id?: string): void` (`routes/streaming.ts`, already imported); `ALLOWED_OVERRIDE_TYPES` (`services/artist-image-override.ts`, already imported); module-scope `expandDir`, `resolveSongPath`, `isUnderMusicDir` (already defined later in `library.ts`, used by the existing `songId` branch).
- Produces: `PUT /albums/:id/cover` — 200 `{ ok: true }` on success; 400 (missing/undecodable file), 404 (unknown album / no track files), 413 (too large), 415 (bad type), 503 (no music dir), 403 (non-admin). Frontend and later tasks call this by URL only, no new exported TS symbol.

- [ ] **Step 1: Write the failing tests**

Open `packages/api/src/routes/library.cover.test.ts`. Add `mkdirSync, writeFileSync` to the existing `node:fs` import (currently `import { mkdtempSync, rmSync } from 'node:fs';`) so it reads:

```ts
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
```

Append this new `describe` block at the end of the file (after the `POST /albums/:id/cover — cover route reflects the change immediately` block added by the earlier negative-cache fix):

```ts
describe('PUT /albums/:id/cover — upload a custom image', () => {
  let dataDir: string;
  let musicDir: string;

  function makeApp(opts: { withMusicDir?: boolean; role?: 'admin' | 'user' } = {}): Hono<AuthEnv> {
    const { withMusicDir = true, role = 'admin' } = opts;
    const app = new Hono<AuthEnv>();
    app.use('*', async (c, next) => {
      c.set('user', { sub: 'u1', role, iat: 0, exp: 0 } as JwtPayload);
      await next();
    });
    const md = withMusicDir ? musicDir : undefined;
    app.route('/', libraryRoutes(md, { coverCacheDir: join(dataDir, 'cover-cache') }));
    app.route('/api', streamingRoutes(md ?? '/nonexistent', testDb, dataDir));
    return app;
  }

  async function pngBytes(width: number, height: number): Promise<Uint8Array> {
    const sharp = (await import('sharp')).default;
    const out = await sharp({
      create: { width, height, channels: 3, background: { r: 10, g: 200, b: 30 } },
    })
      .png()
      .toBuffer();
    return new Uint8Array(out);
  }

  function uploadForm(bytes: Uint8Array, type: string, field = 'image'): FormData {
    const form = new FormData();
    const ext = type.split('/')[1] ?? 'bin';
    form.append(field, new Blob([bytes as unknown as BlobPart], { type }), `cover.${ext}`);
    return form;
  }

  beforeEach(() => {
    testDb = new Database(':memory:');
    applySchema(testDb);
    seedAlbum(testDb); // album-1 (artist-1/Drukqs) + song-1
    dataDir = mkdtempSync(join(tmpdir(), 'nd-cover-upload-'));
    musicDir = mkdtempSync(join(tmpdir(), 'nd-cover-upload-music-'));
    mkdirSync(join(musicDir, 'Aphex Twin', 'Drukqs'), { recursive: true });
    writeFileSync(
      join(musicDir, 'Aphex Twin', 'Drukqs', '01 - Avril 14th.flac'),
      new Uint8Array([1, 2, 3]),
    );
    clearCoverNegativeCache();
  });
  afterEach(() => {
    testDb.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(musicDir, { recursive: true, force: true });
  });

  it('converts the upload to a square WebP capped at 1200px, writes it as the folder cover, and clears the negative cache', async () => {
    const app = makeApp();

    // Pre-cache the 404 the way an artless album would, before the upload lands.
    const before = await app.request('/api/cover/album-1');
    expect(before.status).toBe(404);

    const bytes = await pngBytes(2000, 1000); // non-square source
    const res = await app.request('/albums/album-1/cover', {
      method: 'PUT',
      body: uploadForm(bytes, 'image/png'),
    });
    expect(res.status).toBe(200);

    const written = join(musicDir, 'Aphex Twin', 'Drukqs', 'cover.webp');
    expect(existsSync(written)).toBe(true);
    const sharp = (await import('sharp')).default;
    const meta = await sharp(written).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(1200);
    expect(meta.height).toBe(1200);

    const after = await app.request('/api/cover/album-1');
    expect(after.status).toBe(200);
    expect(after.headers.get('content-type')).toBe('image/webp');
  });

  it('415s for a disallowed content type', async () => {
    const res = await makeApp().request('/albums/album-1/cover', {
      method: 'PUT',
      body: uploadForm(new Uint8Array([1, 2, 3]), 'text/plain'),
    });
    expect(res.status).toBe(415);
  });

  it('413s for a file over the 8 MB cap', async () => {
    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    const res = await makeApp().request('/albums/album-1/cover', {
      method: 'PUT',
      body: uploadForm(big, 'image/png'),
    });
    expect(res.status).toBe(413);
  });

  it('400s when the "image" part is missing', async () => {
    const form = new FormData();
    form.append('notimage', 'x');
    const res = await makeApp().request('/albums/album-1/cover', { method: 'PUT', body: form });
    expect(res.status).toBe(400);
  });

  it('400s for an allowed content-type with undecodable bytes', async () => {
    const res = await makeApp().request('/albums/album-1/cover', {
      method: 'PUT',
      body: uploadForm(new Uint8Array([1, 2, 3, 4]), 'image/png'),
    });
    expect(res.status).toBe(400);
  });

  it('404s for an unknown album', async () => {
    const bytes = await pngBytes(100, 100);
    const res = await makeApp().request('/albums/nope/cover', {
      method: 'PUT',
      body: uploadForm(bytes, 'image/png'),
    });
    expect(res.status).toBe(404);
  });

  it('404s for an album with no track files on disk', async () => {
    testDb.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, year, synced_at)
       VALUES ('album-empty', 'Nothing', 'Nobody', 'artist-2', 0, 0, 2020, 0)`,
    );
    const bytes = await pngBytes(100, 100);
    const res = await makeApp().request('/albums/album-empty/cover', {
      method: 'PUT',
      body: uploadForm(bytes, 'image/png'),
    });
    expect(res.status).toBe(404);
  });

  it('503s when no music dir is configured', async () => {
    const bytes = await pngBytes(100, 100);
    const res = await makeApp({ withMusicDir: false }).request('/albums/album-1/cover', {
      method: 'PUT',
      body: uploadForm(bytes, 'image/png'),
    });
    expect(res.status).toBe(503);
  });

  it('rejects a non-admin', async () => {
    const bytes = await pngBytes(100, 100);
    const res = await makeApp({ role: 'user' }).request('/albums/album-1/cover', {
      method: 'PUT',
      body: uploadForm(bytes, 'image/png'),
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/api/src/routes/library.cover.test.ts`
Expected: the 9 new tests FAIL (Hono has no `PUT /albums/:id/cover` route yet, so requests either 404 from the router or throw). The pre-existing tests in the file still pass.

- [ ] **Step 3: Add the `resizeCover` import**

In `packages/api/src/routes/library.ts`, change line 37 from:

```ts
import { clearCoverNegativeCache, extractCover, fetchRemoteCover } from './streaming.js';
```

to:

```ts
import { clearCoverNegativeCache, extractCover, fetchRemoteCover } from './streaming.js';
import { resizeCover } from '../services/cover-thumbnail.js';
```

- [ ] **Step 4: Rename the shared upload-size constant**

At `packages/api/src/routes/library.ts:937`, change:

```ts
  const MAX_ARTIST_IMAGE_BYTES = 8 * 1024 * 1024;
```

to:

```ts
  // Shared by the artist-image and album-cover upload routes.
  const MAX_IMAGE_UPLOAD_BYTES = 8 * 1024 * 1024;
```

Then update its one existing usage (currently `packages/api/src/routes/library.ts:980`, inside `PUT /artists/:id/image`):

```ts
    if (file.size > MAX_ARTIST_IMAGE_BYTES) {
```

to:

```ts
    if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
```

- [ ] **Step 5: Add the new route**

In `packages/api/src/routes/library.ts`, insert this new route immediately after the closing `});` of the existing `POST /albums/:id/cover` handler (currently ending at line 930, right before the `// ── Artist image override (admin) ──` comment):

```ts
  // Upload a custom cover image (multipart form-data, field "image"). Converted to
  // a standardized square WebP (resizeCover, same treatment thumbnails get) before
  // being written as the album's folder cover, so an arbitrary upload ends up
  // looking/behaving like every other cover this route serves. Admin only.
  app.put('/albums/:id/cover', async (c) => {
    requireAdmin(c);
    const id = c.req.param('id');
    if (!musicDir) return c.json({ error: 'Music directory not configured' }, 503);
    const db = getDatabase();
    const album = db
      .query<{ id: string }, [string]>('SELECT id FROM library_albums WHERE id = ?')
      .get(id);
    if (!album) return c.json({ error: 'Album not found' }, 404);

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'Expected multipart form-data' }, 400);
    }
    const file = form.get('image');
    if (!(file instanceof File)) return c.json({ error: 'Missing "image" file' }, 400);
    const contentType = file.type || '';
    if (!(ALLOWED_OVERRIDE_TYPES as readonly string[]).includes(contentType)) {
      return c.json({ error: 'Unsupported image type (use JPEG, PNG or WebP)' }, 415);
    }
    if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
      return c.json({ error: 'Image too large (max 8 MB)' }, 413);
    }
    const data = new Uint8Array(await file.arrayBuffer());
    if (data.length === 0) return c.json({ error: 'Empty image' }, 400);

    const md = expandDir(musicDir);
    const song = db
      .query<{ path: string }, [string]>(
        `SELECT path FROM library_songs WHERE album_id = ?
         ORDER BY COALESCE(disc, 1), COALESCE(track, 999999), path LIMIT 1`,
      )
      .get(id);
    const abs = song ? resolveSongPath(md, song.path) : null;
    if (!abs || !isUnderMusicDir(md, abs) || !existsSync(abs)) {
      return c.json({ error: 'Album has no track files to store a cover next to' }, 404);
    }

    let resized: { data: Uint8Array; contentType: string };
    try {
      resized = await resizeCover(data, 1200);
    } catch {
      return c.json({ error: 'Could not read that image' }, 400);
    }

    writeFolderCover(dirname(abs), resized);
    deleteArtwork(db, id, coverCacheDir); // clear canonical → folder art wins
    if (coverCacheDir) purgeDiskArtCache(coverCacheDir, id);
    clearCoverNegativeCache(id); // in case this id was 404-cached as artless
    return c.json({ ok: true });
  });

```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test packages/api/src/routes/library.cover.test.ts`
Expected: all tests in the file PASS (the 9 new ones plus the pre-existing ones).

- [ ] **Step 7: Run the full API suite, typecheck, and lint**

Run: `bun test packages/api/src`
Expected: all tests pass (2689+ before this task; should grow by 9).

Run: `bun run typecheck`
Expected: no errors.

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/routes/library.ts packages/api/src/routes/library.cover.test.ts
git commit -m "feat(library): upload a custom album cover image"
```

---

### Task 2: Frontend — upload button in the Fix-metadata cover picker

**Files:**
- Modify: `packages/web/src/app/services/api/library-api.service.ts` (add `uploadAlbumCover`)
- Modify: `packages/web/src/app/components/metadata-fix-modal/metadata-fix-modal.component.ts` (refactor `applyCover` → `runCoverApply`, add upload trigger/handler)
- Modify: `packages/web/src/app/components/metadata-fix-modal/metadata-fix-modal.component.html` (add upload button + hidden file input)
- Test: `packages/web/src/app/components/metadata-fix-modal/metadata-fix-modal.component.spec.ts` (extend)

**Interfaces:**
- Consumes: Task 1's `PUT /api/library/albums/:id/cover` (multipart).
- Produces: `LibraryApiService.uploadAlbumCover(id: string, file: File): Observable<{ ok: boolean }>`; `MetadataFixModalComponent.triggerCoverUpload(): void`, `MetadataFixModalComponent.onCoverFileSelected(event: Event): Promise<void>`.

- [ ] **Step 1: Write the failing component tests**

In `packages/web/src/app/components/metadata-fix-modal/metadata-fix-modal.component.spec.ts`, add `uploadAlbumCover` to the mock setup. Change:

```ts
  const getCoverCandidates = vi.fn(() => of({ current: null, lidarr: [], files: [] }));
  const applyCover = vi.fn(() => of({ ok: true }));

  function create() {
    getCoverCandidates.mockClear();
    applyCover.mockClear();
    getCoverCandidates.mockReturnValue(of({ current: null, lidarr: [], files: [] }));
    applyCover.mockReturnValue(of({ ok: true }));

    TestBed.configureTestingModule({
      imports: [MetadataFixModalComponent],
      providers: [
        {
          provide: LibraryApiService,
          useValue: { getCoverCandidates, applyCover, getMetadataCandidates: vi.fn() },
        },
```

to:

```ts
  const getCoverCandidates = vi.fn(() => of({ current: null, lidarr: [], files: [] }));
  const applyCover = vi.fn(() => of({ ok: true }));
  const uploadAlbumCover = vi.fn(() => of({ ok: true }));

  function create() {
    getCoverCandidates.mockClear();
    applyCover.mockClear();
    uploadAlbumCover.mockClear();
    getCoverCandidates.mockReturnValue(of({ current: null, lidarr: [], files: [] }));
    applyCover.mockReturnValue(of({ ok: true }));
    uploadAlbumCover.mockReturnValue(of({ ok: true }));

    TestBed.configureTestingModule({
      imports: [MetadataFixModalComponent],
      providers: [
        {
          provide: LibraryApiService,
          useValue: {
            getCoverCandidates,
            applyCover,
            uploadAlbumCover,
            getMetadataCandidates: vi.fn(),
          },
        },
```

Then append these two tests at the end of the `describe` block, before its closing `});`:

```ts

  it('uploads a selected file and emits coverChanged', async () => {
    const c = create();
    const emitted = vi.fn();
    c.coverChanged.subscribe(emitted);
    const file = new File([new Uint8Array([1, 2, 3])], 'cover.png', { type: 'image/png' });
    const event = { target: { files: [file], value: 'x' } } as unknown as Event;

    await c.onCoverFileSelected(event);

    expect(uploadAlbumCover).toHaveBeenCalledWith('album-1', file);
    expect(emitted).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no file is selected for upload', async () => {
    const c = create();
    const event = { target: { files: [], value: '' } } as unknown as Event;
    await c.onCoverFileSelected(event);
    expect(uploadAlbumCover).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run --filter @nicotind/web test -- metadata-fix-modal`
Expected: FAIL — `onCoverFileSelected` does not exist on `MetadataFixModalComponent`.

- [ ] **Step 3: Add `uploadAlbumCover` to `LibraryApiService`**

In `packages/web/src/app/services/api/library-api.service.ts`, immediately after the existing `applyCover` method:

```ts
  /** Apply only the album cover (admin) — by URL or an album track's embedded art. */
  applyCover(id: string, body: ApplyCoverRequest) {
    return this.http.post<{ ok: boolean }>(`/api/library/albums/${id}/cover`, body);
  }
  /** Upload a custom cover image for an album (admin); converted + written as the folder cover. */
  uploadAlbumCover(id: string, file: File) {
    const form = new FormData();
    form.append('image', file);
    return this.http.put<{ ok: boolean }>(`/api/library/albums/${id}/cover`, form);
  }
```

- [ ] **Step 4: Refactor `MetadataFixModalComponent` and add the upload handler**

In `packages/web/src/app/components/metadata-fix-modal/metadata-fix-modal.component.ts`, change the top import line:

```ts
import {
  Component,
  HostListener,
  inject,
  input,
  output,
  signal,
  computed,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
```

to:

```ts
import {
  Component,
  ElementRef,
  HostListener,
  inject,
  input,
  output,
  signal,
  computed,
  viewChild,
  OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom, type Observable } from 'rxjs';
```

Add a viewChild ref next to the other cover-picker state (after the existing `readonly customCoverUrl = signal('');` line):

```ts
  readonly customCoverUrl = signal('');
  readonly coverFileInput = viewChild<ElementRef<HTMLInputElement>>('coverFileInput');
```

Replace the whole block from `selectCover` through the closing `}` of the private `applyCover` method:

```ts
  /** Apply a picked cover (Lidarr alt / album-track embedded art). Current = no-op. */
  async selectCover(c: AlbumCoverCandidate): Promise<void> {
    const req = coverCandidateToRequest(c);
    if (req) await this.applyCover(req);
  }

  /** Apply a pasted cover URL. */
  async applyCustomCover(): Promise<void> {
    const req = customCoverToRequest(this.customCoverUrl());
    if (!req) {
      this.msg.set('Paste an image URL first.');
      return;
    }
    await this.applyCover(req);
  }

  private async applyCover(req: import('../../../types/core').ApplyCoverRequest): Promise<void> {
    if (this.coverApplying()) return;
    this.coverApplying.set(true);
    this.msg.set(null);
    try {
      await firstValueFrom(this.api.applyCover(this.albumId(), req));
      this.customCoverUrl.set('');
      this.coverChanged.emit();
      // Refresh the picker so the "Current" thumbnail reflects the new cover.
      await this.loadCovers();
    } catch (err) {
      this.msg.set(httpErrorMessage(err, 'Could not apply the cover.'));
    } finally {
      this.coverApplying.set(false);
    }
  }
```

with:

```ts
  /** Apply a picked cover (Lidarr alt / album-track embedded art). Current = no-op. */
  async selectCover(c: AlbumCoverCandidate): Promise<void> {
    const req = coverCandidateToRequest(c);
    if (req) await this.runCoverApply(() => this.api.applyCover(this.albumId(), req));
  }

  /** Apply a pasted cover URL. */
  async applyCustomCover(): Promise<void> {
    const req = customCoverToRequest(this.customCoverUrl());
    if (!req) {
      this.msg.set('Paste an image URL first.');
      return;
    }
    await this.runCoverApply(() => this.api.applyCover(this.albumId(), req));
  }

  /** Open the OS file picker (wired to the hidden input). */
  triggerCoverUpload(): void {
    this.coverFileInput()?.nativeElement.click();
  }

  /** Upload a local image file as the album cover. */
  async onCoverFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow re-selecting the same file later
    if (!file) return;
    await this.runCoverApply(() => this.api.uploadAlbumCover(this.albumId(), file));
  }

  private async runCoverApply(action: () => Observable<{ ok: boolean }>): Promise<void> {
    if (this.coverApplying()) return;
    this.coverApplying.set(true);
    this.msg.set(null);
    try {
      await firstValueFrom(action());
      this.customCoverUrl.set('');
      this.coverChanged.emit();
      // Refresh the picker so the "Current" thumbnail reflects the new cover.
      await this.loadCovers();
    } catch (err) {
      this.msg.set(httpErrorMessage(err, 'Could not apply the cover.'));
    } finally {
      this.coverApplying.set(false);
    }
  }
```

- [ ] **Step 5: Add the upload button + hidden input to the template**

In `packages/web/src/app/components/metadata-fix-modal/metadata-fix-modal.component.html`, the cover-picker block currently ends with:

```html
        <div class="flex gap-2 mt-2">
          <input
            type="text"
            [ngModel]="customCoverUrl()"
            (ngModelChange)="customCoverUrl.set($event)"
            (keydown.enter)="applyCustomCover()"
            placeholder="Or paste an image URL…"
            data-testid="cover-url-input"
            class="flex-1 px-3 py-2 rounded-lg bg-theme-surface-2 text-theme-primary text-sm border border-theme focus:outline-none focus:border-theme-accent"
          />
          <button
            (click)="applyCustomCover()"
            [disabled]="coverApplying()"
            data-testid="cover-url-apply"
            class="px-4 py-2 rounded-lg text-sm bg-theme-surface text-theme-secondary hover:bg-theme-hover transition disabled:opacity-50"
          >
            {{ coverApplying() ? 'Applying…' : 'Set cover' }}
          </button>
        </div>
      </div>
    }
```

Change it to add a second row for the upload control, right after the URL row and before the closing `</div>`:

```html
        <div class="flex gap-2 mt-2">
          <input
            type="text"
            [ngModel]="customCoverUrl()"
            (ngModelChange)="customCoverUrl.set($event)"
            (keydown.enter)="applyCustomCover()"
            placeholder="Or paste an image URL…"
            data-testid="cover-url-input"
            class="flex-1 px-3 py-2 rounded-lg bg-theme-surface-2 text-theme-primary text-sm border border-theme focus:outline-none focus:border-theme-accent"
          />
          <button
            (click)="applyCustomCover()"
            [disabled]="coverApplying()"
            data-testid="cover-url-apply"
            class="px-4 py-2 rounded-lg text-sm bg-theme-surface text-theme-secondary hover:bg-theme-hover transition disabled:opacity-50"
          >
            {{ coverApplying() ? 'Applying…' : 'Set cover' }}
          </button>
        </div>
        <div class="flex gap-2 mt-2">
          <button
            type="button"
            (click)="triggerCoverUpload()"
            [disabled]="coverApplying()"
            data-testid="cover-upload-button"
            class="px-4 py-2 rounded-lg text-sm bg-theme-surface text-theme-secondary hover:bg-theme-hover transition disabled:opacity-50"
          >
            Upload image…
          </button>
          <input
            #coverFileInput
            type="file"
            accept="image/jpeg,image/png,image/webp"
            class="hidden"
            data-testid="cover-upload-file"
            (change)="onCoverFileSelected($event)"
          />
        </div>
      </div>
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run --filter @nicotind/web test -- metadata-fix-modal`
Expected: all tests in the file PASS.

Note: per this repo's known local vitest env gap (`localStorage.clear is not a function`), if the whole web suite doesn't run cleanly locally, run this file directly as above and rely on CI (`ci.yml` web job) for the full-suite pass.

- [ ] **Step 7: Typecheck and lint**

Run: `bun run typecheck`
Expected: no errors.

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/app/services/api/library-api.service.ts packages/web/src/app/components/metadata-fix-modal/metadata-fix-modal.component.ts packages/web/src/app/components/metadata-fix-modal/metadata-fix-modal.component.html packages/web/src/app/components/metadata-fix-modal/metadata-fix-modal.component.spec.ts
git commit -m "feat(web): upload a custom album cover image from the Fix-metadata modal"
```

---

### Task 3: Docs

**Files:**
- Modify: `docs/metadata-optimize.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: nothing new — describes Tasks 1–2's shipped behavior.
- Produces: nothing — documentation only.

- [ ] **Step 1: Update the Cover picker section**

In `docs/metadata-optimize.md`, the `### Endpoints (admin)` list under `## Cover picker (change just the artwork)` currently reads (after the earlier negative-cache fix in this session):

```markdown
- **`POST /api/library/albums/:id/cover`** (`ApplyCoverRequest`): exactly one of —
  - `coverUrl` (Lidarr alt **or** a pasted custom URL) → `setArtwork(db, id, 'album', url, coverCacheDir)`.
  - `songId` (an album track) → `extractEmbeddedPicture` → `writeFolderCover(dirname)` → **`deleteArtwork` (clears the canonical override) + `purgeDiskArtCache`** so the cover route falls back to the new folder image. This is also the **revert-to-original** path: pick a track whose embedded art is the original to undo a bad canonical cover.
  - Both branches, plus `applyMetadataFix`'s `coverUrl` path and `optimizeAlbum`'s Lidarr-match cover write, call `clearCoverNegativeCache(id)` (`routes/streaming.js`) after the write. **Why:** an album with no art yet gets its id memoized in the cover route's `noArtCache` (10 min TTL, see [library-scanner.md](library-scanner.md)) the first time `/api/cover/:id` 404s; every album-cover writer must invalidate that entry for its id or the picked cover silently never appears — not even on a page refresh — until the TTL expires (regression: was only wired for the artist-image override paths, not the album ones; regression-tested in `routes/library.cover.test.ts`).
- Embedded thumbnails are served by the existing cover route with **`?embedded=1`** (skips canonical+folder, caches under a `~emb`-suffixed key) — see [library-scanner.md](library-scanner.md).
```

Add a new bullet for the upload endpoint right after the `POST` bullet's sub-list, before the "Embedded thumbnails" line:

```markdown
- **`PUT /api/library/albums/:id/cover`** (multipart, field `image`, JPEG/PNG/WebP ≤ 8 MB — same allow-list/cap as the artist-portrait upload, shared as `MAX_IMAGE_UPLOAD_BYTES`): resolves the album's representative track's folder → converts the upload via `resizeCover(bytes, 1200)` (the same sharp cover-fit-square-WebP function thumbnails already use, just requested at 1200px) → `writeFolderCover` + `deleteArtwork` + `purgeDiskArtCache` + `clearCoverNegativeCache`, identical cleanup to the `songId` branch above. 404s if the album has no track files to place a cover next to; 400 if the bytes don't decode as an image.
```

- [ ] **Step 2: Update the Web section**

In the same file, the `### Web` paragraph currently ends with:

```markdown
`MetadataFixModalComponent`'s cover grid (`data-testid="cover-option"`) + a custom-URL input (`data-testid="cover-url-input"`/`-apply`). The picker seeds a **synthetic "Current"** option in `ngOnInit` so it renders instantly and never blocks on a slow Lidarr lookup; pure mapping lives in `lib/cover-candidates.ts` (`flattenCoverCandidates`/`coverThumbUrl`/`coverCandidateToRequest`/`customCoverToRequest`). Applying a cover emits **`coverChanged`** (distinct from `applied`) so album-detail refetches + cache-busts the hero cover **without closing** the modal.
```

Append a sentence:

```markdown
`MetadataFixModalComponent`'s cover grid (`data-testid="cover-option"`) + a custom-URL input (`data-testid="cover-url-input"`/`-apply`) + an **upload button** (`data-testid="cover-upload-button"`/`-file`, hidden `<input type=file>`). The picker seeds a **synthetic "Current"** option in `ngOnInit` so it renders instantly and never blocks on a slow Lidarr lookup; pure mapping lives in `lib/cover-candidates.ts` (`flattenCoverCandidates`/`coverThumbUrl`/`coverCandidateToRequest`/`customCoverToRequest`). All three apply paths (candidate pick, custom URL, file upload) share one private `runCoverApply` that owns the busy-state/error/refresh scaffolding. Applying a cover emits **`coverChanged`** (distinct from `applied`) so album-detail refetches + cache-busts the hero cover **without closing** the modal.
```

- [ ] **Step 3: Update the CLAUDE.md index line**

In `CLAUDE.md`, change:

```markdown
- **User-driven metadata fix**: interactive Lidarr candidate search + free-text + multi-source cover picker, persisted in `library_metadata_overrides` with immediate canonical re-point. → [docs/metadata-optimize.md](docs/metadata-optimize.md)
```

to:

```markdown
- **User-driven metadata fix**: interactive Lidarr candidate search + free-text + multi-source cover picker (Lidarr/URL/track-embedded/**upload**), persisted in `library_metadata_overrides` with immediate canonical re-point. → [docs/metadata-optimize.md](docs/metadata-optimize.md)
```

- [ ] **Step 4: Commit**

```bash
git add docs/metadata-optimize.md CLAUDE.md
git commit -m "docs(library): document the album cover upload endpoint and UI"
```
