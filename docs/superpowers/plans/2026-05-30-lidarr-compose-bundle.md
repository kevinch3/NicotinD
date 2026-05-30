# Lidarr Compose Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Lidarr to the Docker Compose stack as a fully internal, zero-configuration service wired to NicotinD's discography feature.

**Architecture:** Lidarr runs on the existing `internal` bridge network, never port-exposed to the host. A fixed API key is baked into the compose file and passed to both Lidarr (`LIDARR__AUTH__APIKEY`) and NicotinD (`LIDARR_API_KEY`). On startup NicotinD auto-registers its music directory as Lidarr's root folder so discography lookups work without any manual Lidarr configuration.

**Tech Stack:** Docker Compose, linuxserver/lidarr, Bun/TypeScript (`@nicotind/lidarr-client`, `src/main.ts`)

---

## File Map

| File | Change |
|------|--------|
| `packages/lidarr-client/src/api/artist.ts` | Add `addRootFolder(path)` method |
| `src/main.ts` | Auto-provision Lidarr root folder after client init |
| `docker-compose.yml` | Add `lidarr` service + `lidarr-config` volume; wire env vars and `depends_on` into `nicotind` |

---

### Task 1: Add `addRootFolder` to the Lidarr client

**Files:**
- Modify: `packages/lidarr-client/src/api/artist.ts`

The discography service already calls `getRootFolders()` on `lidarr.artist`. Adding `addRootFolder` to the same class keeps the root-folder API surface in one place without introducing a new file.

- [ ] **Step 1: Add the method to `ArtistApi`**

Open `packages/lidarr-client/src/api/artist.ts` and add after the existing `getRootFolders` method:

```typescript
  async addRootFolder(path: string): Promise<LidarrRootFolder> {
    return this.client.request<LidarrRootFolder>('/api/v1/rootfolder', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  }
```

The full file after the change:

```typescript
import type { LidarrArtist, LidarrQualityProfile, LidarrRootFolder } from '../types.js';
import type { LidarrClient } from '../client.js';

export class ArtistApi {
  constructor(private client: LidarrClient) {}

  async lookup(term: string): Promise<LidarrArtist[]> {
    return this.client.request<LidarrArtist[]>(
      `/api/v1/artist/lookup?term=${encodeURIComponent(term)}`,
    );
  }

  async list(): Promise<LidarrArtist[]> {
    return this.client.request<LidarrArtist[]>('/api/v1/artist');
  }

  async get(id: number): Promise<LidarrArtist> {
    return this.client.request<LidarrArtist>(`/api/v1/artist/${id}`);
  }

  async add(
    artist: LidarrArtist,
    qualityProfileId: number,
    rootFolderPath: string,
  ): Promise<LidarrArtist> {
    return this.client.request<LidarrArtist>('/api/v1/artist', {
      method: 'POST',
      body: JSON.stringify({
        ...artist,
        qualityProfileId,
        rootFolderPath,
        monitored: true,
        addOptions: { monitor: 'all', searchForMissingAlbums: false },
      }),
    });
  }

  async getQualityProfiles(): Promise<LidarrQualityProfile[]> {
    return this.client.request<LidarrQualityProfile[]>('/api/v1/qualityprofile');
  }

  async getRootFolders(): Promise<LidarrRootFolder[]> {
    return this.client.request<LidarrRootFolder[]>('/api/v1/rootfolder');
  }

  async addRootFolder(path: string): Promise<LidarrRootFolder> {
    return this.client.request<LidarrRootFolder>('/api/v1/rootfolder', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  }
}
```

- [ ] **Step 2: Verify typecheck passes**

```bash
bun run typecheck
```

Expected: exits 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/lidarr-client/src/api/artist.ts
git commit -m "feat(lidarr-client): add addRootFolder method"
```

---

### Task 2: Auto-provision Lidarr root folder in `main.ts`

**Files:**
- Modify: `src/main.ts` (around line 106–108, after the Lidarr client is created)

The provisioning block runs right after `const lidarr = ...`. It calls `getRootFolders()`; if the list is empty it calls `addRootFolder(config.musicDir)`. The whole block is wrapped in a try/catch — a Lidarr connectivity failure logs a warning but never crashes NicotinD.

- [ ] **Step 1: Add the provisioning block in `main.ts`**

Replace the existing Lidarr client creation block (lines 106–108):

```typescript
  const lidarr = config.lidarr
    ? new Lidarr({ baseUrl: config.lidarr.url, apiKey: config.lidarr.apiKey })
    : null;
