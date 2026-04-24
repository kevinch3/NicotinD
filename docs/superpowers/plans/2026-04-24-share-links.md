# Share Links for Playlists and Albums — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let logged-in users generate a short-lived, token-gated share link for any album or playlist that gives recipients a read-only, audio-capable view for 5 minutes from first open.

**Architecture:** A 22-char base64url share token stored in SQLite activates on first visit — setting `first_accessed_at` and `expires_at = now + 300s` — and returns a standard 5-minute JWT. The frontend stores this JWT in memory and passes it via `Authorization` header (or `?token=` query param) to all existing API endpoints unchanged. A single `share: true` claim in the JWT triggers a read-only guard in the auth middleware.

**Tech Stack:** Bun/Hono (API), bun:test (API tests), Angular 22 standalone components + signals (web), Tailwind CSS, jose (JWT), bun:sqlite (DB)

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `packages/core/src/types/nicotind.ts` | Add `share?`, `scope?` to `JwtPayload` |
| Modify | `packages/api/src/db.ts` | Add `share_tokens` table |
| **Create** | `packages/api/src/routes/share.ts` | POST /api/share + POST /api/share/activate/:token |
| **Create** | `packages/api/src/routes/share.test.ts` | API tests |
| Modify | `packages/api/src/middleware/auth.ts` | Read-only guard for share JWTs |
| Modify | `packages/api/src/middleware/auth.test.ts` | Test the new guard |
| Modify | `packages/api/src/index.ts` | Register share routes |
| **Create** | `packages/web/src/app/services/share-session.service.ts` | Share JWT signal |
| **Create** | `packages/web/src/app/pages/share/share-view.component.ts` | Share page TS |
| **Create** | `packages/web/src/app/pages/share/share-view.component.html` | Share page template |
| Modify | `packages/web/src/app/app.routes.ts` | Add /share/:token route |
| Modify | `packages/web/src/app/pages/library/album-detail.component.ts` | shareAlbum() method |
| Modify | `packages/web/src/app/pages/library/album-detail.component.html` | Share button |
| Modify | `packages/web/src/app/pages/playlists/playlists.component.ts` | sharePlaylist() method |
| Modify | `packages/web/src/app/pages/playlists/playlists.component.html` | Share button |

---

## Task 1: Extend JwtPayload type and add DB table

**Files:**
- Modify: `packages/core/src/types/nicotind.ts`
- Modify: `packages/api/src/db.ts`

- [ ] **Step 1: Extend JwtPayload in core types**

Open `packages/core/src/types/nicotind.ts` and update the `JwtPayload` interface (currently at line 64):

```typescript
export interface JwtPayload {
  sub: string;
  username?: string;
  role?: 'admin' | 'user';
  share?: boolean;
  scope?: string;
  iat: number;
  exp: number;
}
```

(`username` and `role` are made optional so share JWTs — which omit them — still satisfy the type.)

- [ ] **Step 2: Add share_tokens table to db.ts**

In `packages/api/src/db.ts`, add this block after the `completed_downloads` indexes (before `return db`):

```typescript
  db.run(`
    CREATE TABLE IF NOT EXISTS share_tokens (
      token             TEXT    PRIMARY KEY,
      resource_type     TEXT    NOT NULL CHECK (resource_type IN ('playlist', 'album')),
      resource_id       TEXT    NOT NULL,
      created_by        TEXT    NOT NULL REFERENCES users(id),
      created_at        INTEGER NOT NULL,
      first_accessed_at INTEGER,
      expires_at        INTEGER
    )
  `);
```

- [ ] **Step 3: Verify type-check passes**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun run typecheck
```

Expected: no errors (or same errors as before this change).

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types/nicotind.ts packages/api/src/db.ts
git commit -m "feat(share): add share_tokens table and extend JwtPayload"
```

---

## Task 2: Create share API routes

**Files:**
- Create: `packages/api/src/routes/share.ts`
- Create: `packages/api/src/routes/share.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/api/src/routes/share.test.ts`:

```typescript
import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { shareRoutes } from './share.js';
import { authMiddleware, signJwt } from '../middleware/auth.js';

const testDb = new Database(':memory:');
testDb.run(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
testDb.run(`
  CREATE TABLE share_tokens (
    token             TEXT    PRIMARY KEY,
    resource_type     TEXT    NOT NULL,
    resource_id       TEXT    NOT NULL,
    created_by        TEXT    NOT NULL,
    created_at        INTEGER NOT NULL,
    first_accessed_at INTEGER,
    expires_at        INTEGER
  )
