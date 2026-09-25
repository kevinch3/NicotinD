# Get, then hear it

Issue #1294. Search promises "what you own and what you could get", but before this the *get* half
ended in a folder: after **Get** a listener went Downloads → wait → Library → new-album banner →
album → track → play. Now a track or album got from search **joins the queue of the device that
pressed Get, by itself, once it lands**, and the listener is told once.

## The flow

1. **Get records an intent, per device.** Every search Get that returns a job id calls
   `GetThenHearService.remember(jobId, mode)`; the intent is `{ jobId, mode?, at }`, stored under the
   `nicotind-get-intents` localStorage key so a reload between Get and landing does not lose it.
   - Peer files (a song row, a blended Soulseek row, a folder, a folder-browser pick, "download all")
     go through `POST /api/downloads`, which now answers with the `jobId` of the acquisition job it
     recorded (`null` if that best-effort write failed — then there is nothing to remember).
     The mode is `modeForFileCount`: **one file plays next, more join the end** — a whole album
     jumping the queue is rude.
   - A link (the link-intent card, an archive.org / Spotify row) goes through `POST /api/acquire`,
     whose `jobId` is the core `acquisition_jobs` id on the addon lane. Its size is unknown until it
     lands, so it is remembered **without** a mode and decided then by the same rule on the landed
     count.
   - Not covered: the Lidarr catalog album hunt (the hunt modal), which starts its jobs elsewhere.
2. **The feed says when a job closes.** `LayoutComponent` calls `start()`, which follows
   `TransferService.acquisitionJobs()` — the feed that is already polled, and re-polled at once on the
   `job.changed` library event that a landing emits. `reconcile()` settles every intent whose job is
   no longer `active`.
3. **`done` → the job's own songs, in album order.** `GET /api/downloads/jobs/:id/songs` returns
   `{ jobId, state, songs }`: the non-hidden `library_songs` behind the job's
   `acquisition_job_items.song_id`, ordered album → disc → track → title. Keyed on the items, not
   on the album, so two jobs filling one album never hand each other tracks — the Library banner's
   `landedAlbumIds` could not answer this, since it names albums, not the job that filled them.
   A `done` job is one with at least one scanned item (`recomputeStage`), so a partial album
   enqueues what landed.
4. **Enqueue once, toast once.**
   - Something is loaded (`currentTrack` set, playing or paused): `next` inserts the set in order at
     the head of the queue (`insertInQueue`), `later` appends (`addToQueue`); tracks are
     `queuedBy: 'user'`, so a radio strategy change never throws them away. One toast — "landed ·
     plays next" / "added to the queue" — with one action, **Play now**, which jumps to the first
     landed track wherever it now sits (the listener may have reordered).
   - Nothing is loaded: the queue is left alone, and the toast's action is **Play**, which plays the
     landed set as the queue through `playWithContext` — the same verb as an album's Play.
   - `failed` / `superseded`, or a `done` job with no playable song: dropped with no toast and no
     queue change.

## Once only

The intent is deleted from storage **before** the songs are fetched, and the tab keeps a set of
jobs it already settled, so a second feed tick, a duplicate event or a reload mid-fetch cannot
enqueue twice. The price: a fetch that fails loses the enqueue. Enqueuing twice is the worse
failure — the listener would hear the song twice and could not tell why — so the choice is
deliberate. An intent whose job the feed never shows (a URL the in-process fallback took, a card
removed before it landed) is pruned after `GET_INTENT_TTL_MS` (24 h).

## Which device

The intent lives on the device that pressed Get, and the enqueue goes to **that device's
`PlayerService`** — the same as the song menu's Play next. While that device is a remote-playback
controller, its local queue is the session it drives (a track change is what it sends to the
active output), so the landed track plays next *there* through the controller; it never writes
into the active output's own queue. A second tab on the same device shares the localStorage
intents; whichever tab reconciles first claims the intent.

## Opting out

Settings → Playback → "Get, then hear it", shown only to someone who can press Get
(`auth.canAcquire()`). It is a **per-user** preference, `queueAcquired` in `UserPreferences`
(`user_settings.queue_acquired`, nullable): `null` means never chosen and reads as **on**
(`queueAcquiredOn`), so it follows the person across devices like the rest of the preferences door
(docs/web-ui.md "Per-user preferences"). Off stops both new intents and ones already recorded.
A mirror written before the key existed stays valid: `parseUserPreferences` reads an absent
`queueAcquired` as `null`.

## Tests

- `get-then-hear.service.spec.ts`: intent recording, mode defaults, next vs append, a link decided
  at landing, "Play now" after a reorder, idle vs playing, once-only (ticks, claim-before-fetch,
  failed fetch), failed/empty job, the stale prune, opt-out.
- `search.component.spec.ts` ("get, then hear it"): each Get lane remembers the right mode.
- `settings.component.spec.ts`: the toggle, default on, hidden for non-acquirers.
- `downloads.test.ts`: the enqueue answers with its job id; `GET /jobs/:id/songs` orders, scopes to
  the job, skips hidden songs, 404s.
- e2e `get-then-hear.spec.ts`: play the fixture album, Get a track from search through the fixture
  addon, finish it addon-side — one toast, the landed track next in the queue, Play now jumps to it.

## Not built

Now Playing does not yet say where a queued track came from (the issue's "tagged with the
acquisition context" heading); `Track` has no per-track provenance field. Letting a landed track
seed a running radio is a follow-up, as the issue says.