```

With:

```typescript
  const lidarr = config.lidarr
    ? new Lidarr({ baseUrl: config.lidarr.url, apiKey: config.lidarr.apiKey })
    : null;

  if (lidarr) {
    try {
      const rootFolders = await lidarr.artist.getRootFolders();
      if (rootFolders.length === 0) {
        await lidarr.artist.addRootFolder(config.musicDir);
        log.info({ path: config.musicDir }, 'Registered music dir as Lidarr root folder');
      }
    } catch (err) {
      log.warn({ err }, 'Lidarr root folder provisioning failed — discography may not work until Lidarr is reachable');
    }
  }
```

- [ ] **Step 2: Verify typecheck passes**

```bash
bun run typecheck
```

Expected: exits 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "feat: auto-provision Lidarr root folder on startup"
```

---

### Task 3: Add Lidarr to `docker-compose.yml`

**Files:**
- Modify: `docker-compose.yml`

Three changes in one file: (a) new `lidarr` service, (b) new `lidarr-config` volume, (c) updated `nicotind` service env + `depends_on`.

- [ ] **Step 1: Add the `lidarr` service**

In `docker-compose.yml`, add the following service block after the `navidrome` service and before `tailscale`:

```yaml
  lidarr:
    image: linuxserver/lidarr:latest
    environment:
      PUID: 1000
      PGID: 1000
      TZ: Etc/UTC
      LIDARR__AUTH__APIKEY: nicotind-lidarr-internal
    volumes:
      - lidarr-config:/config
      - music:/data/music:ro
    healthcheck:
      test:
        - CMD
        - curl
        - -sf
        - http://localhost:8686/api/v1/system/status
        - -H
        - "X-Api-Key: nicotind-lidarr-internal"
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 30s
    networks:
      - internal
    restart: unless-stopped
```

Note: `music` is mounted `:ro` (read-only) — Lidarr uses it only for status-checking existing files, not for writing.

- [ ] **Step 2: Add `lidarr-config` to the `volumes` block**

In the `volumes:` section at the bottom of `docker-compose.yml`, add:

```yaml
  lidarr-config:
```

The full `volumes:` block after the change:

```yaml
volumes:
  nicotind-data:
  music:
  slskd-data:
  navidrome-data:
  tailscale-state:
  tailscale-sock:
  lidarr-config:
```

- [ ] **Step 3: Update the `nicotind` service**

In the `nicotind` service, make two changes:

**Add to `environment`:**
```yaml
      NICOTIND_LIDARR_URL: http://lidarr:8686
      LIDARR_API_KEY: nicotind-lidarr-internal
```

**Replace the flat `depends_on` list with a health-conditioned form:**

Before:
```yaml
    depends_on:
      - navidrome
      - slskd
```

After:
```yaml
    depends_on:
      navidrome:
        condition: service_started
      slskd:
        condition: service_started
      lidarr:
        condition: service_healthy
```

- [ ] **Step 4: Validate the compose file**

```bash
docker compose config --quiet
```

Expected: exits 0 (no YAML errors). If `docker` is not available locally, validate YAML syntax with:

```bash
python3 -c "import yaml; yaml.safe_load(open('docker-compose.yml'))" && echo "YAML OK"
```

Expected: `YAML OK`

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(deploy): add Lidarr to compose stack with auto-wired API key"
```

---

### Task 4: Push and verify CI

- [ ] **Step 1: Push**

```bash
git push origin master
```

- [ ] **Step 2: Watch the pipeline**

```bash
gh run list --limit 3
```

Expected: a new run appears. CI runs `bun run typecheck`, `bun run lint`, `bun test` — all should pass. The `release` job will bump the version and push a `chore(release):` commit. The `deploy` job on that bump commit will run `docker compose up --build -d` on the server, which pulls `linuxserver/lidarr:latest` and starts it.

- [ ] **Step 3: Confirm Lidarr is healthy on the server (optional)**

After deploy completes:
```bash
ssh $DEPLOY_USER@$DEPLOY_HOST "docker compose -f ~/Documents/nicotind/docker-compose.yml ps lidarr"
```

Expected: `Status` shows `healthy`.