`);
testDb.run("INSERT INTO users VALUES ('u1', 'alice', 'hash', 'user', 'active', datetime('now'))");

mock.module('../db.js', () => ({ getDatabase: () => testDb }));

const SECRET = 'test-secret';

function buildApp() {
  const app = new Hono<any>();
  const auth = authMiddleware(SECRET);
  app.route('/api/share', shareRoutes(SECRET, auth));
  return app;
}

describe('POST /api/share — generate', () => {
  it('returns 401 without auth', async () => {
    const app = buildApp();
    const res = await app.request('/api/share', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceType: 'album', resourceId: 'al1' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid resourceType', async () => {
    const app = buildApp();
    const token = await signJwt({ sub: 'u1', username: 'alice', role: 'user' }, SECRET);
    const res = await app.request('/api/share', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ resourceType: 'song', resourceId: 'x1' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns a share URL for a valid album', async () => {
    const app = buildApp();
    const token = await signJwt({ sub: 'u1', username: 'alice', role: 'user' }, SECRET);
    const res = await app.request('/api/share', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ resourceType: 'album', resourceId: 'al1' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { url: string };
    expect(body.url).toMatch(/\/share\/[A-Za-z0-9_-]{22}$/);
  });
});

describe('POST /api/share/activate/:token — activate', () => {
  it('returns 404 for unknown token', async () => {
    const app = buildApp();
    const res = await app.request('/api/share/activate/nonexistent', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('activates on first call and returns jwt + resource info', async () => {
    const app = buildApp();
    // Insert a fresh token
    testDb.run(
      "INSERT INTO share_tokens VALUES ('tok1', 'album', 'al42', 'u1', ?, NULL, NULL)",
      [Date.now()]
    );
    const res = await app.request('/api/share/activate/tok1', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { jwt: string; resourceType: string; resourceId: string };
    expect(body.resourceType).toBe('album');
    expect(body.resourceId).toBe('al42');
    expect(typeof body.jwt).toBe('string');
    // first_accessed_at is now set
    const row = testDb.query<any, [string]>('SELECT * FROM share_tokens WHERE token = ?').get('tok1');
    expect(row.first_accessed_at).not.toBeNull();
  });

  it('re-issues jwt with same exp on repeat call within window', async () => {
    const app = buildApp();
    const expiresAt = Date.now() + 300_000;
    testDb.run(
      "INSERT OR REPLACE INTO share_tokens VALUES ('tok2', 'playlist', 'pl1', 'u1', ?, ?, ?)",
      [Date.now() - 10_000, Date.now() - 5_000, expiresAt]
    );
    const res = await app.request('/api/share/activate/tok2', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { jwt: string };
    // Decode JWT and check exp
    const [, payloadB64] = body.jwt.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    expect(payload.exp).toBe(Math.floor(expiresAt / 1000));
  });

  it('returns 410 for expired token', async () => {
    const app = buildApp();
    const past = Date.now() - 1000;
    testDb.run(
      "INSERT OR REPLACE INTO share_tokens VALUES ('tok3', 'album', 'al1', 'u1', ?, ?, ?)",
      [Date.now() - 400_000, Date.now() - 400_000, past]
    );
    const res = await app.request('/api/share/activate/tok3', { method: 'POST' });
    expect(res.status).toBe(410);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun test packages/api/src/routes/share.test.ts
```

Expected: error like `Cannot find module './share.js'`

- [ ] **Step 3: Create share.ts**

Create `packages/api/src/routes/share.ts`:

```typescript
import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import * as jose from 'jose';
import type { MiddlewareHandler } from 'hono';
import type { AuthEnv } from '../middleware/auth.js';
import { getDatabase } from '../db.js';

interface ShareTokenRow {
  token: string;
  resource_type: 'playlist' | 'album';
  resource_id: string;
  created_by: string;
  created_at: number;
  first_accessed_at: number | null;
  expires_at: number | null;
}

async function mintShareJwt(creatorId: string, expiresAtMs: number, jwtSecret: string): Promise<string> {
  const secretKey = new TextEncoder().encode(jwtSecret);
  return new jose.SignJWT({ share: true, scope: 'read' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(creatorId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAtMs / 1000))
    .sign(secretKey);
}

export function shareRoutes(jwtSecret: string, auth: MiddlewareHandler) {
  const app = new Hono<AuthEnv>();

  // POST /api/share — generate share link (auth required)
  app.post('/', auth, async (c) => {
    const body = await c.req.json<{ resourceType?: string; resourceId?: string }>();

    if (!body.resourceType || !body.resourceId) {
      return c.json({ error: 'resourceType and resourceId are required' }, 400);
    }
    if (body.resourceType !== 'playlist' && body.resourceType !== 'album') {
      return c.json({ error: 'resourceType must be playlist or album' }, 400);
    }

    const user = c.get('user');
    const token = randomBytes(16).toString('base64url');
    const now = Date.now();

    getDatabase().run(
      'INSERT INTO share_tokens (token, resource_type, resource_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
      [token, body.resourceType, body.resourceId, user.sub, now],
    );

    const origin = new URL(c.req.url).origin;
    return c.json({ url: `${origin}/share/${token}` });
  });

  // POST /api/share/activate/:token — public, no auth
  app.post('/activate/:token', async (c) => {
    const db = getDatabase();
    const row = db
      .query<ShareTokenRow, [string]>('SELECT * FROM share_tokens WHERE token = ?')
      .get(c.req.param('token'));

    if (!row) return c.json({ error: 'Not found' }, 404);

    const now = Date.now();

    if (row.expires_at !== null && row.expires_at < now) {
      return c.json({ error: 'Share link has expired' }, 410);
    }

    let expiresAtMs: number;

    if (row.first_accessed_at === null) {
      expiresAtMs = now + 300_000;
      db.run('UPDATE share_tokens SET first_accessed_at = ?, expires_at = ? WHERE token = ?', [
        now,
        expiresAtMs,
        row.token,
      ]);
    } else {
      expiresAtMs = row.expires_at!;
    }

    const jwt = await mintShareJwt(row.created_by, expiresAtMs, jwtSecret);

    return c.json({ jwt, resourceType: row.resource_type, resourceId: row.resource_id });
  });

  return app;
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun test packages/api/src/routes/share.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/routes/share.ts packages/api/src/routes/share.test.ts
git commit -m "feat(share): add share route — generate and activate endpoints"
```

---

## Task 3: Register share routes in the API server

**Files:**
- Modify: `packages/api/src/index.ts`

- [ ] **Step 1: Add the import and route registration**

In `packages/api/src/index.ts`, add the import after the existing route imports:

```typescript
import { shareRoutes } from './routes/share.js';
```

Then, after the `const auth = authMiddleware(config.jwt.secret);` line (around line 127), register the share routes. Do NOT add `app.use('/api/share/*', auth)` — auth is applied inline per-route inside `shareRoutes`. Add:

```typescript
  app.route('/api/share', shareRoutes(config.jwt.secret, auth));
```

Place this line alongside the other `app.route(...)` calls (e.g. after `app.route('/api/playlists', playlistRoutes(navidrome))`).

- [ ] **Step 2: Verify type-check**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun run typecheck
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "feat(share): register share routes in API server"
```

---

## Task 4: Auth middleware — read-only guard for share JWTs

**Files:**
- Modify: `packages/api/src/middleware/auth.ts`
- Modify: `packages/api/src/middleware/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Open `packages/api/src/middleware/auth.test.ts` and add this new `describe` block at the end of the file (before the closing of any wrapper, or just appended):

```typescript
describe('authMiddleware — share JWT read-only guard', () => {
  it('allows GET requests with share JWTs', async () => {
    const app = new Hono<any>();
    app.use('/protected', authMiddleware(SECRET));
    app.get('/protected', (c) => c.json({ ok: true }));

    const shareToken = await signJwt(
      { sub: 'u1', username: 'alice', role: 'user', share: true, scope: 'read' } as any,
      SECRET,
    );
    const res = await app.request('/protected', {
      headers: { Authorization: `Bearer ${shareToken}` },
    });
    expect(res.status).toBe(200);
  });

  it('blocks non-GET requests with share JWTs', async () => {
    const app = new Hono<any>();
    app.use('/protected', authMiddleware(SECRET));
    app.post('/protected', (c) => c.json({ ok: true }));

    const shareToken = await signJwt(
      { sub: 'u1', username: 'alice', role: 'user', share: true, scope: 'read' } as any,
      SECRET,
    );
    const res = await app.request('/protected', {
      method: 'POST',
      headers: { Authorization: `Bearer ${shareToken}` },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Share sessions are read-only' });
  });
});
```

