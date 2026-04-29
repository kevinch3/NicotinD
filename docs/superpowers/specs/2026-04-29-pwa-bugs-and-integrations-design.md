# Design: PWA Background Playback, Auto-Playlist Path Fix, Docker Logs, Tailscale UI

**Date:** 2026-04-29  
**Status:** Approved

---

## Context

Four distinct issues reported by the user after regular usage of NicotinD on Android Chrome PWA and Docker Compose:

1. **PWA queue stops after 1–2 tracks when the device screen is locked** — playback audio session is active but the queue doesn't advance past the second or third track.
2. **Auto-playlist always fails to resolve Navidrome song IDs** — logs are flooded with "Could not resolve Navidrome song ID, skipping" warnings for every track in a download batch.
3. **No way to view service logs from the browser** — the admin log viewer says "managed externally" for all containers; users must shell into Docker to diagnose failures.
4. **Tailscale auth URL is only visible in Docker logs** and **auth state is lost on every deployment** — forces manual re-authentication after each `docker-compose up`.

The player bar expand/collapse redesign mentioned by the user was explicitly deferred.

---

## Item 1: PWA Background Playback Bug

### Root Cause

`onEnded` handler in `player.component.ts` has two code paths:

- **Non-preserved (streaming) tracks**: sets `audio.src` + calls `audio.play()` synchronously inside the event handler — this works because Chrome treats it as session continuation.
- **Preserved (IndexedDB-cached) tracks**: skips pre-loading; calls `player.playNext()` to update the signal and relies on Effect 1 (Angular `effect()`) to load the blob.

When the Android screen locks, Chrome throttles JavaScript microtask processing. Effect 1 may not fire in time (it is scheduled as a microtask after signal mutation). If the next track happens to be preserved, the audio session ends with silence and Chrome sees no new `play()` activity — the session expires and subsequent `ended` events no longer trigger a new audio session.

Additionally, for both paths, if `audio.play()` throws anything other than `NotAllowedError` (e.g. `AbortError` during audio session flux at lock time), the error is silently swallowed. The `handlePlayRejection()` banner is shown to no one — the user is on the lock screen.

### Fix

**File:** `packages/web/src/app/components/player/player.component.ts`

1. **In `onEnded`, handle preserved tracks directly** — do not branch on `preserve.isPreserved()`. Always set `audio.src` from either a blob URL (IndexedDB) or the stream URL:

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
      if (isPreserved) {
        db.getBlob(nextTrack.id).then((blob) => {
          if (blob) {
            audio.src = URL.createObjectURL(blob.audio);
          } else {
            audio.src = `/api/stream/${nextTrack.id}?token=${token}`;
          }
          audio.play().catch(() => {
            if (document.visibilityState === 'hidden') {
              this.resumePendingAfterVisible = true;
            } else {
              this.handlePlayRejection();
            }
          });
        });
      } else {
        audio.src = `/api/stream/${nextTrack.id}?token=${token}`;
        audio.play().catch((err) => {
          if (document.visibilityState === 'hidden') {
            this.resumePendingAfterVisible = true;
          } else if (err.name === 'NotAllowedError') {
            this.handlePlayRejection();
          }
        });
      }
    }
  }
  this.player.playNext();
};
```

2. **Change error handling for `play()` failures**: when screen is locked (`visibilityState === 'hidden'`), always set `resumePendingAfterVisible = true` instead of showing the rejection banner (the user can't see or interact with it). The existing `visibilitychange` handler already handles resuming on unlock.

### What is NOT changed

Effect 1 still handles direct `playNext()` calls (from Media Session `nexttrack` on the lock screen, user-initiated skips), which is the correct path for those. The `lastManualSrc` guard already prevents double-loading.

---

## Item 2: Auto-Playlist Song ID Resolution Fix

### Root Cause

`AutoPlaylistService.buildPathIndex()` stores `normalizePath(song.path)` as the map key, where `song.path` is Navidrome's **absolute** file path (e.g. `/data/music/Music/Artist/Album/Track.mp3`). After `normalizePath`, this becomes `data/music/Music/Artist/Album/Track.mp3`.

Meanwhile, `completed_downloads.relative_path` stores the path **relative to the music dir** (e.g. `Music/Artist/Album/Track.mp3`), which normalizes to `Music/Artist/Album/Track.mp3`.

These never match. The path index lookup always misses. The fallback text-search by filename basename also frequently fails because Navidrome's `search3` searches by song *title*, not filename — track filenames like `01 - American Woman.mp3` rarely match the indexed title `American Woman`.

### Fix

**File:** `packages/api/src/services/auto-playlist.service.ts`

1. Accept `musicDir: string` as a constructor parameter.
2. In `buildPathIndex`, strip the music dir prefix (normalized) from `song.path` before using as key:

```typescript
private normalizeSongPath(absolutePath: string): string {
  const prefix = normalizePath(this.musicDir) + '/';
  const normalized = normalizePath(absolutePath);
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}
```

3. Apply the same normalization in the fallback `resolveSongId` path match.

**File:** `packages/api/src/services/download-watcher.ts` (or wherever `AutoPlaylistService` is instantiated)

Pass `config.musicDir` to the constructor.

### Expected outcome

Path index lookup will succeed for all tracks where `relative_path` is stored in `completed_downloads`. This covers the normal Backstreet Boys / Lenny Kravitz type case from the logs. The text-search fallback remains for the edge case where `relative_path` is absent.

### Better Logging

- Elevate the metadata-fixer reprocess per-file errors from `debug` to `warn` so they appear in `docker compose logs` by default.
- Log a start/finish summary for `reprocessLibrary` (current stats log at end is fine; add a `log.info` at start with file count).

---

## Item 3: Browser-Accessible Docker Logs

### Approach

Mount the Docker socket read-only into the `nicotind` container. The backend streams `docker logs --follow` output as an SSE (Server-Sent Events) endpoint. The admin UI connects via `EventSource` and shows live, scrolling logs.

### Infrastructure Change

**File:** `docker-compose.yml`

```yaml
nicotind:
  volumes:
    - ...existing...
    - /var/run/docker.sock:/var/run/docker.sock:ro
