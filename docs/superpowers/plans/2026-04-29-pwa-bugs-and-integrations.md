# PWA Bugs & Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Android PWA queue stopping on screen lock; fix auto-playlist song ID resolution; add browser-accessible Docker log streaming; surface Tailscale auth URL and persist the auth key across deployments.

**Architecture:** Four independent areas — one Angular component fix, two backend service fixes, one new SSE API endpoint with frontend changes, and Tailscale state improvements across backend + frontend. No new packages. No DB schema changes.

**Tech Stack:** Angular 22 (signals, effects, `EventSource`), Hono (SSE via `streamSSE`), Bun (`child_process.spawn`), TypeScript, pino, Tailwind CSS.

---

## File Map

| File | What changes |
|------|-------------|
| `packages/web/src/app/components/player/player.component.ts` | Fix `onEnded`: handle preserved tracks directly; fix locked-screen error handling |
| `packages/api/src/services/auto-playlist.service.ts` | Accept `musicDir`, strip absolute prefix in path index + fallback match |
| `packages/api/src/services/download-watcher.ts` | Pass `musicDir` to `AutoPlaylistService` constructor |
| `packages/api/src/services/metadata-fixer.ts` | Elevate per-file errors from `debug` to `warn`; add start log to `reprocessLibrary` |
| `packages/api/src/routes/system.ts` | Add `GET /logs/:service/stream` SSE endpoint using Docker socket |
| `packages/web/src/app/pages/admin/admin.component.ts` | Replace polling `loadLogs()` with `EventSource` SSE; add nicotind/tailscale to service list |
| `packages/web/src/app/pages/admin/admin.component.html` | Wire up live log stream UI |
| `packages/api/src/services/tailscale.ts` | Surface `AuthURL` from daemon in `getStatus()` |
| `packages/api/src/routes/tailscale.ts` | Accept `saveTailscaleAuthKeyFn`; call it after successful connect |
| `packages/api/src/index.ts` | Thread `saveTailscaleAuthKeyFn` through `CreateAppOptions` |
| `src/main.ts` | Add `tailscaleAuthKey?` to `PersistedSecrets`; auto-reconnect on startup |
| `packages/web/src/app/pages/settings/settings.component.ts` | Add 5s polling while disconnected; stop on connect |
| `packages/web/src/app/pages/settings/settings.component.html` | Show `loginUrl` link; show access URL when connected |
| `docker-compose.yml` | Mount `/var/run/docker.sock:ro` into nicotind |

---

## Task 1: Fix PWA Queue Stopping on Android Screen Lock

**Files:**
- Modify: `packages/web/src/app/components/player/player.component.ts`

### Background

`onEnded` in PlayerComponent has two code paths for advancing the queue. For non-preserved (streaming) tracks it sets `audio.src` + calls `audio.play()` synchronously, keeping the Android audio session alive. For preserved (IndexedDB-cached) tracks it skips pre-loading and relies on Angular Effect 1 to fire after the signal updates.

When the screen is locked, Android throttles the page's microtask queue, so Effect 1 may not run in time. Additionally, if `audio.play()` fails with any error other than `NotAllowedError` (e.g. `AbortError` when the audio session is in flux at lock time), the error is silently swallowed and the queue stops.

- [ ] **Step 1: Add a `lastManualObjectUrl` property**

In `player.component.ts`, after the existing `private lastManualSrc: string | null = null;` declaration (around line 56), add:

```typescript
// Object URL created by onEnded for a preserved track; needs manual revocation.
private lastManualObjectUrl: string | null = null;
```

- [ ] **Step 2: Revoke the stale object URL in Effect 1**

Effect 1 starts at line 98. At the very beginning of the effect callback (before the `lastManualSrc` guard), add the object URL cleanup:

```typescript
effect((onCleanup) => {
  // Revoke any object URL we created in onEnded for a preserved track.
  const pendingObjectUrl = this.lastManualObjectUrl;
  this.lastManualObjectUrl = null;
  onCleanup(() => { if (pendingObjectUrl) URL.revokeObjectURL(pendingObjectUrl); });

  const track = this.player.currentTrack();
  // ... rest of Effect 1 unchanged
```