- [ ] **Step 2: Run the tests — verify they fail**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun test packages/api/src/middleware/auth.test.ts
```

Expected: the two new share tests fail.

- [ ] **Step 3: Add the guard to auth middleware**

In `packages/api/src/middleware/auth.ts`, add these two lines after `c.set('user', jwtPayload)` and before `await next()`:

```typescript
      if (jwtPayload.share === true && c.req.method !== 'GET') {
        return c.json({ error: 'Share sessions are read-only' }, 403);
      }
```

The updated block in context:

```typescript
      c.set('user', jwtPayload);
      if (jwtPayload.share === true && c.req.method !== 'GET') {
        return c.json({ error: 'Share sessions are read-only' }, 403);
      }
      await next();
```

- [ ] **Step 4: Run the tests — verify they pass**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun test packages/api/src/middleware/auth.test.ts
```

Expected: all tests pass including the two new share tests.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/middleware/auth.ts packages/api/src/middleware/auth.test.ts
git commit -m "feat(share): read-only guard for share JWTs in auth middleware"
```

---

## Task 5: Angular ShareSessionService

**Files:**
- Create: `packages/web/src/app/services/share-session.service.ts`

- [ ] **Step 1: Create the service**

Create `packages/web/src/app/services/share-session.service.ts`:

```typescript
import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface ShareActivation {
  jwt: string;
  resourceType: 'playlist' | 'album';
  resourceId: string;
}

@Injectable({ providedIn: 'root' })
export class ShareSessionService {
  private http = inject(HttpClient);

  readonly shareJwt = signal<string | null>(null);

  async activate(token: string): Promise<ShareActivation> {
    const result = await firstValueFrom(
      this.http.post<ShareActivation>(`/api/share/activate/${token}`, null),
    );
    this.shareJwt.set(result.jwt);
    return result;
  }
}
```

- [ ] **Step 2: Verify type-check**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun run typecheck
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/app/services/share-session.service.ts
git commit -m "feat(share): add ShareSessionService"
```

---

## Task 6: ShareViewComponent and route

**Files:**
- Create: `packages/web/src/app/pages/share/share-view.component.ts`
- Create: `packages/web/src/app/pages/share/share-view.component.html`
- Modify: `packages/web/src/app/app.routes.ts`

- [ ] **Step 1: Create the component TS**

Create `packages/web/src/app/pages/share/share-view.component.ts`:

```typescript
import {
  Component,
  inject,
  signal,
  computed,
  OnInit,
  OnDestroy,
  viewChild,
  ElementRef,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Meta, Title } from '@angular/platform-browser';
import { firstValueFrom } from 'rxjs';
import { ShareSessionService } from '../../services/share-session.service';

interface ShareTrack {
  id: string;
  title: string;
  artist: string;
  duration?: number;
  coverArt?: string;
  track?: number;
}

type PageState = 'loading' | 'active' | 'expired' | 'error';

@Component({
  selector: 'app-share-view',
  templateUrl: './share-view.component.html',
  imports: [],
})
export class ShareViewComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private http = inject(HttpClient);
  private meta = inject(Meta);
  private titleService = inject(Title);
  private shareSession = inject(ShareSessionService);

  readonly audioRef = viewChild<ElementRef<HTMLAudioElement>>('audioEl');

  readonly state = signal<PageState>('loading');
  readonly resourceName = signal('');
  readonly resourceSubtitle = signal('');
  readonly coverArtId = signal<string | null>(null);
  readonly tracks = signal<ShareTrack[]>([]);
  readonly currentIndex = signal(0);
  readonly isPlaying = signal(false);
  readonly currentTime = signal(0);
  readonly audioDuration = signal(0);

  private shareToken = '';

  readonly currentTrack = computed(() => this.tracks()[this.currentIndex()] ?? null);

  coverUrl = computed(() => {
    const id = this.coverArtId();
    const jwt = this.shareSession.shareJwt();
    return id && jwt ? `/api/cover/${id}?size=300&token=${jwt}` : null;
  });

  streamUrl = computed(() => {
    const track = this.currentTrack();
    const jwt = this.shareSession.shareJwt();
    return track && jwt ? `/api/stream/${track.id}?token=${jwt}` : null;
  });

  async ngOnInit(): Promise<void> {
    this.shareToken = this.route.snapshot.paramMap.get('token') ?? '';
    try {
      const { jwt, resourceType, resourceId } = await this.shareSession.activate(this.shareToken);
      const headers = new HttpHeaders({ Authorization: `Bearer ${jwt}` });

      if (resourceType === 'album') {
        const album = await firstValueFrom(
          this.http.get<any>(`/api/library/albums/${resourceId}`, { headers }),
        );
        this.resourceName.set(album.name);
        this.resourceSubtitle.set(album.artist);
        this.coverArtId.set(album.coverArt ?? null);
        this.tracks.set(
          (album.song ?? []).map((s: any) => ({
            id: s.id,
            title: s.title,
            artist: s.artist,
            duration: s.duration,
            coverArt: s.coverArt,
            track: s.track,
          })),
        );
        this.setOgTags(album.name, album.artist, jwt, album.coverArt, 'music.album');
      } else {
        const pl = await firstValueFrom(
          this.http.get<any>(`/api/playlists/${resourceId}`, { headers }),
        );
        this.resourceName.set(pl.name);
        this.resourceSubtitle.set(`by ${pl.owner}`);
        this.coverArtId.set(pl.coverArt ?? null);
        this.tracks.set(
          (pl.entry ?? []).map((s: any) => ({
            id: s.id,
            title: s.title,
            artist: s.artist,
            duration: s.duration,
            coverArt: s.coverArt,
            track: s.track,
          })),
        );
        this.setOgTags(pl.name, `${pl.entry?.length ?? pl.songCount} tracks`, jwt, pl.coverArt, 'music.playlist');
      }
      this.state.set('active');
    } catch (err: any) {
      this.state.set(err?.status === 410 ? 'expired' : 'error');
    }
  }

  ngOnDestroy(): void {
    this.audioRef()?.nativeElement.pause();
  }

  playTrack(index: number): void {
    this.currentIndex.set(index);
    this.isPlaying.set(false);
    setTimeout(() => {
      const audio = this.audioRef()?.nativeElement;
      if (!audio) return;
      audio.src = this.streamUrl() ?? '';
      audio.load();
      void audio.play().then(() => this.isPlaying.set(true)).catch(() => {});
    }, 0);
  }

  togglePlay(): void {
    const audio = this.audioRef()?.nativeElement;
    if (!audio) return;
    if (this.isPlaying()) {
      audio.pause();
      this.isPlaying.set(false);
    } else {
      if (!audio.src) audio.src = this.streamUrl() ?? '';
      void audio.play().then(() => this.isPlaying.set(true)).catch(() => {});
    }
  }

  prevTrack(): void {
    const idx = this.currentIndex();
    if (idx > 0) this.playTrack(idx - 1);
  }

  nextTrack(): void {
    const idx = this.currentIndex();
    if (idx < this.tracks().length - 1) this.playTrack(idx + 1);
  }

  onTimeUpdate(event: Event): void {
    this.currentTime.set((event.target as HTMLAudioElement).currentTime);
  }

  onDurationChange(event: Event): void {
    this.audioDuration.set((event.target as HTMLAudioElement).duration);
  }

  onEnded(): void {
    this.isPlaying.set(false);
    this.nextTrack();
  }

  onSeek(event: Event): void {
    const audio = this.audioRef()?.nativeElement;
    if (!audio) return;
    audio.currentTime = Number((event.target as HTMLInputElement).value);
  }

  formatTime(seconds: number): string {
    if (!seconds || isNaN(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  private setOgTags(title: string, description: string, jwt: string, coverArtId: string | undefined, type: string): void {
    this.titleService.setTitle(`${title} — NicotinD`);
    this.meta.updateTag({ property: 'og:title', content: title });
    this.meta.updateTag({ property: 'og:description', content: description });
    this.meta.updateTag({ property: 'og:type', content: type });
    if (coverArtId) {
      this.meta.updateTag({ property: 'og:image', content: `/api/cover/${coverArtId}?token=${jwt}` });
    }
  }
}
```

- [ ] **Step 2: Create the component HTML**

Create `packages/web/src/app/pages/share/share-view.component.html`:

