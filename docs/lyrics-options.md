# Lyrics options: fetch again, a timing editor, and karaoke options

Design for #1657, written under #1673. It blocks the two implementation issues, #1674 (fetch again
from another source) and #1675 (timing editor), and it absorbs the rest of #1656 (the karaoke sync
tool). Nothing here is built yet. What is already built is described in the Lyrics entry of
[design-patterns.md](design-patterns.md) and in "Lyrics have one owner" in [web-ui.md](web-ui.md).

Some of #1657 has shipped since it was filed. This doc treats it as existing behaviour:

- **A re-fetch never replaces timed lyrics with untimed ones** (#1672, PR #1689). `fetchSongLyrics`
  skips an untimed candidate when the stored row is timed and returns the outcome `kept-timed`
  (`packages/api/src/services/lyrics-fetch.ts:120-130`, `:151`). The one exception is a stored row
  judged to be another take (`:113-119`). LRCLIB's `fetchLyrics` now asks `/search` when `/get`
  answers untimed and ranks timed hits first within the duration tolerance
  (`packages/api/src/services/plugins/lrclib/index.ts:137-162`, `:213`).
- **Every row records why its words were chosen** (#1676, PR #1717): `LyricsChoice` in
  `choice_json`, plus `customized_by/at` and `offset_by/at`
  (`packages/api/src/services/lyrics-store.ts:26-41`, `packages/core/src/types/lyrics.ts:66-90`).
  `GET …/lyrics/export` returns the LRC with the offset baked in (`lyrics-store.ts:237-260`).
- **Sync-offset writes are serialized**, latest tap wins (#1656 part 5, PR #1705;
  `packages/web/src/app/services/lyrics.service.ts:341-403`).
- **The track-info sheet asks before an edit drops the timing** (#1666;
  `track-info-sheet.component.ts:401-416`). The drop itself still happens.

## Reproduction (2026-11-08)

Run against the e2e environment (`packages/e2e`, ports 9797-9800) with a throwaway spec that was not
committed. Two things about the environment matter for everything below:

- **The e2e server talks to the real lrclib.net.** LRCLIB is registered and default-enabled
  (`packages/api/src/services/plugins/builtin.ts:78-80`) and its base URL is a constant
  (`lrclib/index.ts:34`). The fetch runs inside the server, so Playwright's `page.route` cannot stub
  it. Today's specs pass because the fixture titles match nothing on LRCLIB, not because a source
  is stubbed.
- To get real timed and untimed answers, the spec generated silent FLACs at the real durations of
  real songs (ffmpeg `anullsrc`), tagged them, dropped them into `E2E_MUSIC_DIR`, and scanned.

Song: "Luna tucumana", Atahualpa Yupanqui, album "His Great Songs", 188 s.

| Step | Request | Result |
| --- | --- | --- |
| A1 | `GET /songs/:id/lyrics` | `null` |
| A2 | `POST …/lyrics/fetch {}` | timed, `lrclib` record 7860638, `matchedDurationSec` 188; choice `matchedBy: "search"`, `skippedUntimed: []` |
| A3 | `POST …/fetch {force:true}` three times | record 7860638 each time |
| A4 | `PATCH …/offset {offsetMs:1500}` | `offsetMs` 1500 |
| A5 | `POST …/fetch {force:true}` | same record 7860638, same text, **`offsetMs` 0**, `offsetBy` cleared |
| A6 | `PATCH` offset 750, then `PUT {plain}` (one word changed) | `synced` null, `offsetMs` 0, `source` `user`, `customized` true; choice kept |
| A7 | `POST …/fetch {}` | the customized plain row, as cached |
| A8 | `POST …/fetch {force:true}` | **customized row replaced** by record 7860638; `customized` false, `customizedBy` null |
| A9 | `PATCH` offset −500, then `PUT {plain, synced}` with the stored text unchanged | `synced` kept, **`offsetMs` 0** |
| A10 | `DELETE …/lyrics`, then `POST …/fetch {}` | **plain from the file tag**, `source` `file-tag`, `synced` null |
| A11 | `POST …/fetch {force:true}` | timed again, record 7860638 |

What LRCLIB itself answered, by `curl`:

- `/get` with `album_name=His Great Songs&duration=188` returns record 21774064, **plain only**.
- `/get` with the same artist, title and duration but no album returns record 7860638, **timed**.
- `/search` returns 9 records; 8 are timed, and 3 are exactly 188 s long, one of them the untimed
  21774064.
- For "Bohemian Rhapsody" (Queen) `/search` returns 20 records, 18 within ±5 s of 355 s and nearly
  all timed, many with identical durations.

Two more songs:

- "Bohemian Rhapsody", album "A Night at the Opera", 355 s: `POST …/fetch {}` stores record 19080,
  timed, `matchedBy: "exact"`.
- The same title at 30 s: `POST …/fetch {}` answers `null`. The #1212 duration gate refuses
  every candidate.

Karaoke replay (390×700 viewport, a fixture track seeded through `PUT` with stamps at 0.5/3/6/9 s):

- `karaoke-fullscreen-line-current` moved to lines 2, 3 and 4 at 2409, 5551 and 8483 ms after the
  overlay opened, so the highlight follows the stamps. The gaps (3.14 s and 2.93 s for 3 s stamps)
  match the player's time source, the `timeupdate` event
  (`packages/web/src/app/components/player/player.component.ts:1394`), which fires about every
  250 ms.
- Sync row button positions at offset 0: earlier x=123, later x=235. At +0.25 s: earlier x=103,
  later x=215, and Reset appears at x=255. **One tap moves both buttons 20 px**, which confirms
  #1656's first cause.
- The sync row sits at y=644-676 of 700, below the transport. It takes the bottom 56 px of the
  screen permanently.

Editing in the track-info sheet (same seeded track):

- The editor is the `lyrics-editor` textarea filled with the words only (`line one\nline two…`),
  timestamps stripped (`lyricsText`, `track-info-sheet.component.ts:310-319`). Its only buttons are
  Save, Cancel and Reset. **The app has no way to set or fix a timestamp.**
- Save on a timed song opens the confirm dialog: "These lyrics are synced. Saving an edit removes
  the karaoke sync, because the timings were written for the old text." Confirming sends
  `PUT {"plain":"line one\nline two edited\nline three\nline four"}` with no `synced`, and the row
  comes back with `synced` null.
- The sheet showed "Edited by you" for a row a different session had written. The label reads
  `lyrics().customized` (`track-info-sheet.component.html:583-584`), not `customizedBy`.

## Where the reproduction disagrees with #1657's code map

1. **A same-record re-fetch wipes the sync offset (A5).** The owner's 2026-11-07 decision keeps
   the synced text *and its offset* when a re-fetch answers untimed. When it answers timed, even
   with the identical record and text, `setLyrics` is called without `offsetMs`, which means 0
   (`lyrics-store.ts:58-62`, `:105`; `lyrics-fetch.ts:131-145`). A user who corrected the offset
   and then pressed Re-fetch loses the correction for nothing.
2. **The sheet's Re-fetch overwrites a curator's edit without asking (A8).**
   `fetchLyricsNow` forces whenever a row exists (`track-info-sheet.component.ts:382`), and the
   REST route has no `customized` guard (`packages/api/src/routes/library.ts:2600-2622`). The MCP
   tool refuses the same action (`packages/api/src/routes/mcp.ts:611-615`). Two callers, two
   policies. The route's comment ("A user-edited row is left untouched unless `force:true`") is
   accurate, but the web app always sends `force`.
3. **Reset, then play, loses the timing (A10).** After a `DELETE`, the player's first load asks
   for a non-forced fetch (`lyrics.service.ts:254-277`). That path recovers the plain text the
   previous fetch wrote into the file tag (`lyrics-fetch.ts:69-95`) and never asks a source, so the
   song comes back untimed while LRCLIB has a timed take. The #1672 guard cannot see this, because
   at that moment there is no stored row to protect. Lyrics rows do follow a song across an id
   change (`packages/api/src/services/song-curation-carry.ts:54`), so in practice Reset is the main
   way into this path.
4. **Sending the LRC back verbatim still resets the offset (A9).** `PUT` with `synced` keeps the
   text but always writes offset 0. This is the right behaviour for the timing editor *only if* the
   editor folds the offset into the stamps before saving (see below). It is wrong for any future
   caller that resends unchanged text.
5. **The plugin's own choice is invisible in the provenance.** In A2 the exact `/get` record was
   untimed (21774064) and the plugin passed it over for a `/search` hit, but the stored choice
   reads `matchedBy: "search"`, `skippedUntimed: []`. `skippedUntimed` only records host-level
   skips (`lyrics-fetch.ts:126-130`). The candidate contract below fixes this by moving the choice
   to the host.
6. **"Re-fetch can never alternate" holds (A3).** It is deterministic for a given song: same query,
   same record. The "sometimes timed, sometimes not" that the owner saw within LRCLIB is the
   `/get` versus `/search` split, and the album name in the query decides it: "His Great Songs"
   gets the untimed record, no album gets the timed one. #1672's `/search` step now hides that
   split.
7. **Edits are no longer silent**, contrary to the map: the sheet asks first (#1666). The timing
   is still dropped once the user confirms.

The "never downgrade" fix (#1672) has landed and is not re-proposed here. Points 1-3 are separate
gaps, and the candidate contract below closes them.

## 1. Candidate contract for `LyricsCapability`

Today a source returns one result (`packages/core/src/plugin/capabilities.ts:114-117`) and the
host keeps the first source that answers (`lyrics-fetch.ts:120-150`). To fetch again from a
different source or take, the host needs the whole list.

### Shape

```ts
interface LyricsCandidate extends LyricsResult {
  /** Stable within the source: its record id, else a hash of the synced/plain text. */
  candidateKey: string;
  /** The source checked the duration against the query's and it was within tolerance. */
  verified: boolean;
}

interface LyricsCapability {
  fetchLyrics(query: LyricsQuery): Promise<LyricsResult | null>;
  /** Every acceptable record, best first. Optional: a source without it offers one. */
  fetchCandidates?(query: LyricsQuery): Promise<LyricsCandidate[]>;
}
```

`fetchLyrics` stays, so lyrics addons built against `@nicotind/addon-sdk` (`manifest.ts:17`) keep
working. For a source without `fetchCandidates`, the host wraps its single answer as a list of one.

### Rules the host applies, whatever the source says

- **Duration gate (#1212).** The host drops any candidate whose `matchedDurationSec` is more than
  `LYRICS_DURATION_TOLERANCE_SEC` from the song's. Today only the LRCLIB plugin applies this gate
  (`lrclib/index.ts:207-213`). A third-party source must not be able to skip it. A candidate with
  no duration stays in the list, marked unverified, ranked after every verified one.
- **De-duplication.** LRCLIB holds the same lyrics many times (18 near-identical Bohemian Rhapsody
  records within the tolerance). Two candidates whose normalized synced text matches (or whose
  plain text matches, when neither is timed) count as one. The first by rank is kept, and the
  number of copies is recorded. Without this, "Try another source" would walk through copies that
  look the same on screen.
- **Ranking.** Timed before untimed, verified before unverified, smaller duration delta first,
  then the order of sources in the registry. For LRCLIB the plugin returns the exact `/get` record
  and every `/search` hit within the tolerance. The host ranks them, which removes the plugin's
  private "/get, else /search" choice (gap 5).
- **Never downgrade.** When the stored row is timed and not another take, untimed candidates are
  left out of the walk, as #1672 already requires. The walk only visits candidates that may be
  applied.

### Walking the list

The walk is stateless on the server. The cursor is the stored row's own choice:

```
POST /api/library/songs/:id/lyrics/next   { confirmReplaceEdit?: boolean }
→ 200 { outcome, lyrics, applied: { source, sourceTrackId, candidateKey, index, total, timed } }
```

- The server lists the candidates, finds the one matching the stored `choice.candidateKey`, and
  applies the next one, wrapping at the end. When the stored row matches none of them (a
  file-tag row, a user edit, a record the source has since removed), it applies the first.
- It never applies the stored candidate again while there is another. With only one candidate the
  outcome is `only-one` and the row is unchanged. With none it is `no-match` and the row is
  unchanged.
- `index`/`total` are the "n of m" the UI shows, counted over the de-duplicated, applicable list.
  They are worked out on each press, so they can shift if the source's data changes between
  presses. That is acceptable, because the stored choice says exactly what was applied.
- **A `customized` row is not replaced without `confirmReplaceEdit: true`.** Without it the
  server answers `409 { code: 'lyrics-customized' }` and the UI asks. The same guard goes on the
  existing `POST …/fetch {force:true}`, which closes gap 2 and makes the REST route match the MCP
  tool.
- **The offset survives re-applying the same text.** If the chosen candidate's synced text equals
  the stored one, the row keeps its `offset_ms`, `offset_by` and `offset_at`. Different text resets
  them, as today. This closes gap 1 on both routes.
- The walk is a new route rather than a flag on `…/fetch`, because `…/fetch` returns a bare
  `LyricsDto | null` that `LyricsService.fetchFor` and the MCP tool depend on
  (`lyrics.service.ts:450-463`). It goes through `LyricsService` like every other lyrics call (lint
  rule `nicotind/lyrics-single-owner`).
- Each press costs what a forced fetch costs today: one `/get` and one `/search` for LRCLIB. There
  is no candidate cache. A cache would go stale against the source, and pressing the button is
  rare.

## 2. `library_lyrics` changes

The provenance columns from #1676 already cover source, source record id, the editor, the offset
editor and the reason for the choice. What is left:

- **`choice_json` gains the candidate fields.** These are `candidateKey`, `index`, `total`,
  `duplicates` (copies folded into this one), `via` (`first-fetch` | `forced` | `next`) and
  `passedOver` (the better-ranked candidates that were not applied, with each one's source, key,
  timed flag and delta, capped at 5). `passedOver` replaces the host-only `skippedUntimed` and
  closes gap 5. This is JSON, so no migration is needed. Rows written before it read as
  "unknown", as rows from before #1676 do now.
- **`customized_kind TEXT`** (`text` | `timing` | `text+timing`, null when not customized). `PUT`
  sets it by comparing the incoming body with the stored row. Without it, a curator who only fixed
  timings looks the same as one who rewrote the words. A later share-back needs to know which of
  the two it would be sending, and the export's `corrected` flag (`lyrics-store.ts:257`) can then
  say which.
- **`previous_json TEXT`** (optional, see the closed questions): a snapshot of the whole row taken
  just before a `next`, a forced fetch, or a timing save replaces it. One level of undo, cleared
  when the undo is used.

Nothing else changes. The row stays keyed by song id and keeps following the song across an id
change (`song-curation-carry.ts:54`). Uploading to LRCLIB stays out of scope. The export already
has what an upload would need: track fields, the LRC with the offset baked in, and the record id it
started from.

## 3. Plain to synced: upgrades, `customized`, and the file tag

| Stored row | Non-forced fetch (player first load) | Forced fetch / `next` |
| --- | --- | --- |
| none, file has a tag | today: plain from the tag. Proposed: see question 4 | sources only (#1205) |
| none, no tag | sources, best candidate | sources, best candidate |
| plain, from a source or the tag | as stored | the best timed candidate wins if there is one; else the next plain one |
| plain, `customized` | as stored, never upgraded on its own | needs `confirmReplaceEdit` |
| timed, not another take | as stored | timed candidates only (#1672); same text keeps the offset |
| timed, another take (#1205) | as stored | any candidate, untimed included |
| timed, `customized` | as stored | needs `confirmReplaceEdit`, then timed candidates only |

- **"Timed version available."** A plain row that is not customized is upgraded by any fetch
  again. A customized plain row is not. For those, the options group shows "A timed version is
  available" when the last walk saw a timed candidate (`passedOver` has one). The action that
  applies it asks first, like any replacement of an edit. Nothing queries the source in the
  background just to show the hint.
- **The file tag carries plain text only, as today.** A fetch writes it (`lyrics-fetch.ts:146-148`)
  and so does `PUT` (`library.ts:2655-2660`). A timing-editor save whose words did not change must
  **not** rewrite the audio file. The words are already in the tag, and every tag write rewrites
  the file. Only `PUT` with changed plain text writes the tag.

## 4. Timing editor (#1675)

For curators, on the phone first. It is reached from the options group ("Edit timing") and from
the track-info sheet when the row is timed or plain.

### Model

- The editor works on a list of rows `{ text, timeMs | null }`.
  - From a timed row: `applyLyricsOffset(parseLrc(synced), offsetMs)`, which is exactly what the
    karaoke view shows (`lyrics.service.ts:126-128`).
  - From a plain row: the plain lines, all unstamped.
- **The offset is folded in on load and reset on save.** Stamps are absolute playback times. The
  saved LRC therefore needs no offset, and `PUT` already writes 0 (A9). This is the one caller for
  which today's PUT behaviour is right.
- `parseLrc` drops ID tags and untimed lines and turns a line with several stamps into one row per
  stamp (`packages/core/src/lrc.ts:43-70`). The editor accepts that: a chorus repeated three times
  is three rows, each sung at its own time. ID tags are not kept. The `[offset:]` tag is already
  folded in by the parser.
- **Saving** sends `PUT { plain, synced }`, with `synced` from a new `serializeLrc(rows)` in
  `@nicotind/core` next to `parseLrc`, built on the existing private `formatStamp` (`lrc.ts:95`),
  and `plain` set to the rows' text joined by newlines. This is how text edits stop erasing timing.
  In the timing editor a line's text is edited in place and keeps its stamp. The free-text textarea
  stays for plain songs and for replacing the whole text, which still drops the timing behind the
  existing confirm.

### Phone layout (390×700 and shorter)

```
┌──────────────────────────────┐
│ Cancel   Edit timing    Save │  top bar, 48 px
├──────────────────────────────┤
│ 00:19.26  Yo no le canto…    │
│ 00:23.10  Porque alumbra…    │  line list, scrolls; the target line
│▶ —:—      y nada más…        │  stays one third from the top
│ —:—       …                  │
├──────────────────────────────┤
│ 01:12 / 03:08     3 of 24 set│
│  [−2s]   [ ▶❚❚ ]   [+2s]     │  dock, ~140 px, fixed
│  [ Undo ]   [   STAMP   ]    │  STAMP is the big thumb target
└──────────────────────────────┘
```

- **Tap to stamp.** STAMP gives the target line the current playback time and moves the target to
  the next line. The time is read from the `<audio>` element at the `pointerdown` that triggered
  it, not from the `currentTime` signal, which lags by up to one `timeupdate` (about 250 ms, see
  the replay above). `PlayerService` gains a read of the element's own clock for this. A haptic
  tick (`appHaptic`) confirms each stamp. Undo reverts the last stamp and moves the target back.
- **Nudge one line.** Tapping a row's time opens an inline stepper on that row: ±0.1 s and ±0.5 s,
  "Set to now", and "Play from here" (seeks to 2 s before the line). Holding a step repeats it.
- **Shift a range.** A long press on a row starts a selection, and tapping another row extends it.
  The stepper then moves every selected stamp by the same amount. "From here to the end" is one
  button, because the most common fix is "everything after the bridge is late".
- **No drag-to-retime on the phone.** A vertical drag on a list conflicts with scrolling, and a
  horizontal drag along a row is too short to be accurate. The steppers do the same job. A desktop
  pointer can get drag later without changing the model.
- **Preview** switches the list into the karaoke panel, fed with the draft rows, playing from the
  selected line. It is the same `findActiveLine` path, so what the curator approves is what
  listeners will see.
- **Checks before Save.** Every non-empty line has a stamp, and the stamps never go backwards.
  Anything that fails is highlighted, and Save shows "3 lines without a time" instead of being
  silently disabled.
- **Short and landscape screens.** Below about 480 px of height the dock folds into one row
  (−2s, play, +2s, STAMP), and Undo moves into the top bar.
- **When stamping is unavailable.** It needs local playback of this song. When playback is on
  another device ([remote-playback.md](remote-playback.md)), the editor still edits text and nudges
  stamps but disables STAMP with a note. There is no editor on TV; the D-pad tree stays as it is.
- **Leaving with unsaved changes** asks whether to discard them. The draft lives only in memory.

## 5. Karaoke options group (absorbs #1656)

One "Options" button (a sliders icon) in the karaoke header, between the title and the vocal-mute
button (`now-playing-karaoke-fullscreen.component.html:44-99`), and the same button in the Lyrics
panel. It opens a bottom sheet that lies over the lower part of the lyrics without pushing them. It
is closed every time karaoke opens, and its open state is not remembered.

Contents, top to bottom:

1. **Source line**: "LRCLIB · timed · 2 of 7", or "Edited by <username>" from `customizedBy`, not
   "Edited by you" (`track-info-sheet.component.html:583-584`).
2. **Try another source**: a secondary text button, which calls `next`. While it runs the button
   shows the spinner, and afterwards it shows what was applied.
3. **Sync** (curator): the offset tool.
   - **Fixed geometry.** Three slots of constant width (`[Lyrics earlier] [value] [Lyrics later]`),
     a value cell wide enough for "−30.00 s", `tabular-nums`, and Reset always rendered but
     disabled at 0. Nothing appears or disappears when the value changes. That removes the 20 px
     jump measured above.
   - **Direction in the listener's terms.** The buttons are labelled "Lyrics earlier" and
     "Lyrics later" in words, not chevrons. The value reads "Lyrics 0.25 s later" instead of
     "+0.25s". Each tap briefly shows the step (for example "↓ 0.25 s later"). The stored sign
     convention (positive = later, `lrc.ts:12-15`) is unchanged; only the wording changes.
   - **Press and hold.** After 400 ms the step repeats every 100 ms, and after 2 s of holding the
     step grows to 1 s. The 250 ms tap step (`LYRICS_OFFSET_STEP_MS`) stays.
   - **Write ordering.** This is the existing per-song serialization: at most one `PATCH` in flight,
     later taps folded into one write of the latest value, and a failure reverting to the last value
     the server confirmed (`lyrics.service.ts:341-403`). A hold does not send one `PATCH` per step;
     the serialization already folds them.
   - One shared component renders the tool in both the fullscreen view and the panel, replacing the
     two copies (`now-playing-karaoke-fullscreen.component.html:251-298`,
     `now-playing-lyrics-panel.component.html:34-84`).
4. **Edit timing** (curator): opens the editor from section 4.
5. **Undo last change** (if `previous_json` is adopted): shown after a `next` or a timing save.

Vocal mute and the exit button stay in the header; see question 5. Everything curator-only stays
gated on `auth.canCurate()` and stays off on TV (`canSync` defaults to false,
`now-playing-karaoke-fullscreen.component.ts:64`).

## 6. Testing seam and tests

**A fixture lyrics source for e2e.** Without one, the e2e tests #1657 asks for ("fetch-again
changes the applied source", "an alternating source never leaves the song untimed") cannot be
written, and today's specs depend on lrclib.net returning nothing. Proposal: a
`NICOTIND_LRCLIB_URL` override of `API_BASE` (`lrclib/index.ts:34`), and a small stub LRCLIB server
that `playwright.config.ts` starts and points the main server at, the way it already does for the
Lidarr fixture (`NICOTIND_LIDARR_URL`, `playwright.config.ts:144`). The stub serves `/get` and
`/search` from an in-spec table keyed by title, so a spec can arrange plain-only `/get` with timed
`/search`, alternation, and several takes.

Tests per piece. The #1657 list, with the gaps above added:

- **API, candidates.** The walk visits candidates in rank order and wraps; it never re-applies the
  stored candidate while another exists; it de-duplicates identical texts; it drops a candidate
  beyond the tolerance even when a source returns one; timed rows walk timed candidates only;
  `only-one` and `no-match` leave the row unchanged.
- **API, guards.** A customized row answers 409 to `next` and to forced `…/fetch` without
  `confirmReplaceEdit`. A re-fetch that re-applies identical synced text keeps the offset (A5 as a
  regression test), and different text resets it.
- **API, PUT.** With `synced` it keeps the timing, without it clears it (already pinned in
  `library.lyrics.test.ts:346-372`); it sets `customized_kind`; and it does not write the file tag
  when the plain text is unchanged.
- **Core.** `serializeLrc` and `parseLrc` round-trip stamped rows, including ms-precision stamps
  and stamps past 99:59.
- **Component.** STAMP records the element's clock at `pointerdown`; a nudge retimes one row; a
  range shift moves only the selection; Save sends `{plain, synced}` with the offset folded in;
  the sync tool's geometry is identical at 0, +0.25 s and −12.50 s; the options group is hidden by
  default and for non-curators.
- **E2E (with the stub).** Seed plain lyrics, stamp every line while playing, save, and assert in
  karaoke that the active line follows the stamps. Press "Try another source" with two takes and
  assert the applied source and "n of m" change. Press it repeatedly against an alternating stub
  and assert karaoke keeps following timed lines.

**Order.** (1) The stub source and the two guards (customized on forced fetch, offset kept on
identical text). These are small, they close gaps 1 and 2, and every later test needs the stub.
(2) The #1656 options group with the sync tool. (3) #1674 candidates and `next`. (4) #1675, the
timing editor.

## Decisions (owner, 2026-11-09)

The owner took the recommended option on all six.

1. **"Try another source" is for curators only**, like Edit and Sync. It replaces the shared row
   for every listener.
2. **One previous version is kept** (`previous_json`), with "Undo last change", after a fetch again
   or a timing save replaces a row. No full history.
3. **"n of m" counts distinct lyrics** after de-duplication, and only those the walk may apply.
4. **With no row but words in the file tag** (after a Reset, for example), the tag's words show at
   once, and the row is upgraded the first time a timed candidate within the tolerance is found.
5. **Vocal mute stays a one-tap header button.** The options group holds only lyrics settings.
6. **A timing save needs a stamp on every non-empty line** before Save is enabled.