```

### API Change

**File:** `packages/api/src/routes/system.ts`

Add `GET /api/system/logs/:service/stream` (admin-only, SSE):

1. If Docker socket is not available, fall through to the existing non-streaming endpoint.
2. Run `docker ps --filter "label=com.docker.compose.service=<service>" --format "{{.Names}}"` to find the container name.
3. Spawn `docker logs --follow --tail=200 <container-name>` as a child process (stdout + stderr merged).
4. Stream each line as an SSE event: `data: <line>\n\n`.
5. Kill the child process when the client disconnects.

Service name mapping (compose service label → route param):
- `slskd` → `slskd`
- `navidrome` → `navidrome`
- `tailscale` → `tailscale`
- `nicotind` (NicotinD's own logs, via pino to stdout) → `nicotind`

For `nicotind` specifically: stream NicotinD's own container logs the same way (NicotinD logs to stdout already via pino).

### Frontend Change

**File:** `packages/web/src/app/pages/admin/admin.component.ts`

Replace the existing polling-based `getServiceLogs()` call with an `EventSource` connection to `/api/system/logs/:service/stream?token=...`. Append each received line to the log buffer. Auto-scroll to bottom. Show a "reconnecting..." indicator on disconnect.

The `logHint` signal ("managed externally") is replaced with a working live stream for all Docker Compose services.

### Security Note

The Docker socket has root-equivalent access on the host. Mounting it read-only limits it to read-only Docker API operations. The endpoint is behind the existing admin `authMiddleware` so only authenticated admin users can access it. This is the standard pattern used by Portainer, Dozzle, and similar tools.

---

## Item 4: Tailscale Auth URL + Auth Key Persistence

### Problem A: Auth URL not visible in UI

`TailscaleService.getStatus()` reads `BackendState` and `Self.DNSName` but ignores `AuthURL` — the field the Tailscale daemon populates when `BackendState === 'NeedsLogin'`. Users must `docker logs tailscale-1` to find the login URL.

### Fix A

**File:** `packages/api/src/services/tailscale.ts`

In `getStatus()`, extract `status.AuthURL` and surface it as `loginUrl`:

```typescript
return {
  available: true,
  connected,
  hostname: selfNode?.DNSName?.replace(/\.$/, ''),
  ip: selfNode?.TailscaleIPs?.[0],
  loginUrl: !connected ? (status.AuthURL ?? undefined) : undefined,
};
```

**File:** `packages/web/src/app/pages/settings/settings.component.html`

When `status.loginUrl` is present, show a prominent link and QR-less instruction:

```
⚠ Tailscale needs authentication.
Open this URL to connect: [link opens in new tab]
```

Add a 5-second polling interval in the Settings component while `!connected` — stops once connected.

### Problem B: Auth state lost on every deployment

The `tailscale-state` Docker volume persists the daemon's WireGuard keys and node identity across `docker-compose down && up`. The daemon should NOT need a new auth key unless the volume is deleted or the node registration expires (Tailscale ephemeral nodes expire after ~30 days of inactivity; regular nodes do not expire).

The issue is NicotinD has no way to auto-reconnect when the state volume IS lost (volume pruned, fresh host). Currently users must manually re-enter the auth key in Settings each time.

### Fix B

Store the auth key in `secrets.json` (alongside `soulseek` and `navidrome` credentials). On NicotinD startup, if the Tailscale socket is available and `BackendState !== 'Running'`, attempt `connect(storedAuthKey)`.

**File:** `src/main.ts` (or `packages/api/src/index.ts`)

After the Tailscale service is initialized, add:

```typescript
const tsStatus = await tailscale.getStatus();
if (tsStatus.available && !tsStatus.connected && secrets.tailscale?.authKey) {
  log.info('Tailscale not connected — attempting auto-reconnect with stored key');
  await tailscale.connect(secrets.tailscale.authKey).catch((err) => {
    log.warn({ err }, 'Tailscale auto-reconnect failed');
  });
}
```

**File:** `packages/api/src/routes/tailscale.ts`

In `POST /api/tailscale/connect`, after a successful `connect()`, write the auth key back to secrets (via `saveSecretsFn`) so it persists for future startups.

### Connected state display

When `connected`, Settings shows:
- Tailscale hostname (e.g. `nicotind.tail1234.ts.net`)
- Tailscale IP (e.g. `100.70.14.42`)
- NicotinD URL via Tailscale: `http://100.70.14.42:8484`