```html
<!-- Loading -->
@if (state() === 'loading') {
  <div class="min-h-screen flex items-center justify-center bg-theme-bg">
    <span class="inline-block w-6 h-6 border-2 border-theme-secondary border-t-transparent rounded-full animate-spin"></span>
  </div>
}

<!-- Expired -->
@if (state() === 'expired' || state() === 'error') {
  <div class="min-h-screen flex flex-col items-center justify-center bg-theme-bg gap-4 text-center px-4">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
      class="text-theme-muted" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
    <p class="text-theme-primary font-semibold text-lg">
      @if (state() === 'expired') { This share link has expired. } @else { Share link not found. }
    </p>
    <p class="text-theme-muted text-sm">Share links are valid for 5 minutes after first open.</p>
    <a href="/login" class="mt-2 text-sm text-theme-secondary hover:text-theme-primary transition">
      Sign in to NicotinD →
    </a>
  </div>
}

<!-- Active -->
@if (state() === 'active') {
  <div class="min-h-screen bg-theme-bg pb-24">
    <div class="max-w-3xl mx-auto px-4 py-8">

      <!-- Header: cover + metadata -->
      <div class="flex flex-col sm:flex-row items-center sm:items-end gap-6 mb-8 text-center sm:text-left">
        @if (coverUrl()) {
          <img [src]="coverUrl()!" alt=""
            class="w-48 h-48 rounded-lg object-cover flex-shrink-0 shadow-xl" />
        } @else {
          <div class="w-48 h-48 rounded-lg bg-theme-surface-2 flex-shrink-0 shadow-xl flex items-center justify-center">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
              class="text-theme-muted opacity-40" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>
            </svg>
          </div>
        }
        <div>
          <h1 class="text-2xl font-bold text-theme-primary">{{ resourceName() }}</h1>
          <p class="text-theme-muted mt-1 text-sm">{{ resourceSubtitle() }}</p>
          <p class="text-theme-muted mt-1 text-xs">{{ tracks().length }} tracks</p>
        </div>
      </div>

      <!-- Track list -->
      <div class="divide-y divide-theme-border">
        @for (track of tracks(); track track.id; let i = $index) {
          <button
            (click)="playTrack(i)"
            [class]="'w-full flex items-center gap-3 px-2 py-3 rounded text-left transition '
              + (currentIndex() === i && isPlaying() ? 'bg-theme-surface-2 text-theme-primary' : 'hover:bg-theme-hover text-theme-secondary')">
            <span class="w-6 text-right text-xs text-theme-muted flex-shrink-0">
              @if (currentIndex() === i && isPlaying()) {
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" class="text-theme-secondary inline">
                  <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
                </svg>
              } @else {
                {{ track.track ?? i + 1 }}
              }
            </span>
            <span class="flex-1 min-w-0">
              <span class="block truncate text-sm font-medium text-theme-primary">{{ track.title }}</span>
              <span class="block truncate text-xs text-theme-muted">{{ track.artist }}</span>
            </span>
            <span class="text-xs text-theme-muted flex-shrink-0">{{ formatTime(track.duration ?? 0) }}</span>
          </button>
        }
      </div>

    </div>

    <!-- Footer -->
    <div class="text-center py-4 text-xs text-theme-muted">
      Shared via <a href="/login" class="hover:text-theme-secondary transition">NicotinD</a>
    </div>
  </div>

  <!-- Mini player (fixed bottom) -->
  @if (currentTrack()) {
    <div class="fixed bottom-0 left-0 right-0 bg-theme-surface border-t border-theme-border px-4 py-3 flex items-center gap-4 z-50">
      <audio #audioEl
        (timeupdate)="onTimeUpdate($event)"
        (durationchange)="onDurationChange($event)"
        (ended)="onEnded()">
      </audio>

      <!-- Track info -->
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium text-theme-primary truncate">{{ currentTrack()!.title }}</p>
        <p class="text-xs text-theme-muted truncate">{{ currentTrack()!.artist }}</p>
      </div>

      <!-- Controls -->
      <div class="flex items-center gap-2 flex-shrink-0">
        <button (click)="prevTrack()" title="Previous"
          class="p-1 text-theme-muted hover:text-theme-primary transition disabled:opacity-30"
          [disabled]="currentIndex() === 0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="19,20 9,12 19,4"/><rect x="5" y="4" width="2" height="16"/>
          </svg>
        </button>

        <button (click)="togglePlay()"
          class="w-9 h-9 rounded-full bg-theme-surface-2 flex items-center justify-center hover:bg-theme-hover transition text-theme-primary">
          @if (isPlaying()) {
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
            </svg>
          } @else {
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5,3 19,12 5,21"/>
            </svg>
          }
        </button>

        <button (click)="nextTrack()" title="Next"
          class="p-1 text-theme-muted hover:text-theme-primary transition disabled:opacity-30"
          [disabled]="currentIndex() === tracks().length - 1">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5,4 15,12 5,20"/><rect x="17" y="4" width="2" height="16"/>
          </svg>
        </button>
      </div>

      <!-- Seek bar -->
      <div class="flex items-center gap-2 flex-1 max-w-xs">
        <span class="text-xs text-theme-muted w-8 text-right">{{ formatTime(currentTime()) }}</span>
        <input type="range" min="0" [max]="audioDuration()" [value]="currentTime()" step="1"
          (input)="onSeek($event)"
          class="flex-1 h-1 accent-theme-secondary cursor-pointer" />
        <span class="text-xs text-theme-muted w-8">{{ formatTime(audioDuration()) }}</span>
      </div>
    </div>
  }
}
```

