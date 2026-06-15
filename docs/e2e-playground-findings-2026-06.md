# E2E Playground Findings — Acquisition, Hunt & Library Deletion

**Date:** 2026-06-13
**Method:** Drove the **live** stack (Docker `nicotind` `:8484` + real slskd `:5030`, Lidarr `:8686`,
all four acquisition plugins enabled) through the acquisition → hunt → library flows. Findings come
from a mix of: live API calls (timed), the live SQLite DB (`~/.nicotind/nicotind.db`, read-only), and
the source. Suggested exploration artists were **Zara Larsson** (pop, distinctive-ish), **Los
Chalchaleros** (Argentine folklore, distinctive name), **Falsa Cubana** (short/common-token name).

> Repro caveat: a few flows mutate state — `catalog/resolve` adds monitored artists to Lidarr (3
> "Los Chalchaleros" artists were added during this session), and album deletion is irreversible and
> **admin-only**. The deletion bug (§D) was root-caused against the live DB + code rather than by
> executing the destructive delete (the playground login is a regular `user`; self-escalating to
> admin to delete real files was not appropriate).

---

## Status (2026-06-13)

Branch `fix/playground-findings-2026-06` implements **D1, A2, A3, B1, B2** (batch 1) and then
**A1, A4, E1** (batch 2), all with tests. The remaining items (**C1, C2, C3, D2**) are deferred —
they need live-backend testing, a streaming/perf rework of the hunt, or a risky scanner/schema
change, and warrant their own review. ✅ = fixed on this branch; ◻️ = open follow-up.

