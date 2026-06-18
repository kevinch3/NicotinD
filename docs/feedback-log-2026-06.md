# Real-use feedback log — June 2026

**Period:** 2026-06-12 → 2026-06-18 (rolling 7-day window)
**Purpose:** Capture issues and friction observed while actually *using* NicotinD (not synthetic tests), so we can see whether recurring pain clusters in a few flows — the signal for "is this tool actually useful day to day?". One entry per observation; route each to a fix (PR/workstream) or an existing finding (`docs/e2e-playground-findings-2026-06.md` §A–§H).

> How to use this log: add a dated bullet whenever something annoys you in real use — even small. Tag **Severity** (High/Medium/Low) and **Status** (◻️ open / ◑ partial / ✅ fixed). When a theme repeats across days, it's a prioritization signal. Rotate monthly (`feedback-log-YYYY-MM.md`); link recurring items to the findings doc.

---

## TL;DR (this window)

| # | Status | Severity | Flow | Issue |
|---|--------|----------|------|-------|
| 1 | ✅ | Medium | Search / Player | Artist click went to `/library` for network-played tracks instead of the artist page |
| 2 | ✅ | High | Library / Metadata | Known band stored as `<Desconocido>`; "optimize/fix metadata" found nothing (poisoned query) |
| 3 | ✅ | High | Hunt / Discovery | Best-of / compilations dead-ended: "isn't in <artist>'s Lidarr discography yet" |
| 4 | ✅ | Medium | Acquire (archive.org) | "From archive.org" returned junk (audiobooks/ICP/mashups); couldn't tell album vs single |
| 5 | ◻️ | — | Meta | Want a standing place to record real-use friction → **this log** |

**Read of the week:** friction clustered in **acquisition/discovery** (items 2–4) — the metadata→hunt→fallback path. The catalog-driven happy path works, but **edge releases** (wrong tags, compilations, archive.org) were where the tool felt unfinished. All four were addressable; none were fundamental. Net: the tool *is* useful, and the rough edges are concentrated and fixable rather than spread thin.

---

## Day-by-day

### 2026-06-18

- **(High) `<Desconocido>` artist can't be self-fixed.** *Use:* La Portuaria's album showed artist `<Desconocido>` with the wrong cover. "Optimize metadata" replied *"Could not optimize — no Lidarr match or Lidarr unavailable"* even though La Portuaria is a well-known band. *Root cause:* the fix/optimize query defaulted to `"<Desconocido> Selva"` — a poisoned query a real band never matches. *Wanted:* a user-driven fix, not a manual DB edit. **✅ Fixed:** placeholder artists (`isPlaceholderArtist`) are dropped from the default query (searches `"Selva"`, which surfaces La Portuaria); the modal shows an amber hint prompting the real artist; bulk optimize skips placeholder albums instead of failing silently. → metadata-fix WS, `docs/metadata-optimize.md`.

- **(High) Hunt dead-ends on compilations.** *Use:* tried to grab "The Best of Shaggy", "Grandes éxitos" (Bacilos), "Trueno: Bzrp Freestyle Sessions, Vol. 6" (Bizarrap) from the catalog — each errored *"isn't in <artist>'s Lidarr discography yet"*. These exist globally but aren't in the artist's Lidarr discography even after the artist is added. **✅ Fixed:** on `ALBUM_NOT_IN_LIDARR` the search **auto-falls back to a raw Soulseek search** for `"<artist> <album>"` and opens the network lane with downloadable folder candidates (blue note explains the switch) instead of dead-ending. → album-hunt WS, `docs/album-hunt.md`.

- **(Medium) "From archive.org" is noisy and ambiguous.** *Use:* a "Shaggy" search returned "Shaggy Man to the Rescue", a "Patchwork Girl of Oz" LibriVox audiobook, "A Prickly Shaggy Story", an ICP single — and there was no way to tell whether an item was an album or a single (worry: acquiring would scatter a bunch of EPs). **✅ Fixed:** broadened the non-music collection deny-list (audiobooks umbrella, radio, live-tape archives), added a per-item track-count + album/single chip (`creator · year · N tracks · album/single`), and drop items proven to have no audio. Each item still maps to exactly one album folder, so no EP scatter. → archive WS, findings §B.

- **(Medium) Artist link goes to `/library`.** *Use:* played a track from search and from the player, tapped the artist name — landed on `/library` instead of the artist page. *Root cause:* network-result tracks carry no `artistId`. **✅ Fixed:** the link now resolves by **name** (`GET /api/library/artists/by-name`) — artist page when they exist locally, else `/library` unchanged. → search/player WS.

### 2026-06-12 … 2026-06-17

- *(Carried in from the playground findings of this window — see `docs/e2e-playground-findings-2026-06.md`.)* archive.org low precision (§B1) and erratic recall (§B2); catalog card/discography gaps (§A); per-track and cross-peer hunt fallbacks (§C/§F). These are the same discovery/acquire cluster items 2–4 above sharpen.

---

## Aggregated themes (window total)

| Theme | Count | Severity | Related |
|-------|-------|----------|---------|
| Discovery/acquire edge releases (bad tags, comps, archive) | 3 | High–Medium | items 2,3,4; findings §A/§B |
| Navigation niceties (artist link) | 1 | Medium | item 1 |

## Next steps / watch-list

- Re-check the **same three flows** next week with fresh real searches; if discovery/acquire keeps generating High-severity items, it's the area to invest in further (e.g. on-demand "add this exact release to Lidarr").
- Keep logging: the value of this file is the *trend*, not any single entry.