- [ ] **Step 3: Add the route to app.routes.ts**

In `packages/web/src/app/app.routes.ts`, add the share route at the top level (outside the auth-protected group), just before the `{ path: '**', redirectTo: '' }` catch-all:

```typescript
import { Routes } from '@angular/router';
import { authGuard, adminGuard } from './guards/auth.guard';

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./pages/login/login.component').then(m => m.LoginComponent) },
  { path: 'setup', loadComponent: () => import('./pages/setup/setup.component').then(m => m.SetupComponent) },
  { path: 'share/:token', loadComponent: () => import('./pages/share/share-view.component').then(m => m.ShareViewComponent) },
  {
    path: '',
    loadComponent: () => import('./components/layout/layout.component').then(m => m.LayoutComponent),
    canActivate: [authGuard],
    children: [
      { path: '', loadComponent: () => import('./pages/search/search.component').then(m => m.SearchComponent) },
      { path: 'downloads', loadComponent: () => import('./pages/downloads/downloads.component').then(m => m.DownloadsComponent) },
      { path: 'playlists', loadComponent: () => import('./pages/playlists/playlists.component').then(m => m.PlaylistsComponent) },
      { path: 'library', loadComponent: () => import('./pages/library/library.component').then(m => m.LibraryComponent) },
      { path: 'library/albums/:id', loadComponent: () => import('./pages/library/album-detail.component').then(m => m.AlbumDetailComponent) },
      { path: 'library/artists/:id', loadComponent: () => import('./pages/library/artist-detail.component').then(m => m.ArtistDetailComponent) },
      { path: 'library/genres/:slug', loadComponent: () => import('./pages/library/genre-detail.component').then(m => m.GenreDetailComponent) },
      { path: 'settings', loadComponent: () => import('./pages/settings/settings.component').then(m => m.SettingsComponent) },
      { path: 'admin', loadComponent: () => import('./pages/admin/admin.component').then(m => m.AdminComponent), canActivate: [adminGuard] },
    ],
  },
  { path: '**', redirectTo: '' },
];
```

- [ ] **Step 4: Verify type-check**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun run typecheck
```

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/app/pages/share/ packages/web/src/app/app.routes.ts
git commit -m "feat(share): add ShareViewComponent and /share/:token route"
```

---

## Task 7: Share button in AlbumDetailComponent

**Files:**
- Modify: `packages/web/src/app/pages/library/album-detail.component.ts`
- Modify: `packages/web/src/app/pages/library/album-detail.component.html`

- [ ] **Step 1: Add shareAlbum() and toast state to the TS**

In `packages/web/src/app/pages/library/album-detail.component.ts`:

Add `HttpClient` to the imports at the top:
```typescript
import { HttpClient } from '@angular/common/http';
```

Add `HttpClient` to the existing Angular core import line (it already uses `inject`). Then add these two lines near the other `inject()` calls at the top of the class body:

```typescript
  private http = inject(HttpClient);
  readonly shareCopied = signal(false);
```

Add this method at the end of the class:

```typescript
  shareAlbum(): void {
    const album = this.selectedAlbum();
    if (!album) return;
    this.http.post<{ url: string }>('/api/share', { resourceType: 'album', resourceId: album.id }).subscribe({
      next: ({ url }) => {
        navigator.clipboard.writeText(url).catch(() => {});
        this.shareCopied.set(true);
        setTimeout(() => this.shareCopied.set(false), 3000);
      },
    });
  }
```

