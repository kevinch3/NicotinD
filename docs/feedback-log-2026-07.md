# Real-use feedback log — July 2026

**Period:** 2026-07-01 → (rolling)
**Purpose:** Capture issues and friction observed while actually *using* NicotinD (not synthetic tests). One entry per observation; route each to a fix (PR/workstream) or an existing finding. Previous window: [feedback-log-2026-06.md](feedback-log-2026-06.md).

> How to use this log: add a dated bullet whenever something annoys you in real use — even small. Tag **Severity** (High/Medium/Low) and **Status** (◻️ open / ◑ partial / ✅ fixed). When a theme repeats across days, it's a prioritization signal. Rotate monthly (`feedback-log-YYYY-MM.md`).

---

## TL;DR (this window)

| # | Status | Severity | Flow | Issue |
|---|--------|----------|------|-------|
| 1 | ✅ | High | Player (Firefox) | Tracks intermittently never play — third distinct root cause (self-aborting load-effect loop) after the Content-Length and ngsw-bypass fixes |
| 2 | ✅ | High | Download pipeline / Player | ALAC-in-.m4a bypassed the lossless→Opus standardization (extension-based detection) — undecodable in any browser when transcoding is off |
| 3 | ◑ | Medium | Library metadata / filters | BPM values wrong by an octave (half/double) on ~50% of a spot-check sample — music-tempo detector; fix shipped (Essentia sidecar-first), prod backfill pending |
| 4 | ✅ | Medium | Song lists (mobile) | Track-row `⋯` context menu near the end of a list opened *under* the mini-player/tab bar — only partially visible/tappable |
| 5 | ✅ | Medium | Library Songs tab (mobile) | Toolbar (search + sort + Filters + Select) didn't wrap; its combined width forced a horizontal scroll that shifted/clipped the whole page |
| 6 | ✅ | Medium | Search + Library integrity | "All tracks are present" but no album card — three independent causes (search-page UX gap, fragmented artist spellings, classification-hidden rows) |

---

## Day-by-day

### 2026-07-07

