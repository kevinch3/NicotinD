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

A first PR (`fix/playground-findings-2026-06`) implements **D1, A2, A3, B1, B2** with tests. The
remaining items (**A1, C1, C2, C3, A4, D2, E1**) are deferred — they change search semantics or are
larger/design-sensitive and warrant their own review. ✅ = fixed in that PR; ◻️ = open follow-up.

## TL;DR — prioritized follow-ups

| # | Status | Severity | Area | Issue |
|---|--------|----------|------|-------|
| D1 | ✅ | **High (bug)** | Library | Album delete orphans the `library_artists` row → deleted artist still shows in search & opens an empty artist page until the next *full* scan |
| A2 | ✅ | **High (bug)** | Catalog | `catalog/resolve` 500s ("not yet available in Lidarr") for a subset of returned album cards — clicking a valid-looking result errors |
| A1 | ◻️ | High (UX) | Catalog | Album cards are a global title search disjoint from the matched artist → for non-distinctive names (Falsa Cubana, Zara Larsson) the cards are entirely wrong/irrelevant |
| C1 | ◻️ | Medium (UX) | Hunt | 42 s wait → "No candidates" with **no fallback** to the loose tracks that demonstrably exist on Soulseek |
| B1 | ✅ | Medium | archive.org | Low precision (radio shows / mixtapes) — query lacks phrase quoting + `creator:`/`title:` targeting |
| B2 | ✅ | Medium | archive.org | Erratic recall + silent failure: same query returned 0 then 20 results within a minute; non-OK responses collapse to `[]` |
| C2 | ◻️ | Low/Med (UX) | Search | Network results only surface at *completion* (~25 s for niche queries) though peers respond in ~5 s |
| A3 | ✅ | Low | Catalog | Bogus `year` (`0001`) rendered verbatim on album cards |
| A4 | ◻️ | Low | Catalog | Artist pills are noisy/duplicated ("Zara/ZarA/Zara…", "Los/King Los…") |
| E1 | ◻️ | Low (infra) | e2e | Hunt modal lacks `data-testid`s on its core controls — violates the project's e2e selector standard |
| D2 | ◻️ | Low | Library | Duplicate artist rows from "The"-prefix handling ("The Jinx" + "Jinx"); `library_album_tombstones` is populated historically but no longer written by the delete path |

**Fix notes:** D1 — delete handler now prunes orphaned `library_artists`/`library_genres`/
`library_artwork` in the same transaction. A2 — `resolveAlbum` falls back to a diacritic-insensitive
title match and throws a typed `404` (`ALBUM_NOT_IN_LIDARR`) instead of `500`. A3 — placeholder years
(`< 1900`) dropped at mapping. B1 — archive queries are field-targeted + phrase-quoted. B2 — archive
service retries once and throws `ServiceUnavailableError` (route `503`) so upstream failure ≠ empty.

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
t+25 s on `state: complete`). Popular queries complete in ~3 s, so the variance is wide. Consider
streaming partial results as responses arrive rather than gating on completion.

### C3 — sequential base→skew latency (Low)
The two-phase hunt is back-to-back (20 s + 22 s). The split exists for live per-query UI animation,
but the worst case is ~45 s of waiting; investigate overlapping or early-terminating once a
confidently-complete base candidate appears.

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

### E2 — recommended playground harness (follow-up)
A Playwright spec that drives search → catalog → hunt against a **real-backend** instance
(`E2E_BASE_URL` pointed at a stack with slskd/Lidarr) would let these flows be exercised
interactively. It must stay **out of the CI `e2e` job** (CI runs acquisition default-off with dead
slskd/Lidarr) — gate it behind an env flag so it only runs against a live playground.