- [ ] **Step 2: Add the Share button to the HTML**

In `packages/web/src/app/pages/library/album-detail.component.html`, locate the button group (the `<div class="flex justify-center sm:justify-start gap-3 mt-4">` containing "Play Album" and "Remove album"). Add the Share button after "Play Album":

```html
          <button (click)="shareAlbum()"
            class="px-4 py-2 rounded-lg text-sm transition"
            [class]="shareCopied()
              ? 'bg-emerald-500/20 text-emerald-400'
              : 'bg-theme-surface-2 text-theme-muted hover:bg-theme-hover'">
            @if (shareCopied()) { Link copied! } @else { Share }
          </button>
```

- [ ] **Step 3: Verify type-check**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun run typecheck
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/app/pages/library/album-detail.component.ts \
        packages/web/src/app/pages/library/album-detail.component.html
git commit -m "feat(share): add Share button to AlbumDetailComponent"
```

---

## Task 8: Share button in PlaylistsComponent

**Files:**
- Modify: `packages/web/src/app/pages/playlists/playlists.component.ts`
- Modify: `packages/web/src/app/pages/playlists/playlists.component.html`

- [ ] **Step 1: Add sharePlaylist() and toast state to the TS**

In `packages/web/src/app/pages/playlists/playlists.component.ts`:

Add `HttpClient` to the imports:
```typescript
import { HttpClient } from '@angular/common/http';
```

Add `HttpClient` inject and `shareCopied` signal near the other injects at the top of the class body:
```typescript
  private http = inject(HttpClient);
  readonly shareCopied = signal(false);
```

Add this method at the end of the class:

```typescript
  sharePlaylist(): void {
    const pl = this.selected();
    if (!pl) return;
    this.http.post<{ url: string }>('/api/share', { resourceType: 'playlist', resourceId: pl.id }).subscribe({
      next: ({ url }) => {
        navigator.clipboard.writeText(url).catch(() => {});
        this.shareCopied.set(true);
        setTimeout(() => this.shareCopied.set(false), 3000);
      },
    });
  }
```

- [ ] **Step 2: Add the Share button to the playlist detail HTML**

In `packages/web/src/app/pages/playlists/playlists.component.html`, locate the button group inside the detail view (`<div class="flex justify-center sm:justify-start gap-3 mt-4">`). Add the Share button after the "Play All" button:

```html
              <button (click)="sharePlaylist()"
                class="px-4 py-2 rounded-lg text-sm transition"
                [class]="shareCopied()
                  ? 'bg-emerald-500/20 text-emerald-400'
                  : 'bg-theme-surface-2 text-theme-muted hover:bg-theme-hover'">
                @if (shareCopied()) { Link copied! } @else { Share }
              </button>
```

- [ ] **Step 3: Verify type-check**

```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun run typecheck
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/app/pages/playlists/playlists.component.ts \
        packages/web/src/app/pages/playlists/playlists.component.html
git commit -m "feat(share): add Share button to PlaylistsComponent"
```

---

## Verification Checklist

Run all API tests to confirm nothing regressed:
```bash
cd /home/kevinch3/Documentos/Dev/NicotinD && bun test packages/api/src
```

Then manually verify end-to-end:

- [ ] Log in, open an album → click **Share** → toast shows "Link copied!" for 3s → URL is in clipboard
- [ ] Open in incognito: paste the URL → spinner → share page loads with cover art, track list, and audio playback
- [ ] Click a track row → mini player starts playing that track
- [ ] Click ▶/⏸, ◀, ▶ controls — playback responds correctly
- [ ] Wait 5 min after opening the incognito tab → next page action triggers 401/410 → page shows "This share link has expired"
- [ ] Open the same share URL again within the 5-min window → same `exp` in the new JWT (not extended)
- [ ] **Write-block:** in DevTools console run: `fetch('/api/playlists', { method: 'POST', headers: { Authorization: 'Bearer <shareJwt>', 'Content-Type': 'application/json' }, body: JSON.stringify({name:'x'}) }).then(r => r.json()).then(console.log)` → expect `{ error: 'Share sessions are read-only' }`
- [ ] Open a playlist → click **Share** → same flow works
