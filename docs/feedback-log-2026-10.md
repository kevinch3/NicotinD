# Real-use feedback log — October 2026

**Period:** 2026-10-01 → (rolling)
**Purpose:** Capture issues and friction observed while actually _using_ NicotinD (not synthetic tests). One entry per observation; route each to a fix (PR/workstream) or an existing finding. Previous window: [feedback-log-2026-08.md](feedback-log-2026-08.md).

> How to use this log: add a dated bullet whenever something annoys you in real use — even small. Tag **Severity** (High/Medium/Low) and **Status** (◻️ open / ◑ partial / ✅ fixed). When a theme repeats across days, it's a prioritization signal. Rotate monthly (`feedback-log-YYYY-MM.md`).

---

## TL;DR (this window)

| #   | Status | Severity | Flow              | Issue                                                                     |
| --- | ------ | -------- | ----------------- | ------------------------------------------------------------------------- |
| 1   | ✅     | High     | Get album         | One album downloaded twice through two lanes → two library albums (#1539)  |
| 2   | ✅     | High     | Catalog search    | Every catalog cover 401s — no media token on `/api/cover/remote` (#1536)   |
| 3   | ◑      | High     | Acquire results   | Results are alphabetical; the score never sees the query (#1537)           |
| 4   | ✅     | High     | Catalog search    | Album grid is Lidarr's lookup, not what the provider has (#1538)           |
| 5   | ◑      | High     | Folder grab       | One card, every file twice, "14 of 28 · 14 unavailable" (#1540)           |
| 6   | ✅     | Medium   | One-click Get     | Silent 400; missable countdown toast; card label lags the stage (#1543)    |
| 7   | ✅     | Medium   | Folders view      | A mixed grab-bag folder ranks first wearing a FLAC badge (#1541)           |
| 8   | ◑      | Medium   | Acquire actions   | No icons, hover-only star, unconfirmed Download all, Cancel/Remove (#1542) |
| 9   | ✅     | Low      | Add / Activity    | Half-restored tab state, premature "Added to library" (#1544)              |

---

## Entries

### 2026-10-23

Walkthrough on prod (v0.8.113, user `claude-e2e`): find and download albums of **Damian Lazarus** and
**Christian Löffler**, with the goal of showing only what the provider (Soulseek) can deliver.
Downloaded: *Smoke the Monster Out*, *Message From The Other Side* (twice — see below), *Young
Alaska*, *Mare*. All landed.

- **(High) The same album downloaded twice, and the library now holds two copies.** _Use:_ a
  **Download folder** on the FLAC *Message From The Other Side* folder read "Queued", while the
  catalog card for the same album right above stayed idle; one click on it auto-hunted a different
  peer's **MP3** and queued 14 more. Both landed: `Message From the Other Side` (mp3 320) and
  `Damian Lazarus & The Ancient Moons - Message From The Other Side [2015]` (opus). _Cause:_ the Get
  lanes key "busy" three different ways — `lidarrAlbumId` for the guided card, `username:filename`
  in tab memory for folder/file grabs, the link for URLs — and only the guided lane has a core
  duplicate guard. **◻️ Open** (#1539): one album identity (`albumGroupKey`, the key the scanner hashes
  into the landed album id), one reserve-then-call guard, one job-feed-derived status, one Get control.
- **(High) Every catalog album cover is a letter placeholder.** 5/5 `/api/cover/remote` → 401: the
  proxied URL carries no `token`, and an `<img>` never sends the interceptor's header. Library covers
  have always appended `mediaToken()`. **◻️ Open** (#1536).
- **(High) Results for "Damian Lazarus" start with `[untitled]` by Kassem Mosse.** The candidate score
  is lossless + free slot only, so every FLAC row ties and the title tiebreak sorts the list
  alphabetically. Also: rows with no artist, the same track three times (case/prefix variants), "The"
  highlighted in every title. **◻️ Open** (#1537).
- **(High) The album grid shows the catalog's guess, not the provider's stock.** Joining the network
  result already in memory against the cards: 5 of 6 Lazarus cards have peers (*Neverending* has none,
  same look); Löffler's grid is 8 early EPs/singles while peers hold *Mare* (20 folders), *A Life*,
  *Lys*, *Until We Meet Again*, *Graal*. *Mare* only appears when typed into the query. The Library
  artist page shows a second, different discography — also without *Mare*. **◻️ Open** (#1538): dim
  catalog albums no peer holds ("Not on Soulseek"), add folder-derived cards for provider-only albums,
  count collaborations.
- **(High) One folder click → one card that lists every file twice.** "Done · 14 of 28 · 14
  unavailable" for a complete album, artist "Elektronika" (a genre folder), items shown as raw peer
  paths, album filed under the folder name. **◻️ Open** (#1540) — the one-card flip side of August's
  twin-rows entry.
- **(Medium) The first one-click Get failed silently.** `hunt-download` 400 and the card went back to
  idle with nothing on screen; the retry a minute later was 201. The "Best match found — downloading
  in 3s" toast that decides the peer and format never names either, and the card reads "Finding…"
  while the download is already being enqueued. **✅ Fixed** (#1543): the error toast stays until
  dismissed (the 400 itself was shown, for 4 s; its cause is gone with the container's logs); the
  countdown names format, track count and peer; the card reads "Starting download…" during the
  enqueue and shows n/m progress once the job exists (#1552).
- **(Medium) The first folder for "Christian Löffler" is `Trip-Hop`**, a 50-file, mostly-128 kbps
  grab-bag with 0 slots, badged **FLAC** because one file is. **✅ Fixed** (#1541): the badge
  is the majority format (#1554), and `rankFolders` puts album-shaped folders ahead of grab-bags
  (`isGrabBagFolder`: over 40 tracks, or mostly unnumbered files).
- **(Medium) Action affordances.** Text-only Get / Download / Download folder; the watch star only on
  hover; "Download all (2339)" with no confirm; the cancel dialog asks "Cancel this download?" with
  buttons **Cancel** and **Remove**. **✅ Fixed** (#1542): one verb, **Get**, with the `download`
  icon on every Add-page grab; the star shows under `(hover: none)`; "Download all" confirms with the
  file count, peers and size; the cancel dialogs answer **Stop download** / **Keep downloading**.
- **(Low) Polish.** Add tab returns with Results but without the album cards; "Added to library ✓" on
  rows that were only queued; four spellings of the tab param. **✅ Fixed** (#1544):
  - The album cards live on `SearchService`, so the tab restores them.
  - Rows say **Queued ✓** / **Downloaded ✓**, never "in the library".
  - The app's own links write `add`/`activity`.
  - "Choose a folder" reads "Upload a folder from this device", with the drop hint on hover.
  - The artist header reads "N albums in your library" beside the MusicBrainz strip.
  - Found on the way: every search ran the logout wipe, emptying the history dropdown and the
    persisted folder marks. `SearchService.resetResults()` is the per-search reset now (#1563).

_What worked:_ per-album hunt status (one card busy never blocks another), the guided Get landing
*Smoke the Monster Out* 13/13 in ~2 minutes, and the Library artist page — real covers and a
per-release complete/partial/missing strip — which is the presentation the Add grid should reuse.

_Status (same day, later):_ shipped in v0.8.115 or the PR after it.
- **Fixed:** covers (#1546); one album = one download across lanes, with server guard + shared web
  status (#1549, #1552; a near-simultaneous two-lane race is documented as still possible);
  availability + provider-only cards (#1538).
- **Partial:**
  - Results ranking (#1548): the subtitle path fallback and stop-word highlighting are still open.
  - Folder-grab card (#1549): named from the folder now ("Elektronika" gone), but the doubled items
    remain (#1540).
  - Card labels (#1552): show stage + progress now, but the silent 400 and the missable toast
    remain (#1543).
  - Folder badge (#1538 PR): majority-based now; grab-bags rank below album folders since
    `isGrabBagFolder` (#1541).
  - Download icon + touch-visible star: the Download-all confirm and the Cancel dialog wording
    remain (#1542).