- **(High) Firefox: some tracks never play — again, after two same-day fixes.** *Use:* on Firefox for Mac, "TIEMPO OFF" and "LABIOS APILADOS" (CUERPOS, Vol. 1) alternated pause icon/spinner forever while the rest of the album played; felt tied to "OPUS transcoded files". *Root cause (third, distinct from PR #87's Content-Length and PR #88's ngsw-bypass):* `setBuffering(true)`'s guard read `bufferingVisible()` inside PlayerComponent's track-load effect, silently subscribing the effect to the 250 ms spinner timer — any load slower than 250 ms to first byte (fresh ffmpeg transcode ≈ 4 s, proxy latency) re-ran the effect, re-assigned `audio.src`, and aborted its own request in a ~300 ms loop. Not the codec: the *fresh-transcode latency* was the trigger, which is why cached tracks played. Diagnosed by instrumenting `HTMLMediaElement` in Playwright Firefox against prod. **✅ Fixed:** `untracked()` around the guard read + regression test; verified master-vs-fix behind a 900 ms delay proxy. → `docs/web-ui.md` (bug #3).

  *Lesson for the log:* three "Firefox never plays" bugs shipped/manifested within one day of the loading-feedback feature. When a symptom recurs after a fix, treat it as a *new* root cause until proven otherwise — all three had different mechanisms (response headers, service worker, signal graph).

- **(High) "Spread This Number" (Matias Aguayo): `NS_ERROR_DOM_MEDIA_METADATA_ERR` in Firefox.** *Use:* right after the effect-loop fix deployed, this track errored with "media resource couldn't be decoded". *Root cause:* the file is **ALAC in an .m4a container** (~883 kbps Apple Lossless). `isLossless()` is extension-based and its `alac` entry never matches real files (ALAC ships as `.m4a`, same as lossy AAC), so the lossless→Opus ingest standardization skipped it. No browser decodes ALAC; it only ever played because forceTranscode was on — turning the transcode master switch off (during today's debugging) exposed it. Library sweep found **63 ALAC files across 8 albums** (Fred again, Jamiroquai, Bandana, Calamaro, BVSC, BEP, Eiffel 65). **✅ Fixed:** codec-aware `isLosslessFile()` (music-metadata `format.lossless` probe for .m4a-family) wired into both the ingest hook and the existing-library migration; backfill = one `transcode-library` pass. → `docs/download-pipeline.md`.

### 2026-07-11

- **(Medium) BPM wrongly calculated — octave errors both ways.** *Use:* filtering artists by `bpmMax=80` surfaced AC/DC "Shoot to Thrill" at 73 BPM when the real tempo is ~141. *Root cause:* the `music-tempo` detector's agent-based beat tracker prefers half- or double-tempo lock-ins even when its own tempo-induction top hypothesis is right (for this file: hypothesis 141.3, chosen agent 72.6). A random 8-track prod sample showed **4/8 stored BPMs off by 2×, in both directions** (stored 178 vs real ~89, stored 186 vs ~93…), so no one-direction bun-side heuristic can repair it. The wrong values were also written to file tags. **◑ Fixed in code:** sidecar `POST /rhythm` (Essentia RhythmExtractor2013, matched every confident spot-check) now preferred by the bpm task + on-demand analyze; `analyze-bpm.ts --recheck` repairs stored values (tag-ignoring, confidence-gated). **Pending:** run the recheck backfill on prod after deploy. *Also evaluated:* time-signature storage — rejected; Essentia's `Meter` gave 2.0 for 4/4 and 12.0 for 6/8 (needs downbeat tracking to do properly). → `docs/audio-ml-enrichment.md`, `docs/library-processing.md`.

### 2026-07-14

- **(Medium) One album hunt still shows as 5 separate download cards.** *Use:* right after the unified acquisition-jobs deploy (PR #132), a "Los Chalchaleros" hunt rendered five Active-feed entries — the user expected one card with all the queues. *Root cause:* the jobs shipped stored transfer↔job linkage and per-row stage upgrades, but the web feed still built **one row per slskd peer folder** (`groupByAlbum` keys on `username:directory`); multi-peer hunts, CD1/CD2 subfolders and alternate-peer fallback pulls each got their own row, and the merge only upgraded a single matching row's stage. **✅ Fixed:** `collapseAlbumMembers` in `mergeAcquisitionJobs` folds every folder group sharing an `albumId` into one card (progress from the job's item tallies, most-active member's stage, actions fan out via `memberKeys`). Pre-deploy transfers have no job rows and stay per-folder until cleared (one-time). → `docs/acquisition-jobs.md`.

### 2026-07-17

- **(Medium) Mobile: track-row context menu hidden behind the player.** *Use:* on Android, opening the `⋯` menu on one of the lower track rows (a long Tangerine Dream list) showed the menu clipped under the mini-player + bottom tab bar — the bottom actions weren't visible or tappable. *Root cause:* `TrackRowComponent`'s menu was a hand-rolled `absolute right-0 top-7` panel — it always opened downward and neither clamped to the viewport nor reserved the fixed bottom chrome, so a low-on-list trigger dropped the menu straight behind the player. *Fix:* routed the row menu through the existing `MenuPanelComponent` (fixed-position, flip-above, viewport-clamp) and taught that positioner about the bottom chrome — a `bottomInset` in `computeMenuPosition`/`clampMenuPosition`, measured at open time from the live rects of the two `data-bottom-chrome` layers via the pure `bottomChromeInset` (`lib/player-chrome.ts`). The panel now flips up / clamps above the player instead of behind it, and every `MenuPanelComponent` popup (filters, "View N albums") gets the same guard for free. **✅ Fixed:** pure-math unit tests + a `mobile-ux` e2e asserting the opened menu's box clears the chrome. → `docs/design-patterns.md` ("Viewport-safe dropdown menus", "Bottom-chrome stacking").

- **(Medium) Mobile: Library Songs tab toolbar overflowed and broke the page in both axes.** *Use:* on the Songs tab the controls row (search + "Recently added" sort + Filters + Select) ran off the right edge; the overflow pushed a horizontal scroll that shifted the header ("NicotinD" clipped to "D") and the mode tabs. *Root cause:* the Songs toolbar was `flex items-center gap-2` with no `flex-wrap`, so search (`min-w-[10rem]`) + three controls exceeded the phone width — every other library tab's toolbar already wraps (`flex flex-wrap`). *Fix:* added `flex-wrap` so the controls stack onto a second row instead of overflowing. **✅ Fixed:** `mobile-ux` e2e asserting no horizontal page overflow on the Songs tab at phone width. → `docs/web-ui.md` (Library "Songs" tab).

- **(Medium) "C. Tangana Ídolo" — tracks present but no album card surfaces in search.** *Use:* hunting the album hit "all tracks are already present"; searching for it returned individual Songs in the unified-search pane but **no album card anywhere on the page**, so the user couldn't navigate to the release. *Root cause:* **three independent defects**, none of which the search page or any single page exposed: (a) **search-page UX gap** — `LibrarySearchProvider.search()` always returned `local.albums[]` from `library_albums` but the web's `/search` page only bound `local.songs[]` and rendered Albums from the Lidarr `catalog()` lane (hidden entirely for `listener` role); (b) **fragmented artist spellings** — Soulseek rips of this album tagged `albumArtist` as "C. Tangana" / "C. Tangana, Nathy Peluso" / "C.Tangana" across tracks, minting distinct `artistIdFor` ids and thus distinct `library_albums` rows for one release (`normalizeArtistForGrouping` strips diacritics+case but **preserves punctuation**, so "C. Tangana" ≠ "C.Tangana"); (c) **classification-hidden rows** — a real album the curator classified as `'single'` or `'ep'` is invisible to the default Albums grid (`classification = 'album'`) and to `/search`. *Fix:* (a) search page now owns a `libraryAlbums` signal populated from `res.local?.albums` with a new "In your library" section above Songs, visible to every role (`LibrarySearchProvider` also raises LIMIT 10→20 and selects `classification` + `song_count` so the section can render EPs); (b)+(c) new `services/library-fragments.ts` (`detectDuplicateAlbums` groups by `normalizeForGrouping(album)` and lists artist spellings, `detectHiddenByClassification` lists non-`album` rows) wired through `GET /api/library/fragments` (admin), the Admin panel "Check fragmentation" button, and `scripts/check-fragments.ts` (CLI gate, exits non-zero on any defect). One diagnostic surface covers both — fixes are documented in-place ("alias these spellings then rescan", "reclassify or unhide this row"). **✅ Fixed:** 11 new unit tests (`library-fragments.test.ts`), 3 new route tests (`library.test.ts`), 3 new search/admin spec assertions. → `docs/library-scanner.md` "Fragmentation diagnostic".

---

## Aggregated themes (window total)

| Theme | Count | Severity | Related |
|-------|-------|----------|---------|
| Playback reliability (Firefox) | 2 | High | items 1–2; web-ui.md bugs #1–#3 |

## Next steps / watch-list

- After deploy, re-test the two named tracks on Firefox for Mac *through the public URL* (the localhost path never reproduced it).
- Watch for any further "never plays" reports — if a fourth appears, audit every `PlayerService` setter for tracked reads (the constraint is now documented in web-ui.md).
