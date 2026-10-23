# Demo mode — proposed, mostly NOT built

**Status:** the demo catalog (`packages/core/src/demo/`) and the demo source addon are built and
drive the product tour (docs/product-tour.md). The static, serverless demo below is a plan.

## The requirement

People arriving from an article or from GitHub cannot reach a self-hosted instance, and exposing
one to the internet to show it off would publish an attack surface. The demo must let an anonymous
visitor click through the real UI with **no server at all**.

## Options weighed

| Option | Visitor can click around | Attack surface | Verdict |
| --- | --- | --- | --- |
| Static demo on GitHub Pages | yes, the real UI | none | **chosen** |
| Public demo instance on a VPS | yes, fully real | a real server to patch and watch | moves the risk, keeps it |
| Home server behind an access proxy | invited people only | low | fine for named testers, useless for anonymous readers |
| README video / GIF | no | none | complement — docs/product-tour.md |
| Real server in the browser | — | — | not feasible: Bun + native SQLite do not run there |

## Design

- **Same bundle, `demo` configuration**, published as a third tree (`/demo/`) by `pages.yml` beside
  `/storybook/` and `/fdroid/repo/`; a native "Try the demo" entry on the server picker later.
- **Fake the transport, run the real services** — the pattern Storybook's `fixtureHttpInterceptor`
  already uses. Four transports need a seam each: `HttpClient` (an interceptor), `<audio>`
  (`ServerConfigService.streamUrl()` returns a `blob:` URL from `renderTone`), `<img>` covers
  (`coverSvg` — after routing every hand-built `/api/cover` URL through one helper), and SSE /
  WebSocket (no-op sources).
- **Tiered coverage** of the ~266 `/api` paths the web calls: read-only browse/search/playback from
  static JSON; likes, playlists, history and queue in memory, reset on reload; everything else a
  typed `demo_unsupported` error with its nav hidden. A gate asserts every path is handled or on the
  unsupported list.
- **Static at runtime, generated at build time**: the JSON is a snapshot of the real API serving
  the demo catalog — boot the server with the demo Lidarr and demo source, acquire through the
  real pipeline, record the responses and the job-state progression — so it cannot drift from the
  real shapes the way hand-written fixtures do. The in-browser fake source replays the recorded
  progression.
- **Generated tones, not licensed music**: ~0 bytes shipped, nothing to attribute, and metadata that
  is true to the audio (tempo, duration, peaks). Real CC music was rejected on size (~100 MB).

## Plan

1. ~~Demo catalog, tone and cover generators~~ — built.
2. ~~Demo source addon~~ — built, `packages/e2e/tour/demo-addon.ts`.
3. Route every `/api/cover` URL through one seam.
4. Build-time snapshot generator.
5. Demo v1: tier-1 interceptor, SSE/WS stubs, the coverage gate, demo banner, lazy chunk.
6. Publish `/demo/` and a README "Try it" link.
7. Demo v2: tier-2 in-memory state and the in-browser fake source.