This is what the user needs to access the service remotely — currently they have to dig it out of Docker logs.

---

## Files to Create / Modify

| File | Change |
|------|--------|
| `packages/web/src/app/components/player/player.component.ts` | Fix `onEnded` handler for preserved tracks + locked-screen play() error handling |
| `packages/api/src/services/auto-playlist.service.ts` | Accept `musicDir`, strip prefix in path index + fallback match |
| `packages/api/src/services/download-watcher.ts` | Pass `config.musicDir` to `AutoPlaylistService` |
| `packages/api/src/services/metadata-fixer.ts` | Elevate per-file errors from `debug` to `warn`; add start log to `reprocessLibrary` |
| `packages/api/src/routes/system.ts` | Add SSE endpoint `/api/system/logs/:service/stream` |
| `packages/web/src/app/pages/admin/admin.component.ts` | Switch from polling to SSE for log display |
| `packages/web/src/app/pages/admin/admin.component.html` | UI for live log stream |
| `packages/api/src/services/tailscale.ts` | Surface `AuthURL` in `getStatus()` |
| `packages/api/src/routes/tailscale.ts` | Save auth key to secrets on `POST /connect` |
| `packages/api/src/index.ts` | Auto-reconnect Tailscale on startup if stored key exists |
| `packages/web/src/app/pages/settings/settings.component.ts` | Polling while disconnected; show loginUrl |
| `packages/web/src/app/pages/settings/settings.component.html` | Auth URL link; connected state with hostname/IP/URL |
| `docker-compose.yml` | Mount `/var/run/docker.sock:ro` to nicotind |

---

## Verification

1. **PWA Queue Bug**: Build the PWA, open on Android Chrome, queue 5+ tracks, lock the screen after the first track starts. Verify all tracks play through without stopping.
2. **Auto-Playlist**: Trigger a batch download, wait for the Navidrome scan to complete, check `docker compose logs nicotind-1` — should see `Auto-playlist updated` instead of "Could not resolve" warnings.
3. **Docker Logs**: Open Admin → Logs in the browser, select "navidrome" — should see live container output streaming in real time.
4. **Tailscale**: Disconnect from Tailscale in Settings, restart nicotind container — verify it auto-reconnects using stored key without user action. Also verify the auth URL link appears when reconnection requires a new login.
