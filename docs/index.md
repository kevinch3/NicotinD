# The index

Every mechanism in NicotinD: what it is, the symbols you would grep for, and the doc that explains
why. Split out of `CLAUDE.md` so it is read when needed rather than paid for on every request
(issue #934); the entry shape and its caps are unchanged, and `bun run check:claude-md` still
enforces them here.

The index proper. Each line: what it is, what to grep for, where the detail lives.

- **Proposed, NOT built** — read each as the pitch it is; no route, no table, no dependency ships for
  any of them: peer share, serving a library over `/addon/v1` to another instance
  → [peer-share.md](peer-share.md); hardware cast, Chromecast + DLNA
  → [cast-integration.md](cast-integration.md); OAuth as an `auth` plugin kind
  → [oauth-auth.md](oauth-auth.md); WebMCP host exposure, client-side WebGPU/WebNN a NO-GO
  → [webmcp-alignment.md](webmcp-alignment.md),
  [client-side-ml-feasibility.md](client-side-ml-feasibility.md)

## Sections

Each section is its own file, so locating a mechanism costs one section rather than the
whole index (#1240). A section over its byte cap has earned a **split**, not a trim.

| Section | What lives there |
| --- | --- |
| [Acquisition & downloads](index/acquisition.md) | How a wanted album becomes files on disk: addons, hunts, jobs, retention. |
| [Library & metadata](index/library.md) | What the scanner writes, and how identity, tags and artwork stay correct. |
| [Audio analysis & enrichment](index/audio-analysis.md) | Descriptors, loudness, BPM, lyrics — and the sidecars that compute them. |
| [Playback, radio & streaming](index/playback.md) | Transcoding, the player, remote output, and how a queue gets filled. |
| [Playlists, listening & privacy](index/listening.md) | What gets recorded about listening, and what deliberately does not. |
| [Users, auth & access](index/users-auth.md) | Accounts, roles, pairing, and what each route decides about auth. |
| [Web UI patterns](index/web-ui-patterns.md) | Angular conventions the SPA holds to: signals, routes, i18n, Storybook. |
| [Data integrity, caching & migrations](index/data-integrity.md) | Invariants that must survive a rescan, a cache, and a schema change. |
| [Build, CI, deploy & ops](index/build-ci.md) | Gates, release, packaging, the prod host, and what watches it. |
