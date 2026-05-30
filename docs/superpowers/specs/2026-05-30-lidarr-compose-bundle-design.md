# Lidarr Compose Bundle

**Date:** 2026-05-30  
**Status:** Approved

## Goal

Add Lidarr to the NicotinD Docker Compose stack as a fully internal, zero-configuration dependency. Users never interact with Lidarr directly — it serves NicotinD's discography feature exclusively.

## Architecture

```
docker-compose
├── nicotind       :8484  (depends_on lidarr healthy)
├── slskd          :5030
├── navidrome      :4533
├── lidarr         :8686  (internal only, not port-exposed)
└── tailscale
```

Lidarr sits on the existing `internal` bridge network. Its port is **not** published to the host — NicotinD reaches it via `http://lidarr:8686` and nothing outside the stack can.

## API Key Bootstrap

Since Lidarr is purely internal, security of the key is bounded by the Docker network. A fixed key is baked into the compose file, passed to both sides:

- `nicotind` env: `NICOTIND_LIDARR_URL=http://lidarr:8686` + `LIDARR_API_KEY=nicotind-lidarr-internal`
- `lidarr` env: `LIDARR__AUTH__APIKEY=nicotind-lidarr-internal`

`LIDARR__AUTH__APIKEY` is linuxserver/lidarr's supported env var for forcing the API key on first boot, written directly into `config.xml`. This avoids any runtime key negotiation or shared-volume parsing.

`LIDARR_API_KEY` is already read by `main.ts` (`loadConfig`) and overrides the auto-generated `secrets.lidarrApiKey`. No code changes needed.

## New `lidarr` Service

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
    - music:/data/music     # read-only: status checks only
  healthcheck:
    test: ["CMD", "curl", "-sf",
           "http://localhost:8686/api/v1/system/status",
           "-H", "X-Api-Key: nicotind-lidarr-internal"]
    interval: 15s
    timeout: 5s
    retries: 5
    start_period: 30s
  networks:
    - internal
  restart: unless-stopped
```

`start_period: 30s` accounts for Lidarr's slow first-boot (writes config.xml, runs migrations).

## Changes to `nicotind` Service

Add to `environment`:
```yaml
NICOTIND_LIDARR_URL: http://lidarr:8686
LIDARR_API_KEY: nicotind-lidarr-internal
```

Add to `depends_on`:
```yaml
depends_on:
  - navidrome
  - slskd
  - lidarr          # wait for healthy before NicotinD starts
```

Change `depends_on` to use health conditions so nicotind waits for Lidarr to be healthy:
```yaml
depends_on:
  navidrome:
    condition: service_started
  slskd:
    condition: service_started
  lidarr:
    condition: service_healthy
```

## New Volume

```yaml
volumes:
  lidarr-config:
```

## What Stays the Same

- `config.lidarr` in `NicotinDConfigSchema` is already `.optional()` — no schema changes.
- `main.ts` already reads `LIDARR_API_KEY` and `NICOTIND_LIDARR_URL` env vars — no code changes.
- Discography routes are already conditional on `lidarr != null` — no code changes.
- Existing `lidarr-client` package is unchanged.

## What Is Not in Scope

- Lidarr UI access from outside the stack (no port publish, by design).
- Auto-configuring Lidarr root folders or quality profiles — Lidarr starts empty; its metadata lookup works without a root folder configured (read-only MusicBrainz queries via the discography API).
- Embedded mode (`NICOTIND_MODE=embedded`) — this only affects the Docker Compose external-mode stack.

## Files to Change

| File | Change |
|------|--------|
| `docker-compose.yml` | Add `lidarr` service, `lidarr-config` volume, env vars + depends_on update for `nicotind` |

That's the only file.
