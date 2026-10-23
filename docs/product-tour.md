# Product tour video

A ~50 s captioned, muted video of the app in use, plus a GIF teaser, for the README and for anyone
arriving from an article or GitHub who cannot reach a running instance. It is **recorded, not
edited by hand**: a Playwright spec drives the real app and writes its own cut list, and a script
assembles the video from it, so a new take after a UI change is one command.

## Running it

```bash
bun run --filter @nicotind/e2e tour       # record: one video per shot into tour-output/raw/
bun run --filter @nicotind/e2e tour:cut   # cut: tour-output/nicotind-tour.mp4 + .gif
```

Needs `ffmpeg` on `PATH` (the demo library is synthesised and encoded locally) and the same Node
the web build needs. `TOUR_CHROMIUM_PATH` points it at a Chromium other than the one the pinned
Playwright expects — for a machine whose preinstalled browser build does not match. Not part of
CI and not part of `verify`: it produces an asset, it asserts nothing about the product a spec
does not already.

## What is real

Everything on screen is the real server and the real SPA. Two stand-ins sit behind it, each
serving the generated **demo catalog** (below) rather than anything real:

| Stand-in | Replaces | Why |
| --- | --- | --- |
| `startDemoLidarr` (`tour/demo-lidarr.ts`) | Lidarr | Catalog search, resolve and the album hunt are Lidarr-gated, and e2e has no Lidarr. It answers the dozen read endpoints that path calls; every artist reports as already monitored, so no provisioning detour. Sleeves are served under `/MediaCover/`, the shape the server's cover proxy already resolves against the Lidarr URL. |
| `startDemoAddon` (`tour/demo-addon.ts`) | an acquisition source | A protocol-v1 addon, registered over HTTP like any other. Grown from the e2e fixture addon with the two things a viewer sees and a spec does not need: a multi-track album delivered item by item, and downloads that progress on their own clock. |

The only off-camera step is seeding the demo song's synced lyrics, through the same curator
endpoint (`PUT /api/library/songs/:id/lyrics`) a person would use — the song has no lyrics source.

## The demo catalog

`packages/core/src/demo/` — invented artists and albums whose audio and artwork are generated,
so they cost no bytes to ship and are free to redistribute (docs/demo-mode.md). Deliberately not
re-exported from `@nicotind/core`: only surfaces that build or serve the demo import it.

- **`DEMO_ALBUMS`**: a `library` pool on disk before the tour starts, and an `acquirable` pool that
  exists only at the demo source, so the acquire shot always has something real to find. The
  acquirable album shares an artist with a library one, so it lands next to something already seen.
  Every album has at least `DEMO_MIN_ALBUM_TRACKS` (7): the scanner files anything at or under
  `EP_MAX_TRACKS` as an EP, and an EP is missing from the Albums grid.
- **`renderTone`** synthesises a song from its seed: tempo, key, a chord progression, a pentatonic
  melody, and drums by genre. The metadata is honest about the audio — `bpm` is the tempo rendered
  and `durationSec` the exact length, which the player checks (`browserDurationIsAcceptable`).
- **`coverSvg`** draws a sleeve from the seed in one of four motifs; the catalog names each album's
  motif so a small catalog shows them all. Gradient ids are unique per sleeve because SVG ids are
  document-global, and two inline covers sharing one paint the same fill.

`tour/make-demo-library.ts` (`ensureDemoLibrary`) renders the catalog to tagged FLAC (22.05 kHz
mono, ~1 MB a track) with a `cover.jpg` per album rasterised in Chromium. Regenerated on demand,
never committed; the output is a pure function of the catalog.

## Shots

| # | Shot | Caption |
| --- | --- | --- |
| 1 | Home mosaic | Your music. Found, organized, streamed. |
| 2 | Search → one tap on the album card → best match → download (4×) | One search box, for any source. / One tap. It picks the best match… / …downloads it, tags it, files it. |
| 3 | Library grid, new album first → album page | It lands in your library, artwork and all. |
| 4 | Play → Now Playing → lyrics → radio | Press play. / Now Playing, with the real waveform. / Synced lyrics, line by line. / Radio keeps it going, matched by tempo and mood. |
| 5 | End card | — |

Acquisition leads and gets the most time because it is what the product does that other players do
not. Setup, admin and curation are left out on purpose: they do not help a first-time visitor decide.

## How it is cut

Each test is one shot and one video. The `shot` fixture (`tour/shot.ts`) records segments in
seconds from the page's creation: `begin()` sets the in-point once the page settles, `fast(n, …)`
plays what it wraps at n× (the download), `end()` sets the out-point. `cut-tour.ts` trims, speeds,
fades each shot and joins them: H.264 MP4 at CRF 23 (~1.6 MB) and a palette-optimised GIF of the
acquire shot (~0.7 MB).

The cursor and captions are injected into the page (`tour/overlay.ts`), not burned in by ffmpeg:
Playwright records no pointer, and in-page captions share the app's type. Both are
`pointer-events: none`, so they can never intercept a click the tour makes. Captions take a
position — above the player bar, below the header, or over it for full-screen views — because the
default spot covers the waveform the Now Playing caption is about.

## What the tour found

The first take showed the demo source as **"Soulseek"** on the search page and as **"Unknown
source"** in Activity: the web labelled sources from a fixed list. Both now come from the addon's
manifest name — docs/source-agnostic-acquisition.md "Sources are named by their manifest".
