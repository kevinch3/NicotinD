# Static demo

**Live at <https://kevinch3.github.io/NicotinD/demo/>.** The real web app, in the visitor's browser,
over a recorded snapshot of the real API and a small library of Creative Commons music. No server is
involved: nothing a visitor does reaches one, and nothing is saved.

## Why it is static

People arriving from an article or from GitHub cannot reach a self-hosted instance, and exposing one
to show it off would publish an attack surface (and, for the owner's server, their library). The
options weighed:

| Option | Visitor can click around | Attack surface | Verdict |
| --- | --- | --- | --- |
| Static demo on GitHub Pages | yes, the real UI | none | **chosen** |
| Public demo instance on a VPS | yes, fully real | a real server to patch and watch | moves the risk, keeps it |
| Home server behind an access proxy | invited people only | low | useless for anonymous readers |
| README video / GIF | no | none | complement, docs/product-tour.md |
| Real server in the browser | no | none | not feasible: Bun and native SQLite do not run there |

## How it works

**Same app, `demo` build configuration** (`angular.json`, `bun run --filter @nicotind/web build:demo`):

- `environment.demo.ts` sets `demo: true` and turns Sentry off.
- `demo/demo-config.ts` is empty in every other build. The `demo` configuration swaps it for
  `demo-config.demo.ts`, so no demo code reaches the bundles that ship to users.
- The service worker is off, because the bundle lives under a Pages path, not a site root.
- `baseHref` is `/NicotinD/demo/`. That is why the i18n catalogs and favicons are fetched with
  paths relative to the base href, never root-absolute ones.

**The fake server** (`DemoServer`, `demo/demo-snapshot.ts`) answers every `/api` request inside the
interceptor (`demoInterceptor`) from the snapshot. No request leaves the browser.

- **Phases.** A phase is a full recording of the GETs the SPA makes in one server state. `''` is
  the starting library, and `phaseId` of a set of acquired albums names the state after those Gets.
- **Gets.** Each Get is a recorded timeline that runs from the write that fired it until the album
  landed. Replaying it on its own clock is what makes the download visibly progress. When the
  timeline ends, the demo switches to the next phase, and the album shows up in the library with
  its cover. The `DemoState` (acquired albums, and a Get still in flight) survives a reload through
  `sessionStorage`.
- **GETs.** `requestKey` drops volatile query params. An exact query match is answered from the
  recording. For a query the recorder never saw, `nearestRecorded` picks a recording of the same
  path; for search, that is the recorded query sharing the most words, or the recorded no-match
  query.
- **Writes.** Deletes and admin/server-changing writes return `DEMO_UNSUPPORTED`, which the UI
  shows as "Not available in the demo" via `ERROR_CODE_I18N_KEYS`. Fire-and-forget writes
  (scrobbles, queue sync, preferences) succeed and change nothing.
- **Sign-in.** The visitor is signed in as an admin before boot, so every page is there to look at.
  A recorded real login answers the login page, so signing out and back in works with anything.
- **Live channels.** The library SSE stream and the playback WebSocket stay closed. Polling carries
  the Get progress, as it does whenever SSE is down.

**Media** never passes the interceptor, because an `<img>` or `<audio>` does not use `HttpClient`.
In the demo build, the URL builders (`coverUrl`, `withMediaToken`, `ServerConfigService.streamUrl`)
hand out the shipped files instead, via `demoMediaPath`:

- `demo-media/covers/<id>.jpg`
- `demo-media/remote/<demoHash(u)>.jpg`
- `demo-media/audio/<songId>.webm`, or `.m4a` where `canPlayType` refuses Opus/WebM (older iOS
  Safari).

**Chrome**: `DemoBannerComponent` shows the "nothing is saved" strip, a link to the project, and the
music credits the CC licences require (`demo-data/credits.json`).

## The library: real CC music

The library is ten real releases from the Internet Archive, approved by the owner on 2026-11-13. The
list is `DEMO_ALBUM_SOURCES` in `packages/e2e/demo/albums.ts`.

- **Licences.** Only CC0, CC BY and CC BY-SA are allowed (`isAllowedLicence`): no NC, and no ND,
  because the demo transcodes.
- **Held back.** Two albums are `heldBack`. They are not in the library; they are what the
  simulated Get acquires.
- **Pinning.** `pin-manifest.ts` pins the list to exact files in `manifest.json`, each with its
  Archive-published sha1.
- **Layout.** `cc-catalog.ts` (`layOutCcLibrary`) downloads and verifies the files, re-tags them
  from the manifest without re-encoding, and writes a 600 px `cover.jpg` per album.
- **Size.** 91 tracks, about 4.6 h, about 420 MB of source MP3. The shipped site is about 320 MB:
  Opus at 64 kb/s plus an AAC fallback, 129 covers, and a snapshot of under 1 MB gzipped.

Generated tones were the first plan: zero bytes and nothing to attribute. Real music was chosen
because a music app demoed on sine waves sells nothing. The tone catalog still drives the product
tour.

## Building it

```bash
bun run scripts/build-demo.ts site            # bundle + recorded snapshot + media → site/demo/
DEMO_SITE_DIR=site bun run --filter @nicotind/e2e demo   # smoke it, served the way Pages serves it
```

**The recorder** (`packages/e2e/demo/record-snapshot.ts`) boots the real server over the CC
library, with the tour's stand-ins (`startDemoLidarr`, `startDemoAddon`) serving the CC catalog via
`ccCatalog`. It then drives the real SPA in Chromium, in one server run:

- It records `''`, Gets A and records `A`.
- It deletes A and its job, which returns to the base library, then Gets B and records `B`.
- It Gets A again and records `A|B`.

Both timelines therefore start from the base library. Library ids are hashes of paths and tags, so
a re-acquired album keeps its ids. Response bodies are read inside a tracked set that `settle()`
drains before every navigation; a body is gone once the page navigates.

Two further passes fill in what the crawl did not reach:

- **Template expansion.** Every GET recorded for one song, album or artist is re-requested for all
  the others, so a visitor can open any page. Only a key naming exactly one entity is a template:
  a radio request naming its seed and its exclusions would multiply per id.
- **Phase diffs.** A later phase keeps only the entries that differ from the base.
- **Media.** Every cover id named in a body is fetched, and each song's bytes come from the real
  `/api/stream`.

**Deep links.** Pages has no rewrite rules, so `scripts/build-demo.ts` writes the site's `404.html`.
A path under `/NicotinD/demo/` is stashed in `sessionStorage` and sent back through the demo's
entry, and `demo-config.demo.ts` restores it before the router reads it.

**Publishing.** `pages.yml` rebuilds the demo on every publish, because one deployment replaces the
whole site. The source audio is cached under the manifest's hash.

- The demo step is `continue-on-error`: a broken demo must never block the F-Droid repository,
  whose clients depend on that publish.
- The build is staged as a site of its own, and the smoke spec (`playwright.demo.config.ts`, desktop
  and phone) runs against it with no backend. Only a passing build moves into `site/`, so a failure
  ships the site without `/demo/` rather than a broken one.

## Limits

- Writes do not persist, and a visitor's own playlists or likes are not modelled.
- Search answers from the nearest recorded query, so typing an artist outside the catalog shows the
  no-match result, not a live search.
- Per-song player data (waveform, lyrics, radio) comes from template expansion. A per-song endpoint
  the crawl never triggered falls back to a recording made for another song.