- [ ] **Step 3: Rewrite the `onEnded` handler**

The handler lives around line 372. Replace the entire `onEnded` function body with the version below. Key changes:
1. `lastManualSrc` is always set for the next track (not just non-preserved ones)
2. Preserved tracks are loaded asynchronously inside the handler, keeping the audio session alive just like streaming tracks
3. When `audio.play()` fails while the screen is locked, set `resumePendingAfterVisible = true` instead of showing the rejection banner (the user can't see or tap the banner from the lock screen)

```typescript
const onEnded = () => {
  const repeat = this.player.repeat();
  const token = this.auth.token();

  if (repeat === 'one') {
    audio.currentTime = 0;
    audio.play().catch((err) => {
      if (err.name === 'NotAllowedError') this.handlePlayRejection();
    });
  } else {
    const nextTrack = this.player.queue()[0];
    if (nextTrack) {
      this.lastManualSrc = nextTrack.id;
      const isPreserved = untracked(() => this.preserve.isPreserved(nextTrack.id));

      const playNext = () => {
        audio.play().catch((err) => {
          if (document.visibilityState === 'hidden') {
            // Screen is locked — can't show a banner; request resume on unlock instead.
            this.resumePendingAfterVisible = true;
          } else if (err.name === 'NotAllowedError') {
            this.handlePlayRejection();
          }
        });
      };

      if (isPreserved) {
        db.getBlob(nextTrack.id).then((blob) => {
          if (blob) {
            const url = URL.createObjectURL(blob.audio);
            this.lastManualObjectUrl = url;
            audio.src = url;
          } else {
            // Blob missing despite metadata — fall back to stream.
            audio.src = `/api/stream/${nextTrack.id}?token=${token}`;
          }
          playNext();
        });
      } else {
        audio.src = `/api/stream/${nextTrack.id}?token=${token}`;
        playNext();
      }
    }
  }

  this.player.playNext();
};
```

- [ ] **Step 4: Run the typecheck**

```bash
bun run typecheck
```

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/app/components/player/player.component.ts
git commit -m "fix(player): advance queue correctly when Android screen is locked

- Preserved tracks are now pre-loaded synchronously in onEnded (same as
  streaming tracks) so Angular Effect 1 isn't required to fire under a
  throttled background context.
- audio.play() failures while the screen is locked now set
  resumePendingAfterVisible rather than showing the unseen rejection banner.
- Track object URLs created in onEnded are properly tracked and revoked
  via Effect 1 cleanup."
```

---

## Task 2: Fix Auto-Playlist Song ID Resolution

**Files:**
- Modify: `packages/api/src/services/auto-playlist.service.ts`
- Modify: `packages/api/src/services/download-watcher.ts`

### Background

`buildPathIndex()` stores `normalizePath(song.path)` as map keys, where `song.path` is Navidrome's **absolute** path (e.g. `/data/music/Music/Artist/Album/Track.mp3`). After normalization this becomes `data/music/Music/Artist/Album/Track.mp3`. But `completed_downloads.relative_path` stores paths relative to the music root (e.g. `Music/Artist/Album/Track.mp3`). These never match. Every lookup misses → floods logs with "Could not resolve Navidrome song ID" for every track.

- [ ] **Step 1: Write a unit test for `normalizeSongPath`**

Create `packages/api/src/services/auto-playlist.service.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';

// Import the private helper by testing via the class.
// We'll extract it to a module-level function so it can be unit-tested.
import { normalizeSongPath } from './auto-playlist.service.js';

describe('normalizeSongPath', () => {
  it('strips the music dir prefix from an absolute Navidrome path', () => {
    expect(normalizeSongPath('/data/music', '/data/music/Music/Artist/Track.mp3'))
      .toBe('music/artist/track.mp3');
  });

  it('handles a trailing slash on musicDir', () => {
    expect(normalizeSongPath('/data/music/', '/data/music/Music/Track.mp3'))
      .toBe('music/track.mp3');
  });

  it('returns the normalized path unchanged when prefix is absent', () => {
    expect(normalizeSongPath('/data/music', 'relative/path/Track.mp3'))
      .toBe('relative/path/track.mp3');
  });

  it('normalizes backslashes', () => {
    expect(normalizeSongPath('/data/music', '/data/music/Music\\Artist\\Track.mp3'))
      .toBe('music/artist/track.mp3');
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd packages/api && bun test src/services/auto-playlist.service.test.ts
```

Expected: `Cannot find module './auto-playlist.service.js'` export `normalizeSongPath`.

- [ ] **Step 3: Extract and export `normalizeSongPath`, update `AutoPlaylistService`**

In `auto-playlist.service.ts`, after the existing `normalizePath` function (around line 14), add:

```typescript
/** Strips the music directory prefix from an absolute Navidrome song path. */
export function normalizeSongPath(musicDir: string, absolutePath: string): string {
  const prefix = normalizePath(musicDir).replace(/\/+$/, '') + '/';
  const normalized = normalizePath(absolutePath);
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}
```

Update the `AutoPlaylistService` class declaration (around line 55) to accept `musicDir`:

```typescript
export class AutoPlaylistService {
  constructor(
    private navidrome: Navidrome,
    private musicDir = '',
    private scanTimeoutMs = 30_000,
  ) {}
```

- [ ] **Step 4: Use `normalizeSongPath` in `buildPathIndex`**

In `buildPathIndex` (around line 253), change the line that builds the path index key from:

```typescript
pathIndex.set(normalizePath(song.path), song.id);
```

to:

```typescript
pathIndex.set(normalizeSongPath(this.musicDir, song.path), song.id);
```

- [ ] **Step 5: Use `normalizeSongPath` in the fallback path match inside `resolveSongId`**

In `resolveSongId` (around line 200), change the `pathMatch` finder from:

```typescript
const pathMatch = results.song.find(
  (song) => normalizePath(song.path) === relativePath,
);
```

to:

```typescript
const pathMatch = results.song.find(
  (song) => normalizeSongPath(this.musicDir, song.path) === relativePath,
);
```

- [ ] **Step 6: Run tests to confirm they pass**

```bash
cd packages/api && bun test src/services/auto-playlist.service.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 7: Pass `musicDir` from `DownloadWatcher`**

In `download-watcher.ts` (line 52), change:

```typescript
this.autoPlaylist = options.autoPlaylist ?? new AutoPlaylistService(navidrome);
```

to:

```typescript
this.autoPlaylist =
  options.autoPlaylist ??
  new AutoPlaylistService(navidrome, options.musicDir ?? '');
```

- [ ] **Step 8: Typecheck**

```bash
bun run typecheck
```

Expected: 0 errors.

- [ ] **Step 9: Commit**

```bash
git add packages/api/src/services/auto-playlist.service.ts \
        packages/api/src/services/auto-playlist.service.test.ts \
        packages/api/src/services/download-watcher.ts
git commit -m "fix(auto-playlist): strip Navidrome absolute path prefix when resolving song IDs

Navidrome returns absolute song paths (/data/music/...) but completed_downloads
stores paths relative to the music root. normalizeSongPath() strips the prefix
so path index lookups match correctly and 'Could not resolve Navidrome song ID'
warnings disappear for normal downloads."
```

---

## Task 3: Elevate Metadata Fixer Logging

**Files:**
- Modify: `packages/api/src/services/metadata-fixer.ts`

- [ ] **Step 1: Add a start log to `reprocessLibrary`**

In `packages/api/src/services/metadata-fixer.ts`, line 259 currently reads:

```typescript
stats.total = files.length;
```

Insert a `log.info` call immediately after it:

```typescript
stats.total = files.length;
log.info({ total: files.length }, 'Starting library metadata reprocess');
```

- [ ] **Step 2: Elevate the per-file error from `debug` to `warn`**

Line 268 currently reads:

```typescript
log.debug({ err, filePath }, 'Error reprocessing file');
```

Change it to:

```typescript
log.warn({ err, filePath }, 'Error reprocessing file');
```

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/services/metadata-fixer.ts
git commit -m "fix(metadata-fixer): elevate per-file errors to warn and log reprocess start"
```

---

## Task 4: Docker Socket Mount + SSE Log Streaming Endpoint

**Files:**
- Modify: `docker-compose.yml`
- Modify: `packages/api/src/routes/system.ts`

- [ ] **Step 1: Add Docker socket mount to `docker-compose.yml`**

In `docker-compose.yml`, under `nicotind.volumes`, add:

```yaml
nicotind:
  volumes:
    - nicotind-data:/data/nicotind
    - music:/data/music
    - tailscale-sock:/var/run/tailscale
    - /var/run/docker.sock:/var/run/docker.sock:ro   # ← add this line
```

- [ ] **Step 2: Add the SSE streaming endpoint to `system.ts`**

In `packages/api/src/routes/system.ts`, add the import for `streamSSE` and `spawn` at the top:

```typescript
import { streamSSE } from 'hono/streaming';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
```

Then add the new route just before `return app;`:

```typescript
// GET /api/system/logs/:service/stream  — SSE, admin only
// Streams Docker container logs when the Docker socket is available.
app.get('/logs/:service/stream', async (c) => {
  const user = (c as unknown as { get(k: 'user'): { role: string } }).get('user');
  if (user.role !== 'admin') {
    return c.json({ error: 'Admin only' }, 403);
  }

  const service = c.req.param('service');
  const DOCKER_SOCK = '/var/run/docker.sock';

  if (!existsSync(DOCKER_SOCK)) {
    return c.json({ error: 'Docker socket not available' }, 503);
  }

  // Find container name by compose service label.
  const findProc = spawn('docker', [
    'ps',
    '--filter', `label=com.docker.compose.service=${service}`,
    '--format', '{{.Names}}',
  ]);

  const containerName = await new Promise<string>((resolve, reject) => {
    let out = '';
    findProc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    findProc.on('close', (code) => {
      const name = out.trim().split('\n')[0]?.trim();
      if (code !== 0 || !name) reject(new Error(`No container for service: ${service}`));
      else resolve(name);
    });
  }).catch(() => null);

  if (!containerName) {
    return c.json({ error: `No running container for service: ${service}` }, 404);
  }

  return streamSSE(c, async (stream) => {
    const logProc = spawn('docker', ['logs', '--follow', '--tail=200', containerName], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const sendLine = async (line: string) => {
      if (line.trim()) {
        await stream.writeSSE({ data: line });
      }
    };

    const handleData = async (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        await sendLine(line);
      }
    };

    logProc.stdout.on('data', handleData);
    logProc.stderr.on('data', handleData);

    await new Promise<void>((resolve) => {
      logProc.on('close', resolve);
      stream.onAbort(() => { logProc.kill(); resolve(); });
    });
  });
});
```

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml packages/api/src/routes/system.ts
git commit -m "feat(system): add SSE Docker log streaming endpoint

GET /api/system/logs/:service/stream streams docker logs --follow for any
compose service when /var/run/docker.sock is mounted. docker-compose.yml
mounts the socket read-only into the nicotind container."
```

---

## Task 5: Admin UI — Live Log Stream via EventSource

**Files:**
- Modify: `packages/web/src/app/pages/admin/admin.component.ts`
- Modify: `packages/web/src/app/pages/admin/admin.component.html`

- [ ] **Step 1: Update `AdminComponent` to use EventSource**

In `admin.component.ts`, update the imports line to add `OnDestroy`:

```typescript
import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
```

Change the class declaration:

```typescript
export class AdminComponent implements OnInit, OnDestroy {
```

Update the `services` array and `logService` type to include all four containers:

```typescript
readonly services: ('slskd' | 'navidrome' | 'nicotind' | 'tailscale')[] =
  ['slskd', 'navidrome', 'nicotind', 'tailscale'];

readonly logService = signal<'slskd' | 'navidrome' | 'nicotind' | 'tailscale'>('slskd');
```

Add a private property for the EventSource (place it near the other private fields):

```typescript
private logEventSource: EventSource | null = null;
```

Replace the existing `loadLogs` method with a streaming version:

```typescript
loadLogs(service: 'slskd' | 'navidrome' | 'nicotind' | 'tailscale'): void {
  // Close any existing stream.
  this.logEventSource?.close();
  this.logEventSource = null;

  this.logService.set(service);
  this.logs.set([]);
  this.logHint.set(null);
  this.logsLoading.set(true);
  this.logsLoaded.set(false);

  const token = this.auth.token();
  const url = `/api/system/logs/${service}/stream?token=${token ?? ''}`;
  const es = new EventSource(url);
  this.logEventSource = es;

  es.onopen = () => {
    this.logsLoading.set(false);
    this.logsLoaded.set(true);
  };

  es.onmessage = (event: MessageEvent) => {
    this.logs.update((prev) => {
      const next = [...prev, event.data as string];
      // Keep at most 500 lines to avoid unbounded memory growth.
      return next.length > 500 ? next.slice(next.length - 500) : next;
    });
  };

  es.onerror = () => {
    this.logHint.set('Log stream disconnected.');
    this.logsLoading.set(false);
    this.logsLoaded.set(true);
    es.close();
  };
}
```

Add `ngOnDestroy` to clean up the stream:

```typescript
ngOnDestroy(): void {
  this.logEventSource?.close();
}
```

Note: the `authInterceptor` does not apply to `EventSource` (it only intercepts `HttpClient`). The token is passed as a query parameter — the same pattern used by `/api/stream/:id?token=...`. The `auth` middleware in Hono already accepts the token via `?token=` for streaming endpoints; verify this is the case for `/api/system/logs/*` by checking that `app.use('/api/system/*', auth)` is wired in `index.ts` (it is — line 136).

- [ ] **Step 2: Update the logs section in `admin.component.html`**

Find the logs section (search for `logService` or `logsLoaded`). Replace or update it to show the service selector for all four services and use a live-scroll log view:

```html
<!-- Service Logs -->
<div>
  <h2 class="text-lg font-semibold text-zinc-100 mb-4">Service Logs</h2>
  <div class="flex gap-2 mb-3 flex-wrap">
    @for (svc of services; track svc) {
      <button
        (click)="loadLogs(svc)"
        [class]="'px-3 py-1.5 rounded-lg text-xs font-medium transition ' +
          (logService() === svc && logsLoaded()
            ? 'bg-zinc-100 text-zinc-900'
            : 'border border-zinc-700 text-zinc-400 hover:border-zinc-500')"
      >
        {{ svc }}
      </button>
    }
  </div>

  @if (logsLoading()) {
    <p class="text-zinc-500 text-sm">Connecting to log stream...</p>
  }

  @if (logsLoaded()) {
    @if (logHint()) {
      <div class="px-4 py-2.5 rounded-lg text-sm bg-zinc-900 border border-zinc-700 text-zinc-500 mb-3">
        {{ logHint() }}
      </div>
    }
    <pre class="bg-zinc-950 border border-zinc-800 rounded-xl p-4 text-xs text-zinc-300 font-mono overflow-auto max-h-96 whitespace-pre-wrap break-all">{{ logs().join('\n') || '(no output yet)' }}</pre>
  }
</div>
```

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/app/pages/admin/admin.component.ts \
        packages/web/src/app/pages/admin/admin.component.html
git commit -m "feat(admin): live Docker log streaming via EventSource SSE

Replaces the polling-based log snapshot with a real-time stream using the
new /api/system/logs/:service/stream SSE endpoint. All four containers
(slskd, navidrome, nicotind, tailscale) are available. Buffer capped at
500 lines to avoid memory growth."
```

---

## Task 6: Surface Tailscale Auth URL in `getStatus()` and Settings UI

**Files:**
- Modify: `packages/api/src/services/tailscale.ts`
- Modify: `packages/web/src/app/pages/settings/settings.component.ts`
- Modify: `packages/web/src/app/pages/settings/settings.component.html`

### Background

When Tailscale's daemon needs authentication it populates `AuthURL` in the `/localapi/v0/status` response. The current `getStatus()` ignores this field. Also, when connected, the user needs to know the Tailscale IP/hostname to reach NicotinD remotely.

- [ ] **Step 1: Surface `loginUrl` from the Tailscale daemon status**

In `tailscale.ts`, in the `getStatus()` method, update the return value inside the `try` block:

```typescript
const connected = status.BackendState === 'Running';

return {
  available: true,
  connected,
  hostname: selfNode?.DNSName?.replace(/\.$/, ''),
  ip: selfNode?.TailscaleIPs?.[0],
  // AuthURL is populated by the daemon when it needs interactive login.
  loginUrl: !connected ? (status.AuthURL as string | undefined) ?? undefined : undefined,
};
```

- [ ] **Step 2: Add polling to `settings.component.ts`**

In the imports at the top:

```typescript
import { firstValueFrom, interval, Subscription } from 'rxjs';
import { switchMap, takeWhile } from 'rxjs/operators';
```

(These are already imported — verify they are present.)

Add a `private tsPolling: Subscription | null = null;` property near the other private fields:

```typescript
private tsPolling: Subscription | null = null;
```

Add a `startTsPolling()` method and call it from `loadTailscaleStatus()`:

```typescript
private startTsPolling(): void {
  this.tsPolling?.unsubscribe();
  this.tsPolling = interval(5000)
    .pipe(
      switchMap(() => this.api.getTailscaleStatus()),
      takeWhile((s) => !s.connected, true), // emit the first connected status then stop
    )
    .subscribe({
      next: (status) => {
        this.tsStatus.set(status);
        if (status.connected) {
          this.tsPolling?.unsubscribe();
          this.tsPolling = null;
        }
      },
      error: () => { /* ignore poll errors */ },
    });
}

private async loadTailscaleStatus(): Promise<void> {
  try {
    const status = await firstValueFrom(this.api.getTailscaleStatus());
    this.tsStatus.set(status);
    if (!status.connected) this.startTsPolling();
  } catch { /* ignore */ }
}
```

Stop polling in `ngOnDestroy` (add the interface and override, or append to existing destroy logic):

```typescript
ngOnDestroy(): void {
  this.tsPolling?.unsubscribe();
}
```

Also stop polling when the user successfully connects in `connectTailscale()`. After `this.tsStatus.set(status);`, add:

```typescript
if (status.connected) {
  this.tsPolling?.unsubscribe();
  this.tsPolling = null;
}
```

- [ ] **Step 3: Update the Tailscale section in `settings.component.html`**

Find the existing connected block (around line 155). Add the NicotinD access URL when connected (after the IP row):

```html
@if (tsStatus()!.ip) {
  <div>
    <span class="text-xs text-theme-muted">NicotinD via Tailscale: </span>
    <a
      [href]="'http://' + tsStatus()!.ip + ':8484'"
      target="_blank"
      rel="noopener noreferrer"
      class="text-sm text-emerald-400 font-mono hover:underline"
    >http://{{ tsStatus()!.ip }}:8484</a>
  </div>
}
```

Find the not-connected auth key input block (around line 179). Add a `loginUrl` banner above the auth key input, inside the `@else` block for `!connected`:

```html
@if (tsStatus()!.loginUrl) {
  <div class="px-4 py-3 rounded-lg bg-amber-950/40 border border-amber-900/50 mb-4">
    <p class="text-xs text-amber-400 mb-2 font-medium">Tailscale requires authentication</p>
    <a
      [href]="tsStatus()!.loginUrl"
      target="_blank"
      rel="noopener noreferrer"
      class="text-sm text-amber-300 break-all hover:underline"
    >{{ tsStatus()!.loginUrl }}</a>
    <p class="text-xs text-amber-500/70 mt-2">Open the link above to authenticate. This page will update automatically.</p>
  </div>
}
<!-- existing auth key input stays here unchanged -->
```

- [ ] **Step 4: Typecheck**

```bash
bun run typecheck
```

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/services/tailscale.ts \
        packages/web/src/app/pages/settings/settings.component.ts \
        packages/web/src/app/pages/settings/settings.component.html
git commit -m "feat(tailscale): surface auth URL and access link in settings UI

getStatus() now returns the daemon's AuthURL as loginUrl when NeedsLogin.
Settings page polls every 5s until connected, shows a clickable login link
when auth is required, and shows the NicotinD-over-Tailscale URL when connected."
```

---

## Task 7: Persist Tailscale Auth Key + Auto-Reconnect on Startup

**Files:**
- Modify: `src/main.ts`
- Modify: `packages/api/src/index.ts`
- Modify: `packages/api/src/routes/tailscale.ts`

### Background

The `PersistedSecrets` interface in `src/main.ts` holds slskd/navidrome credentials between restarts. Adding `tailscaleAuthKey` lets NicotinD re-authenticate Tailscale when the state volume is lost (e.g. full volume wipe, fresh host). If the state volume is intact, `getStatus()` already returns `connected: true` and the auto-reconnect is skipped.

- [ ] **Step 1: Add `tailscaleAuthKey` to `PersistedSecrets`**

In `src/main.ts`, find the `PersistedSecrets` interface (around line 136) and add the new optional field:

```typescript
export interface PersistedSecrets {
  slskdPassword: string;
  navidromePassword: string;
  jwtSecret: string;
  soulseekUsername?: string;
  soulseekPassword?: string;
  soulseekListeningPort?: number;
  soulseekEnableUPnP?: boolean;
  tailscaleAuthKey?: string;   // ← add this line
}
```

- [ ] **Step 2: Add `saveTailscaleAuthKeyFn` to `CreateAppOptions`**

In `packages/api/src/index.ts`, find the `CreateAppOptions` interface (around line 39) and add:

```typescript
export interface CreateAppOptions {
  config: NicotinDConfig;
  slskdRef: SlskdRef;
  navidrome: Navidrome;
  serviceManager: ServiceManager;
  webDistPath?: string;
  saveSecretsFn?: (username: string, password: string) => void;
  saveTailscaleAuthKeyFn?: (key: string) => void;   // ← add this line
}
```

Thread it through to `tailscaleRoutes` — find where `tailscaleRoutes` is called (around line 162):

```typescript
app.route('/api/tailscale', tailscaleRoutes(tailscale, options.saveTailscaleAuthKeyFn));
```

- [ ] **Step 3: Accept and use the callback in `tailscale.ts` routes**

In `packages/api/src/routes/tailscale.ts`, update the function signature:

```typescript
export function tailscaleRoutes(
  tailscale: TailscaleService,
  saveAuthKeyFn?: (key: string) => void,
) {
```

In the `POST /connect` handler, after `return c.json(status);` succeeds, call the callback:

```typescript
try {
  const status = await tailscale.connect(authKey.trim());
  saveAuthKeyFn?.(authKey.trim());   // ← add this line
  return c.json(status);
} catch (err) {
```

- [ ] **Step 4: Wire `saveTailscaleAuthKeyFn` in `src/main.ts`**

In `main()` (around line 96 where `createApp` is called), add the new callback:

```typescript
const { app, watcherRef, websocket } = createApp({
  config,
  slskdRef,
  navidrome,
  serviceManager,
  webDistPath,
  saveSecretsFn: (username: string, password: string) => {
    const secrets = loadOrCreateSecrets(config.dataDir);
    secrets.soulseekUsername = username;
    secrets.soulseekPassword = password;
    saveSecrets(config.dataDir, secrets);
  },
  saveTailscaleAuthKeyFn: (key: string) => {   // ← add this block
    const secrets = loadOrCreateSecrets(config.dataDir);
    secrets.tailscaleAuthKey = key;
    saveSecrets(config.dataDir, secrets);
  },
});
```

- [ ] **Step 5: Add `tailscaleAuthKey` to `CreateAppOptions` and wire auto-reconnect in `index.ts`**

First, add the field to `CreateAppOptions` in `packages/api/src/index.ts` (you already updated this interface in Step 2 — add the second field now):

```typescript
export interface CreateAppOptions {
  config: NicotinDConfig;
  slskdRef: SlskdRef;
  navidrome: Navidrome;
  serviceManager: ServiceManager;
  webDistPath?: string;
  saveSecretsFn?: (username: string, password: string) => void;
  saveTailscaleAuthKeyFn?: (key: string) => void;
  tailscaleAuthKey?: string;   // ← add: stored key for startup auto-reconnect
}
```

In the `createApp` function signature, destructure `tailscaleAuthKey`:

```typescript
export function createApp({
  config,
  slskdRef,
  navidrome,
  serviceManager,
  webDistPath,
  saveSecretsFn,
  saveTailscaleAuthKeyFn,
  tailscaleAuthKey,
}: CreateAppOptions) {
```

After the `const tailscale = new TailscaleService();` line (around line 108 after your Step 6 logger addition), add the auto-reconnect block:

```typescript
const tailscale = new TailscaleService();

if (tailscaleAuthKey) {
  tailscale.getStatus().then((status) => {
    if (status.available && !status.connected) {
      log.info('Tailscale not connected — attempting auto-reconnect with stored key');
      return tailscale.connect(tailscaleAuthKey);
    }
  }).catch((err) => {
    log.warn({ err }, 'Tailscale auto-reconnect failed — re-authentication will be needed');
  });
}
```

Then in `src/main.ts`, add `tailscaleAuthKey` to the `createApp` call:

```typescript
const { app, watcherRef, websocket } = createApp({
  config,
  slskdRef,
  navidrome,
  serviceManager,
  webDistPath,
  saveSecretsFn: (username: string, password: string) => {
    const secrets = loadOrCreateSecrets(config.dataDir);
    secrets.soulseekUsername = username;
    secrets.soulseekPassword = password;
    saveSecrets(config.dataDir, secrets);
  },
  saveTailscaleAuthKeyFn: (key: string) => {
    const secrets = loadOrCreateSecrets(config.dataDir);
    secrets.tailscaleAuthKey = key;
    saveSecrets(config.dataDir, secrets);
  },
  tailscaleAuthKey: loadOrCreateSecrets(config.dataDir).tailscaleAuthKey,
});
```

- [ ] **Step 6: Add a logger to `index.ts`**

`index.ts` does not currently import `createLogger`. Add it at the top of the file (after the existing `@nicotind/core` import block, or add to it):

```typescript
import { createLogger } from '@nicotind/core';
```

Near the top of the `createApp` function body, add:

```typescript
const log = createLogger('api');
```

- [ ] **Step 7: Typecheck**

```bash
bun run typecheck
```

Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add src/main.ts \
        packages/api/src/index.ts \
        packages/api/src/routes/tailscale.ts
git commit -m "feat(tailscale): persist auth key and auto-reconnect on startup

On successful connect via the settings UI, the auth key is saved to
secrets.json. On NicotinD startup, if the Tailscale socket is available
but the daemon is not in Running state, the stored key is used to
reconnect automatically — no user action needed after volume loss."
```

---

## Verification Checklist

- [ ] **PWA queue**: Build the web PWA (`cd packages/web && ng build`), serve it, open on Android Chrome, start a 5-track queue, lock the screen. All tracks play through without stopping.
- [ ] **Auto-playlist**: Run a download batch, wait for the Navidrome scan. Check `docker compose logs nicotind-1` — should show `Auto-playlist updated` instead of "Could not resolve Navidrome song ID" spam.
- [ ] **Docker logs**: Open Admin → Logs in the browser, select `navidrome` — live container output streams in real time. Select `nicotind` — NicotinD's own logs stream.
- [ ] **Tailscale auth URL**: If Tailscale needs login (`NeedsLogin` state), Settings shows the auth URL link and polls every 5s. After completing auth, the connected state appears without a page refresh.
- [ ] **Tailscale persistence**: `docker compose down && docker compose up`. NicotinD logs show "attempting auto-reconnect" if daemon isn't running. Settings shows the connected hostname/IP without re-entering the key.
- [ ] **Full typecheck**: `bun run typecheck` exits 0 on the final state.