A later playground pass (**2026-06-14**) added the **F-series** (§F) — the song/single acquisition
gap. These are open follow-ups (documentation only this pass); the implementation is phased ("Songs
lane now, track-hunter later") and deferred to its own session.

A **mobile** pass (**2026-06-15**, Pixel 7 viewport via Playwright) added the **G-series** (§G) — a
screen-by-screen UX review of Player / Library list / Library album / Song details — and **A6**, a
re-confirmation that the guided catalog→hunt path is still a **dead end for Zara Larsson** (10/10
cards junk, 10/10 resolve `404`s, hunt modal never opens). Documentation only; fixes deferred. The
shots were captured by a throwaway, out-of-CI harness (`packages/e2e/playwright.screenshots.config.ts`
for the local managed server, `playwright.hunt.config.ts` for the live prod hunt) — the automated
mobile successor to the manual sessions, run the same way as the §E2 playground.

## TL;DR — prioritized follow-ups

| # | Status | Severity | Area | Issue |
|---|--------|----------|------|-------|
| D1 | ✅ | **High (bug)** | Library | Album delete orphans the `library_artists` row → deleted artist still shows in search & opens an empty artist page until the next *full* scan |
| A2 | ✅ | **High (bug)** | Catalog | `catalog/resolve` 500s ("not yet available in Lidarr") for a subset of returned album cards — clicking a valid-looking result errors |
| A1 | ✅* | High (UX) | Catalog | Album cards are a global title search disjoint from the matched artist → for non-distinctive names (Falsa Cubana, Zara Larsson) the cards are entirely wrong/irrelevant |
| C1 | ◻️ | Medium (UX) | Hunt | 42 s wait → "No candidates" with **no fallback** to the loose tracks that demonstrably exist on Soulseek |
| B1 | ✅ | Medium | archive.org | Low precision (radio shows / mixtapes) — query lacks phrase quoting + `creator:`/`title:` targeting |
| B2 | ✅ | Medium | archive.org | Erratic recall + silent failure: same query returned 0 then 20 results within a minute; non-OK responses collapse to `[]` |
| C2 | ✅* | Low/Med (UX) | Search | Network results only surface at *completion* (~25 s for niche queries) though peers respond in ~5 s. **Improved:** the search already polls + renders partial results every 2 s (not gated on completion); now also shows **"N peers responded"** during the wait so a slow niche query reads as progress, not a dead spinner. (Late *file* materialization is slskd-side) |
| C3 | ✅ | Low | Hunt | Sequential base→skew latency (~45 s worst case). **Assessed — already handled:** `hunt()` early-terminates (skew only fires when `bestBasePct < SKEW_TRIGGER_PCT`), so a confidently-complete base skips skew entirely; always-parallel would just double slskd load |
| A3 | ✅ | Low | Catalog | Bogus `year` (`0001`) rendered verbatim on album cards |
| A4 | ✅ | Low | Catalog | Artist pills are noisy/duplicated ("Zara/ZarA/Zara…", "Los/King Los…") |
| E1 | ✅ | Low (infra) | e2e | Hunt modal lacks `data-testid`s on its core controls — violates the project's e2e selector standard |
| D2 | ◻️ | Low | Library | Duplicate artist rows from "The"-prefix handling ("The Jinx" + "Jinx"); `library_album_tombstones` is populated historically but no longer written by the delete path |
| F1 | ✅ | **High (UX)** | Search | Song-first acquire path — a **Songs lane** dedupes network files by (artist,title), auto-picks the best copy (FLAC>MP3, then availability) and one-click downloads it (`lib/song-results.ts`) |
| F2 | ◻️ | Medium | Hunt | No per-track hunter — the album hunt's skew/cross-peer/auto-retry robustness has no single-song equivalent (also unblocks the C1 0-candidate fallback) |
| F3 | ◻️ | Low (infra) | e2e | No UI entry point / `data-testid` for song acquisition; CI (dead slskd) can't exercise it — needs the §E2 gated playground spec |
| A6 | ✅ | **High (UX)** | Catalog/Hunt | **Guided hunt is unreachable for Zara Larsson** — catalog returns 10/10 junk, 10/10 cards `404`, the hunt modal never opens. **Fixed:** (1) `search()` suppresses the junk (0 cards + `discographyUnavailable`), auto-opens the network lane with an explanatory note; (2) **deep fix** — a "Load <artist>'s discography" button calls `loadDiscography()` which adds the artist to Lidarr on demand and lists their real, hunt-able albums. Turns the dead-end into a working guided hunt |
| A7 | ✅* | Medium (UX) | Search (network) | Raw-folder lane is the *working* escape hatch (downloaded Poster Girl in FLAC), but dumps **~98 unranked near-dup album folders**; format buried (2/98 FLAC), "Unknown bitrate" shown under filenames that state the kbps, no free-slot/lossless ranking. **Mitigated:** folders now **ranked** (free-slot > lossless > more tracks > faster), each carries a **format badge** (FLAC highlighted), per-file quality falls back to the format name, and **cross-peer dedup** collapses the ~100 near-dup folders to one card per distinct copy (editions/formats preserved; "+N peers" shown) |
| G1 | ✅ | **High (bug)** | Web (mobile) | Album-detail **primary Play button is clipped off the left edge** — 6 actions in a non-wrapping centered flex row overflow the viewport. **Fixed:** action row is now `flex-wrap` (admin actions wrap to a second line) + Play is an accent-filled primary button |
| G2 | ✅ | **High (bug)** | Web (mobile) | Now Playing **hero cover + queue thumbnails render broken-image glyphs** — raw `<img>` instead of the `app-cover-art` gradient fallback used in the grid/mini-player. **Fixed:** both now use `app-cover-art` (gradient fallback on 404). Side effect: the hero filling its box also removes most of G4's vertical void |
| G3 | ✅ | High (UX) | Web (mobile) | Track-info sheet **shows no song identity** (no title/artist/album) — Now Playing mounts it without the `[song]` input, so `song()` is null and the whole "File" block is hidden too. **Fixed:** added an always-on identity header (cover + title/artist/album) sourced from `song()` or new lightweight display inputs the player passes |
| G4 | ✅ | Medium (UX) | Web (mobile) | Now Playing has a **large vertical void** (cover pinned small at top, title floated to center); no visible affordance to reach Track info (long-press only). **Fixed:** G2 (hero fills its box) removed the void, and an `ⓘ` button beside the title now opens the sheet directly (long-press still works) |
| G5 | ✅ | Medium (UX) | Web (mobile) | Mini-player progress is a **1px hairline**; list content is **occluded** by the player+tab-bar (no bottom scroll padding). **Assessed — already handled:** the seek bar is a 20px touch target (4px track + 12px thumb), and `mainBottomPadClass` already pads `<main>` `pb-8rem` when a track plays. Original finding was overstated (a *faint low-progress* bar, not a hairline) |
| G6 | ✅ | Medium (UX) | Web (mobile) | Now Playing title **context menu overflows the right edge** — positioned at tap-X with no viewport clamp. **Fixed:** `clampMenuPosition` keeps the menu fully on-screen (+ `max-w` guard) |
| G7 | ✅ | Low (UX) | Web (mobile) | Library list: **stray unlabeled "1" counter** on the Filters row; 5-tab segmented control crowds the edges. **Fixed:** count now reads "N album(s)"; tabs get tighter mobile padding + horizontal-scroll overflow so they don't crowd/clip |

**Fix notes:** D1 — delete handler now prunes orphaned `library_artists`/`library_genres`/
`library_artwork` in the same transaction. A2 — `resolveAlbum` falls back to a diacritic-insensitive
title match and throws a typed `404` (`ALBUM_NOT_IN_LIDARR`) instead of `500`. A3 — placeholder years
(`< 1900`) dropped at mapping. B1 — archive queries are field-targeted + phrase-quoted. B2 — archive
service retries once and throws `ServiceUnavailableError` (route `503`) so upstream failure ≠ empty.
A4 — artist pills deduped by normalized name. E1 — `data-testid`s added to the hunt modal's download
button, candidate rows, searching/empty states, skew + min-match filters.

**A1 (✅\*, partial):** `search()` now **scopes album cards to the matched artist** when the artist's
own releases appear in the lookup (drops the bootleg/tribute/compilation noise), and never empties a
pure album-title search. This fixes the common case (e.g. Zara Larsson's real albums surface above
mashups *when Lidarr returns them*). The deeper fix — fetching the top artist's full discography for
names whose own releases don't appear in the global `album.lookup` at all (e.g. Falsa Cubana) —
needs an artist-scoped Lidarr lookup and remains a follow-up.

---

## Benchmarks (live, warm)

| Lane | Endpoint | Zara Larsson | Los Chalchaleros | Falsa Cubana |
|------|----------|--------------|------------------|--------------|
| Catalog search | `GET /api/catalog/search` | 0.26 s | 0.52 s | 0.52 s |
| archive.org search | `GET /api/archive/search?q=` | 0.25–0.90 s | 0.33 s | 0.34 s |
| Catalog resolve | `POST /api/catalog/resolve` | — | 0.4–1.0 s (500 for 2/5 cards) | — |
| Hunt base | `POST …/hunt/base` | — | **20.1 s** (0 candidates) | — |
| Hunt skew | `POST …/hunt/skew` | — | **22.1 s** (0 candidates) | — |
| Network search (popular) | `GET /api/search` + poll | "Daft Punk Discovery" → **250 responses / 248 results in ~3 s** | — | — |
| Network search (niche) | `GET /api/search` + poll | "Zara Larsson" → 250/246 (~3 s) | "Los Chalchaleros" → **19 responses, results only at ~25 s** | — |

Soulseek connectivity was verified healthy (`networkAvailable: true`; popular queries return hundreds
of results in ~3 s), so the zero-candidate hunt below is genuine scarcity, not a broken pipe.

---

## A. Catalog (metadata) search — "find an album by this artist"

`CatalogService.search()` (`packages/api/src/services/catalog-search.service.ts`) fires
`lidarr.artist.lookup(query)` **and** `lidarr.album.lookup(query)` in parallel and returns both lanes
independently. The album lane is a **global MusicBrainz title search that ignores the matched
artist**. This is the root of A1 and A2.

### A1 — Album cards are disjoint from the artist (High UX)
Top-10 album cards observed:

- **Los Chalchaleros** (distinctive name) → ✅ all real Los Chalchaleros albums.
- **Zara Larsson** → ❌ mashups/bootlegs/tributes: "Zara Larsson discography" by *Random Wikipedia
  Article*, "Piano Dreamers Perform Zara Larsson (Instrumental)", a stack of *oneboredjeu* vs-mashup
  singles. **None** of her actual studio albums (*So Good*, *Poster Girl*, *Venus*) appear.
- **Falsa Cubana** → ❌ albums titled "Falsa …" by *unrelated* artists (Nicole Bahls — *Falsa*,
  Gretchen — *Falsa fada*, Knights of Blood — *Falsa realidad*). **Zero** Falsa Cubana releases,
  even though Falsa Cubana is correctly returned as the first **artist**.

So for any artist whose name isn't a distinctive multi-word phrase, the primary "find their album"
use-case is broken: the right artist is identified but their discography is never shown.

**Fix:** when the top artist is a confident match, drive the album cards from **that artist's
discography** (look the artist up, list their albums) instead of / in addition to the global
`album.lookup`. Minimal interim: filter `album.lookup` results to those whose `artistName` matches a
returned artist before display.

### A2 — `resolve` 500s for a subset of cards (High, bug)
`resolveAlbum()` adds the artist on demand, then does
`albums.find(a => a.foreignAlbumId === input.foreignAlbumId)` over `lidarr.album.listByArtist`. The
release-group IDs from the **global** `album.lookup` are **not guaranteed to exist** in the artist's
Lidarr discography, so the find fails and the route throws a 500 `"<title>" is not yet available in
Lidarr for <artist>`.

Observed: 3 of 5 Los Chalchaleros cards resolved; **2 of 5 returned 500** ("La historia de los
Chalchaleros vol.1", "20 éxitos…"). The failure **persisted across 6 retries over 25 s**, so it is
**not** an async metadata-refresh race — it's a hard ID-reconciliation gap. The message also
misleadingly implies a transient "not yet available" state.

**Fix:** same root cause as A1 — sourcing album cards from `listByArtist` makes every card resolvable
by construction. Failing that, match by normalized title (not just `foreignAlbumId`) and return a
clearer error/status (`409`/`422`, not `500`).

### A3 — bogus years rendered (Low)
Albums with a placeholder release date surface `year = "0001"` and the card renders it verbatim
(`{{ album.year }}` in `search.component.html`; e.g. "La historia… vol.1", "Falsa moneda / El
meneíto"). Suppress non-plausible years (`< ~1900`).

### A4 — artist-pill noise (Low)
Artist pills include many near-duplicate / single-token entries ("Zara", "ZarA", "Zara"…;
"Los", "King Los"…). Dedupe by normalized name and/or drop very-low-confidence single-token hits.

### A5 — non-deterministic ordering (Low, test hazard)
Repeating the identical `catalog/search` returned the album list in a different order / membership
between calls — worth pinning a sort before any snapshot-style test.

### A6 — Zara Larsson re-test: guided hunt is a total dead end (High UX, 2026-06-15)
A mobile pass drove the full **search → click album → hunt → download** flow against prod
(`https://nicotined.kevinroberts.ar`, user `claude-e2e`) for **"Zara Larsson"**. Result: the **hunt
modal never opened for any of the 10 cards** and **no album could be downloaded** via the guided path.

Two compounding failures, both predicted by A1/A2:

1. **Catalog returns 100% noise.** All 10 album cards are mashups/tributes/metadata-junk — none of her
   real studio albums. The entity attribution is also inverted (artist/title swapped): cards render as
   *title* "Zara Larsson" / *artist* "OVÖ", *title* "Zara Larsson discography" / *artist* "Random
   Wikipedia Article", plus a "Piano Dreamers … (Instrumental)" and **five** *oneboredjeu* vs-mashup
   singles, and a David Guetta single she merely features on. This is the exact case A1's `✅*` partial
   fix **does not** cover — her own releases don't appear in the global `album.lookup` at all, so the
   artist-scoping has nothing to scope to.

2. **Every card 404s on resolve.** Clicking any card now surfaces the A2-fix's typed error inline
   (`ALBUM_NOT_IN_LIDARR`), e.g. *`"Zara Larsson" isn't in OVÖ's Lidarr discography yet`*. So A2 is
   working as designed (no more 500s), but for this artist it means **10/10 cards are non-actionable**
   and the user is left with a wall of red banners and no way forward. The message is also confusing
   given the swapped attribution ("X isn't in Y's discography" reads as nonsense to a user).

**Net UX:** for a mainstream artist not already monitored in Lidarr, the documented *primary* guided
path (catalog card → `AlbumHuntModalComponent`) is unreachable — you can neither see a real album nor
open a hunt. The working escape hatches (the **Advanced: search the network directly** disclosure, the
**archive.org** lane, **Get from a link**) exist but are intentionally demoted, so the headline flow
fails silently-ish (red banners) for exactly the queries users are most likely to type first.

**Fixed (2026-06-15, mitigation — interim (a)+(b)):** `CatalogService.search()` now, when the query
**exact-matches a returned artist** but none of the `album.lookup` results belong to them, returns
`albums: []` + `discographyUnavailable: true` + `scopedArtist` (instead of falling back to the junk),
and ranks an artist's own albums by type (Album > EP > Single) then newest-first. The web suppresses the
junk grid, **auto-opens the Advanced network lane** (`shouldOpenDirectSearch` — now keyed on *album
cards*, not artist pills), and shows a `discography-note` explaining the fallback. So the Zara-Larsson
flow no longer dead-ends on a wall of red-banner junk — it lands the user on the working network lane
(which downloaded *Poster Girl*, §A7). *Tests:* `catalog-search.service.test.ts` (suppress-junk + flag,
ranking) and `catalog-display.spec.ts` (lane-open + note logic).

**Deep fix shipped (2026-06-15, option (a) — load on demand):** since `album.listByArtist` needs a
numeric (added) artist id, the new `CatalogService.loadDiscography(artistMbid, artistName)` **adds the
artist to Lidarr** (reusing `resolveOrAddArtist` — the same mutation `resolve` already makes) and returns
their real releases as ranked cards. It's exposed at `POST /api/catalog/discography` and surfaced as a
**"Load <artist>'s discography"** button (`data-testid="load-discography"`) beside the network-fallback
note — **user-initiated only, never automatic on search** (so search stays read-only and Lidarr isn't
polluted by every typed query). One click turns the Zara-Larsson dead-end into her real, hunt-able
discography. *Tests:* `catalog-search.service.test.ts` (add-then-list + reuse-existing), `catalog.test.ts`
(`POST /discography`), `catalog-display.spec.ts` (`scopedArtistMbid`, `applyDiscography`).

The read-only alternative (query MusicBrainz/SkyHook release-groups by artist MBID, no Lidarr mutation)
remains a possible future refinement, but the on-demand add is the pragmatic, fully-working path and
matches the existing resolve trade-off.

> Repro: `cd packages/e2e && E2E_BASE_URL=https://nicotined.kevinroberts.ar
> PLAYGROUND_USERNAME=claude-e2e PLAYGROUND_PASSWORD=… bunx playwright test
> --config=playwright.hunt.config.ts` (logs each card's resolve outcome; screenshots `07–10` under
> `screenshots/mobile/`). No state was mutated — every resolve 404'd before adding any monitored artist,
> and no download was enqueued.

### A7 — The working escape hatch: raw-network folder lane (2026-06-15)
With the guided path dead (A6), the **Advanced → Folders** lane (raw Soulseek) downloaded the album
cleanly. Searched `Zara Larsson Poster Girl`, opened the `advanced-toggle` disclosure, switched to
Folders, picked a FLAC folder, hit **Download folder** → it queued, downloaded 12/12, organized and
scanned into the library (`GET /api/search?q=Poster Girl` now returns the album; song bitRate **1714
kbps = FLAC lossless**, cover art resolved). The **Downloads → Active** UX for this is genuinely good:
`SOULSEEK` method badge, `Downloading` stage chip, `1 of 12 · Just now`, an 11% progress bar, cancel.

But the **folder lane itself surfaces the inverse of A6's problem — too much, unranked**:

- **~98 folder results for one album**, almost all near-identical "Poster Girl (2021)" rips. No
  album-level dedup/ranking — the §F1 Songs lane dedupes *songs* by `(artist,title)` and auto-picks the
  best copy, but there is **no equivalent "best album folder" pick** for whole-album grabs. The user
  scrolls a wall of duplicates.
- **Format is buried.** Only **2 of ~98** folders were FLAC (#1, #48); the rest 320/260/187 kbps MP3.
  Format isn't a folder-level badge or filter — you must read filenames or expand each folder. A
  "FLAC only / lossless-first" sort or badge would make the recommended pick obvious.
- **"Unknown bitrate" shown under filenames that state the kbps** (e.g. a row titled "Poster Girl (FLAC
  24bit 1713 kbps)" still renders "Unknown bitrate · 37.9 MB"). The slskd file's `bitRate` is null, so
  the UI says "Unknown" even when the format is right there in the name — confusing and contradictory.
- **Almost every folder is `0 slots`** (queued, not instantly free). That's normal Soulseek, but the
  lane doesn't sort by *free-slot-first*, so the top rows are often queued while a downloadable peer sits
  further down.

**Fixed (2026-06-15, mitigation):** the folder lane now **ranks** candidates (`rankFolders`:
free-slot → lossless → more tracks → faster upload), so the 2 FLAC folders rise to the top of the
~98 — instead of being lost in raw order. Each folder shows a **format badge** (`folderFormat`; FLAC
highlighted emerald), and per-file rows use `fileQualityLabel`, which falls back to the format name so a
FLAC file no longer reads "Unknown bitrate". A human would now spot the FLAC copy at a glance.
*Tests:* `folder-utils.spec.ts` (ranking order + no-mutation, format detection, quality label).

**Cross-peer dedup shipped (2026-06-15):** `dedupeFolders` collapses the ~98 near-identical folders into
one card per **distinct** copy, keyed on **basename + format + audio-track-count** — so a deluxe edition
(more tracks) or a different format survives as its own card and only literally-identical copies across
peers merge. It runs on the *ranked* list (keeps the best peer) and annotates `duplicatePeers`, rendered
as "· N peers" so the user still sees availability. *Tests:* `folder-utils.spec.ts` (collapse + count,
edition/format preservation, no input mutation).

> Repro: `… bunx playwright test --config=playwright.hunt.config.ts network-album-download` (idempotent —
> re-runs detect the already-downloaded "✓ Done" folder and skip; screenshots `12–15`).

---

## B. archive.org lane

`ArchiveSearchService.query()` (`packages/api/src/services/archive-search.service.ts`) builds
`q = (${terms}) AND mediatype:audio` for **both** the free-text and artist+album forms — no phrase
quoting, no field targeting.

### B1 — low precision (Medium)
`?artist=Zara Larsson&album=Venus` returned radio-show / mixtape items ("Crap From The Past — 2017",
"Urb@ni@ Mixtape Vol.5") — anything whose audio metadata merely *mentions* the words. Target
`creator:`/`title:` and quote phrases (e.g. `creator:("Zara Larsson") AND title:("Venus")`), and
consider restricting to music collections.

### B2 — erratic recall + silent failure (Medium)
Free-text `?q=Zara Larsson` returned **0 items on one call and 20 on the next within ~1 minute**. The
service maps any non-OK status or thrown error to `[]` (logs a warning, returns empty), so a
transient archive.org hiccup is indistinguishable from "no results" in the UI ("No archive.org
results for …"). Add a short retry/backoff and/or a brief cache, and distinguish "error" from "empty"
in the response so the UI can say "archive.org unavailable" rather than implying nothing exists.

---

## C. Album hunt

### C1 — 42 s → "No candidates", no fallback to loose tracks (Medium UX)
Hunting Los Chalchaleros' self-titled album (14 canonical tracks) ran base (20 s) + skew (22 s) =
**42 s** and returned **0 candidates**. This is *correct* folder-level behavior — a direct network
search for "Los Chalchaleros" returns **19 results**, but they're scattered loose tracks
(compilation cuts, singles, a track on a *Les Luthiers* album), not a peer folder matching the
canonical tracklist. The dead-end is the UX problem: after 42 s the user gets "No candidates match
your filters" with the only escape hatches being the filter knobs and an archive.org section that
(per §B) often returns junk/nothing.

**Suggested improvement:** when a hunt yields 0 folder candidates but loose per-track matches exist,
offer a "we found N individual tracks — grab them" fallback (reuse the existing per-track
`AlbumFallbackService.searchBestForTrack` machinery) instead of a pure dead-end.

### C2 — network results only appear at completion (Low/Med UX)
For niche queries the search holds at "Searching…" with **0 results for ~20 s even though peers
respond within ~5 s** (Los Chalchaleros: 19 responses at t+5 s, results materialized only at
t+25 s on `state: complete`). Popular queries complete in ~3 s, so the variance is wide.

**Improved (2026-06-15):** the pipeline already streams — the slskd provider's `pollResults` returns
`getResponses()` on every poll **during `InProgress`** (not gated on completion), and the web polls every
2 s and re-renders `setNetwork(...)` each time, so partial results *do* appear incrementally. The
residual gap is that for some niche queries slskd reports a rising `responseCount` while
`getResponses()` is still empty (file lists not yet aggregated) — a slskd-side delay we don't control.
To make that wait legible we now surface **"N peers responded"** (from `responseCount`,
`SearchService.networkResponseCount`) in the Searching indicator, so the user sees progress instead of a
dead spinner. Truly streaming the late files is bounded by slskd.

### C3 — sequential base→skew latency (Low) — already handled
The two-phase hunt is back-to-back (20 s + 22 s), but the **early-termination the finding asked for
already exists**: `AlbumHunterService.hunt()` runs skew **only when `bestBasePct < SKEW_TRIGGER_PCT`**,
so a confidently-complete base candidate skips the skew pass entirely (no second 22 s). Running base and
skew always-in-parallel would remove the conditional but **double** the slskd search load on every hunt
(and skew exists precisely as a soft-ban-bypass fallback, not a default) — a worse trade for a Low-sev
latency case. The live-progress two-phase endpoints (`huntBase`/`huntSkew`) already let the UI animate
each phase. No code change; assessed as handled.

---

## D. Library album deletion — residue bug (the reported issue)

**Reported:** delete *Live At The Rainbow Ballroom 1966* (The Jinx, genre Garage); afterwards a search
for "the jinx" still shows it, and clicking opens the album/artist with **no content**.

**Reproduced / root-caused (live DB + code):**

The target is a **loose single** — 1 track, `classification = single`, genre Garage, year 1966,
`album_id = b484c7f2…`, real folder `The Jinx/Live At The Rainbow Ballroom 1966/…mp3`. (It is
correctly absent from the Albums grid: singles never appear there — they live on the artist page.)

`DELETE /api/library/albums/:id` (`packages/api/src/routes/library.ts:337`) deletes the folder, then
synchronously runs:

```sql
DELETE FROM completed_downloads WHERE navidrome_id IN (…);
DELETE FROM library_songs  WHERE album_id = ?;
DELETE FROM library_albums WHERE id = ?;
```

It **never deletes the `library_artists` row** (nor `library_artwork`, nor recomputes
`library_genres`). When the deleted album was the artist's only release, the artist is orphaned:

- `library_artists` still holds **The Jinx** (`album_count = 1`, now stale) — verified live.
- **Search** (`services/providers/library-provider.ts`: `SELECT … FROM library_artists … WHERE name
  LIKE ?`) still returns the artist → "the jinx" still appears.
- **Artist page** (`GET /api/library/artists/:id:218`) reads the shell from `library_artists` (only
  404s if *that* row is gone) and the content from `library_albums`/`library_songs` (now empty) →
  returns `{ artist, albums: [], singlesAndEps: [] }` = "still there but no content."
- The orphan only clears on the next **full** scan — `persist(prune=true)` runs
  `DELETE FROM library_artists WHERE synced_at < ?` (`services/library-scanner.ts:650`). The
  synchronous delete and the DownloadWatcher's **incremental** scans never prune, so the orphan
  persists indefinitely between full scans.

### Suggested improved workflow (D1 fix)
In the delete handler, after removing the album + songs, clean up the now-orphaned aggregates in the
same transaction:

1. Delete the `library_artists` row **iff** it has no remaining albums/songs
   (`NOT EXISTS (SELECT 1 FROM library_albums WHERE artist_id = ?)` and same for `library_songs`);
   otherwise recompute its `album_count`.
2. Recompute/prune the affected `library_genres` entry the same way.
3. Delete `library_artwork` rows keyed on the album id (and the artist id if the artist is removed).

This makes deletion fully consistent immediately, matching the route's stated "single source of
truth, no async reconciliation needed" intent. A regression e2e (delete an artist's only release →
assert it's absent from `GET /api/search` *and* `GET /api/library/artists/:id` 404s) should cover it.

### D2 — secondary observations
- Two artist rows exist for the same act — **"The Jinx"** (`335115e1…`) and **"Jinx"**
  (`ad91978f…`), both `album_count = 1` — from "The"-prefix normalization splitting one artist into
  two. Worth a separate look at artist-name canonicalization.
- `library_album_tombstones` is populated historically (≈45 rows per `docs/usage-analysis-2026-06.md`)
  but the current delete path no longer writes it (`library.ts:397` comment: "no tombstone … needed").
  Either the table is dead and should be dropped, or deletion should keep it consistent.

---

## E. e2e / test-infra

### E1 — hunt modal has no stable selectors (Low, infra)
`album-hunt-modal.component.html` exposes `data-testid` only on the archive.org sub-section
(`archive-section`/`archive-item`/`archive-get`). Its **core controls have none**: the
Download / "Download best" button, the candidate rows, the per-query progress list, the Min-match /
Skew filters. Per the project's stated standard ("adding a `data-testid` is the standard for new
e2e-targeted elements"), the compliance-critical interactive hunt flow can't be driven by stable
selectors. Add testids before writing a hunt e2e.

### E2 — playground harness (✅ implemented 2026-06-14)
**Done.** The gated playground harness now drives search → catalog → hunt → network flows against a
**real-backend** instance (`E2E_BASE_URL` + `PLAYGROUND=1`) and writes an aggregated findings report
(`packages/e2e/playground-report/*.{md,json}`) via a custom reporter. Flows **record observations**
(timings, counts, gaps, enhancement signals, cover-art 404s) rather than asserting pass/fail, and
**degrade gracefully** when a backend is down (a `degraded` observation, never a red test). It stays
**out of the CI `e2e` job**; only its pure logic (`playground/{observe,report,net-monitor}.ts`) is
unit-tested in CI. Seeded with §F (song acquisition), §A (catalog quality), §C (hunt latency/outcome,
opt-in), §C2 (network responsiveness). → See [e2e.md](e2e.md) "Playground harness".

The first concrete use for this harness is the §F song-acquisition gap below: drive
`search "Toxic Britney Spears"` against the live stack and assert/observe that (a) the catalog lane
returns only album/EP cards (or nothing) for a song query, (b) **no song-acquire affordance exists**
pre-fix, and (c) post-Phase-1 a **Songs lane** offers a one-click best-version download. Gate behind
an env flag (e.g. `PLAYGROUND=1` + `E2E_BASE_URL`), kept out of the CI `e2e` job.

---

## F. Song/single acquisition gap — "find me one song" (2026-06-14)

**Reported:** Search is (correctly) the download entry point — a user who can't find a track in their
library goes to Search to acquire it. But when the user wants a single **song** (e.g. *"Toxic"* by
Britney Spears), the curated acquisition tools — catalog cards + the album-hunt modal — only operate
on **albums and EPs**. There is no first-class "find/acquire this song" path; the user is dropped into
raw Soulseek folder-browsing.

**Root cause (verified in code):** NicotinD's acquisition model is structurally **album-centric**.

- **Metadata lane is album-only.** `CatalogService.search()`
  (`packages/api/src/services/catalog-search.service.ts:61`) fires only `lidarr.artist.lookup` +
  `lidarr.album.lookup`. The Lidarr client exposes **no recording/track lookup** —
  `packages/lidarr-client/src/api/track.ts` only does `listByAlbum(albumId)` for an album *already*
  in Lidarr. So a song-level metadata search isn't possible through the existing client at all.
- **Hunt is album-keyed.** Every hunt route is
  `POST /api/discography/albums/:lidarrAlbumId/hunt[-download]`
  (`packages/api/src/routes/discography.ts`), scoring peer folders against a Lidarr canonical
  tracklist and requiring a real `lidarrAlbumId` from `catalog/resolve`. A single song has no handle.
- **The only song-level path is the raw Soulseek fallback.** `SlskdSearchProvider.pollResults`
  (`packages/api/src/services/providers/slskd-provider.ts`) returns individual files; the web groups
  them by `username::directory` (`packages/web/src/app/lib/folder-utils.ts`) with per-file Download
  buttons (`packages/web/src/app/pages/search/search.component.ts`). Functional, but manual: no
  dedupe across peers, no best-version pick, no scoring, no skew/cross-peer robustness — the user
  eyeballs up to ~250 files (per the §C benchmarks) and picks one.
- **Local "Songs" results** (`packages/api/src/services/providers/library-provider.ts`) only show
  tracks already owned — by definition no acquire affordance.

So "Toxic" either surfaces as a catalog **album** card *only if* MusicBrainz/Lidarr happens to carry
it as a standalone single release-group **and** it's in the artist's Lidarr discography (rare, and
`resolve` often 404s per §A2), or it drops to raw network file-picking with zero curation.

> Benchmarks for this section are **deferred — needs a live backend** (consistent with C1/C2/C3).

### F1 — Song-first network lane (✅ implemented 2026-06-14)
Network results were **folder-first**: a user hunting one song had to expand peer folders and pick a
file by hand out of up to ~250 results, with no help choosing the best copy.

**Done.** The search page now defaults the network results to a **Songs lane** (toggle:
Songs ↔ Folders). Pure logic in `packages/web/src/app/lib/song-results.ts` (`groupBySong`,
unit-tested) dedupes the flat slskd file list by normalized `(artist, title)`, auto-picks the best
copy (**FLAC > other lossless > highest-bitrate lossy**, then peer availability: free slot → shorter
queue → faster upload → larger size), and orders rows by query relevance. One click downloads the
best copy via the existing `enqueueDownload`/`handleDownload`; status (queued/↓%/done) reuses
`download-status.ts`. The folder view is preserved for whole-album grabs. The playground §F flow now
asserts the lane (`data-testid="network-view-songs"`/`song-result`) instead of recording the gap.

### F2 — No track hunter (Medium)
The album hunt's robustness — skew-query soft-ban bypass, cross-peer fallback, auto-retry — has **no
per-track equivalent** surfaced to the user.

**Suggested improvement (Phase 2 — "hunter later"):** a `TrackHunterService` reusing
`AlbumFallbackService.searchBestForTrack`, fired with focused `"Artist Title"` queries + best-single
selection + a single enqueued file. Wire it into **both** the Songs lane (a robust "grab" beyond the
plain dedupe) **and** the album-hunt 0-candidate dead-end — this directly addresses the deferred
**C1** (offer "we found N loose tracks — grab them" when a folder hunt finds nothing).

### F3 — UI affordance + e2e gap (Low, infra)
There is no UI entry point or `data-testid` for song acquisition, and the CI suite runs external-mode
with a dead slskd, so song acquisition can't be exercised there. Covered by the **§E2** gated
live-backend playground spec (drives the "Toxic" search; asserts the gap pre-fix and the Songs lane
post-Phase-1).

---

## G. Mobile UX review (2026-06-15)

Screen-by-screen review on a **Pixel 7** viewport (412×915) against the committed fixture library
(silent FLACs, **no embedded cover art** — so a gradient "E" tile means the fallback *works*; a
broken-image glyph means it *doesn't*). Captured by `playwright.screenshots.config.ts` +
`tests/mobile-screenshots.screens.ts` (`bunx playwright test --config=playwright.screenshots.config.ts`
→ `screenshots/mobile/01–06`). Ordered by severity.

### G1 — Album-detail Play button clipped off-screen (High, bug)
`album-detail.component.html` puts **six** controls — Play, Select, Download, Share, Optimize metadata,
Remove album — in a single `flex justify-center gap-3` row with **no `flex-wrap`**. On a phone they
overflow both edges and centering pushes the **primary Play button partly off the left margin**.
Admin power-actions (greyed "Optimize metadata", bare-red "Remove album") also get equal/greater visual
weight than playback, and destructive delete sits one mis-tap away in the same row.

**Fixed (2026-06-15):** the action row is now `flex flex-wrap` so the buttons wrap instead of
clipping, and **Play is an accent-filled primary button** (`bg-theme-accent text-white`) distinct from
the neutral-secondary Select/Download/Share. With wrap, the admin actions (Optimize metadata / Remove
album) fall to a second line — a pragmatic demotion below the primary row; `removeAlbum` already routes
through the confirm dialog. A dedicated overflow `⋯` menu remains a possible polish but is no longer
needed to stop the clip. *Test:* `mobile-ux.spec.ts` asserts `play-album`'s box is within `[0, 412]` at
a Pixel-7 width (CI chromium project).

### G2 — Now Playing cover + queue render broken-image glyphs (High, bug)
The Now Playing hero cover and every "Next Up" queue thumbnail use a **raw `<img [src]="/api/cover/…">`**
(`now-playing.component.html`) that shows the browser's broken-image icon when art is missing — instead
of the `app-cover-art` gradient fallback used in the Albums grid and the mini-player. Ugly, inconsistent
degradation, and it collapses the hero box (feeding G4's layout void).

**Fixed (2026-06-15):** the hero cover and the queue thumbnails now render via `app-cover-art`, which
swaps a 404/missing cover for the on-theme gradient tile + initial (same as the grid and mini-player).
*Test:* `mobile-ux.spec.ts` opens Now Playing and asserts the hero (`data-testid="now-playing-cover"`)
has **no `<img>`** (it errored → gradient div) and shows the album initial. Bonus: with the hero filling
its box again, most of G4's vertical void is gone.

### G3 — Track-info sheet shows no song identity (High, UX)
Opened from Now Playing (title long-press → "Track info"), the sheet header is a generic **"Track
info"** with **no title / artist / album** anywhere, and the entire "File" block (path/format/bitrate/
size) is also missing. Root cause: Now Playing mounts `<app-track-info-sheet [songId]=…>` **without** the
optional `[song]` input (`track-info-sheet.component.ts`: `song = input<Song | null>(null)`), so
`song()` is null → the `@if (song(); as s)` block is skipped. You get three empty meta sections
("Source not recorded", BPM/Genre Unknown, "No processing history") and no idea which track it is.

**Fixed (2026-06-15):** the sheet now renders an **always-on identity header** (cover thumb + title +
artist + album) just under the "Track info" title. It prefers the full `Song` when present, and
otherwise reads four lightweight display inputs (`displayTitle`/`displayArtist`/`displayAlbum`/
`displayCoverArt`) that the player passes from the current `Track` — so identity shows even though no
library `Song` is handed in (the sheet is, in practice, only ever opened from the player). The cover
uses `app-cover-art` for the same gradient fallback. *Test:* `mobile-ux.spec.ts` opens the sheet from
Now Playing and asserts `track-info-identity` shows the track title + artist (CI chromium).
(The deeper "File" block — path/format/size — still needs a real `Song`; a `GET /library/songs/:id`
endpoint to self-resolve it is a possible follow-up, but identity — the actual gap — is fixed.)

### G4 — Now Playing vertical void + hidden Track-info affordance (Medium, UX)
Layout pins a small cover to the top and floats the title to vertical center, leaving a large empty gap
(worsened by G2's collapse). Track info is reachable **only** via long-press/right-click on the title —
no visible `⋯`, so it's effectively undiscoverable on mobile.

**Fixed (2026-06-15):** G2 restored the hero to its full box, which closes most of the void; and a
visible `ⓘ` button (`data-testid="now-playing-info"`) now sits beside the title and opens the track-info
sheet on a single tap — the long-press context menu still works for power users. *Test:* `mobile-ux.spec.ts`
clicks the visible button and asserts the sheet opens with the track identity.

### G5 — Mini-player hairline progress + content occlusion (Medium, UX)
The mini-player progress is a ~1px line at the very bottom edge (easy to miss, doesn't read as
interactive), and both the mini-player and the bottom tab bar **occlude list content** — the album
tracklist's last row is cut because Library/Album pages reserve no bottom scroll padding for the player
chrome.

**Assessed (2026-06-15) — already handled, finding overstated.** Reading the code: the mini-player seek
is `app-seek-bar`, a native range styled as a **20px touch target** (`.seek-range` height `1.25rem`)
with a **4px** visible track + **12px** thumb — not a 1px hairline; it only *looked* faint in the
screenshot because the bar was at ~4% (the low-contrast `--theme-surface-2` empty track dominates at low
progress). And occlusion is already solved by `mainBottomPadClass` (`lib/player-chrome.ts`), which pads
`<main>` `pb-[8rem]` on mobile (tab bar + mini-player) whenever a track is loaded, so the last list row
clears the chrome. No code change made — fabricating one for a non-issue would be churn. (A possible
*nice-to-have*: a higher-contrast empty-track token in the mini context, but it's shared with Now Playing
where it reads fine.)

### G6 — Title context menu overflows the viewport (Medium, UX)
The Now Playing title context menu is positioned at the tap's X coordinate with no viewport clamping, so
on mobile it extends past the right edge and its labels ("Search more by artist", "Track info") are
clipped.

**Fixed (2026-06-15):** `clampMenuPosition` (`lib/menu-position.ts`) keeps the menu's top-left within
the viewport (margin from every edge), and the menu gains a `max-w-[calc(100vw-1rem)]` guard. The
context-menu component clamps `position()` against `window.inner{Width,Height}` via a computed. *Test:*
`menu-position.spec.ts` covers right/bottom-edge clamping, the top-left floor, and custom menu sizes.

### G7 — Library list polish (Low, UX)
A **stray, unlabeled low-contrast "1"** sits far-right on the Filters row (it's the album count, but
reads as a glitch), and the 5-tab segmented control (Albums/Singles/Artists/Genre/Playlists) crowds the
screen edges at 412px.

**Fixed (2026-06-15):** the count now renders "`{n} album`/`albums`" (`data-testid="library-album-count"`)
instead of a bare number, and the mode tabs get tighter mobile padding (`px-3 sm:px-4`) +
`overflow-x-auto` with `shrink-0 whitespace-nowrap` buttons, so they scroll rather than crowd/clip on a
narrow phone. *Test:* `mobile-ux.spec.ts` asserts the count reads "1 album".
