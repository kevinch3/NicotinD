# Listening history

An append-only, per-user log of what was actually listened to, plus the Library **Stats** tab built
on it. Phases 1-2 of a program whose remaining phases are a radio scoring axis and install-level
analytics — see [Roadmap](#roadmap).

Before this, the app had **no play tracking of any kind**: no `played_at`, no play count, nothing.
`albumOrderBy('frequent')` in `routes/library.ts` still fell back to `created DESC` with a comment
saying it needed play data "we don't sync yet", and [docs/popularity.md](popularity.md) left a local
play-count axis as an unresolvable follow-up because there was no local signal to build one from.

## The shape

```
PlayerComponent (owns <audio>)                             [client]
  onTime / onEnded / handleNext  ──►  ListeningTrackerService
                                        │  accumulates real listened ms
                                        ▼
                                      ListeningQueueService
                                        │  durable localStorage outbox
                                        │  flush: session end · hidden · reconnect
                                        ▼
                     POST /api/history/plays  (batch, idempotent)   [server]
                                        │  countsAsPlay() applied HERE
                                        ▼
                                   play_events
                                        │
                     GET /api/history/recent  ──►  "Recently played" shelf
```

| Piece | File |
| --- | --- |
| Table + indexes | `packages/api/src/db.ts` (`applySchema`) |
| Rule, write, read | `packages/api/src/services/play-history.ts` |
| Endpoints | `packages/api/src/routes/history.ts`, mounted `/api/history` |
| Session lifecycle | `packages/web/src/app/services/listening-tracker.service.ts` |
| Durable outbox | `packages/web/src/app/services/listening-queue.service.ts` |
| Call sites | `packages/web/src/app/components/player/player.component.ts` |
| Shelf | `packages/web/src/app/components/recently-played/recently-played.component.ts` |
| Stats aggregates | `packages/api/src/services/listening-stats.ts` |
| Stats tab | `packages/web/src/app/pages/library/library-stats.component.ts` |
| Admin size row | `routes/review.ts` `playEvents` slice → Admin → Library Maintenance |

## What counts as a play

The Last.fm rule, in `countsAsPlay(msPlayed, durationMs)`:

- counted once `msPlayed >= min(durationMs / 2, 240_000)`
- a track shorter than `MIN_TRACK_MS` (30 s) never counts
- unknown duration falls back to the 4-minute ceiling alone

The 50% floor is what makes a skip not count; the 4-minute ceiling keeps a 20-minute live take
reachable.

**The rule lives on the server, not the client.** If a client decided "this counted", the threshold
could never be retuned without invalidating existing history, and a device on an old bundle would
disagree with a fresh one forever. Clients report raw facts — song, start time, ms listened, how it
ended — and the server derives `counted` at insert. Same discipline as `explainSimilarity` being the
single source of truth for radio scoring.

## Why not `GET /api/stream/:id`

The stream route looks like the obvious choke point and is a trap. All four of these are visible in
the code:

- Range requests mean **N HTTP hits per track** (`serveFileWithRange`), plus more on every seek.
- The 30-s-ahead gapless preload streams tracks that **may never play**.
- Offline-preserved tracks play from an IndexedDB blob and **never touch the route at all**.
- Share-page playback is attributed to the *sharer* — `mintShareJwt` is subject-scoped to the creator.

A play is a duration-qualified event, not an HTTP request. The honest signal is client-side.

## Schema notes

Two deliberate choices in `play_events`:

**No FK on `song_id`.** Song ids are `sha1(path)` and re-mint on any move or retag, and the scanner
rebuilds `library_songs` wholesale — a cascade would delete listening history on a routine rescan.
This is the same reasoning as the per-song side tables in
[cache-invalidation.md](cache-invalidation.md).

**`title`/`artist`/`album` are snapshotted onto the event.** Same cause, opposite direction: without
the snapshot, a re-minted id would orphan the row and a year review would silently lose the track —
the failure that produced 17 dangling `playlist_songs` rows. ~60 bytes buys a self-contained log
that aggregates by artist name even when `song_id` no longer resolves, and needs no repointing
machinery at all.

`client_event_id` is `UNIQUE`, and writes are `INSERT OR IGNORE`. That is what makes an offline
flush safe to retry: the same event legitimately arrives twice and must not become two plays.

## Client call sites

Several things look like a play and aren't; each is handled explicitly in `player.component.ts`:

| Situation | Handling |
| --- | --- |
| Controller tab mirroring a remote device | Every call site is gated on `isActiveDevice()` — `setCurrentTrackMetadata` sets `currentTrack` with no audio here |
| Gapless preload of the next track | Not a session; only Effect 1's track load starts one |
| Repeat-one | Restarts the element without changing `currentTrack`, so it ends and reopens the session explicitly — otherwise a looped track logs as one enormous play |
| Token refresh re-running Effect 1 | `isTracking(track.id)` guard |
| False-ended recovery | `onEnded` returns before the end call, so a recovering track keeps its session |
| Prev within the first 3 s | Restarts the same track — the session continues; the backward jump is a seek |

`accumulate(prev, lastPos, pos)` counts only forward motion smaller than `MAX_DELTA_SEC` (1 s), so a
seek in either direction contributes nothing. Replaying a section *does* accrue again, since that is
real playback — `listenedSec` can therefore exceed the track length, which only affects whether the
play crosses the threshold (the server clamps stored `msPlayed` to the duration).

## Privacy

Both endpoints derive the user from the auth context and take **no user id parameter**. There is
nothing to pass, so there is nothing to get wrong — privacy is structural rather than a check
someone can forget. The admin surface sees a row count, never a user's history.

The share page's standalone `<audio>` deliberately does not report: a guest's listening would be
attributed to the sharer.

GDPR consent, export, erasure and a configurable retention cap are tracked in
[issue #454](https://github.com/kevinch3/NicotinD/issues/454).

## Retention

Raw events are kept indefinitely, on the project's measure-first discipline (#259, #271): at roughly
50 bytes a row, even a heavy listener is a few MB a year, and a year review needs multi-year raw
data. Rather than guess, the total is surfaced as the `playEvents` slice on `GET /api/admin/review`
and rendered in the Admin panel, so the policy is reviewed against a real number.

`recentPlays` restricts to songs that are still live, landed and unhidden — that shelf exists to be
tapped, and a tile that can't play is worse than an absent one. The raw log keeps the deleted rows
regardless, which is what a year review reads. Because the join is against the live library anyway,
each row also ships a `coverArt` **id** (`COALESCE(song, album, album_id)` — the same fallback chain
every other song listing uses; the cover route resolves entity ids to folder/embedded art) so the
shelf renders real covers; the client builds the `/api/cover/:id?size=&token=` URL itself, like every other cover
call site — `Track.coverArt`/`RecentPlay.coverArt` are always ids, never URLs (passing the raw id as
an `<img src>` is exactly the bug that left the home tiles on their letter placeholders).

## Stats (phase 2)

`GET /api/history/stats?period=30d|year|all` → the Library **Stats** tab. Headline totals, top
songs/artists/albums/genres, and a listening clock.

Everything is **derived at read time** — no rollup table. That is deliberate while the log is young:
a rollup would need invalidating by the same retention and erasure work that is still open (#454),
and SQLite answers these in one pass at current sizes. If it stops being cheap, the fix is a
materialised rollup behind the same function signature.

Design notes worth keeping:

- **`year` means this calendar year**, not the last 365 days. "My 2026" is the question a year review
  answers; a rolling window would quietly mix two years together every January.
- **An unknown `period` falls back to the default rather than 400ing.** It comes straight off a query
  string, and a stats page that errors on a typo is worse than one showing 30 days.
- **Genres rank through `library_song_genres`**, not `library_songs.genre` — that column holds only
  the *primary*, so ranking on it would under-report every secondary genre (same reason filters match
  the set via `EXISTS`).
- **Deleted songs still count.** Every aggregate `COALESCE`s the live library row with the event's own
  snapshot, which is the payoff for storing it.
- **The clock buckets by local hour.** "When do I listen" is a wall-clock question; UTC would smear
  someone's evening on a server in another timezone. It is always 24 buckets so the chart never has
  to special-case an empty result.
- **Clock bars are percent of the busiest hour**, not of the total — 24 shares of a total render as
  unreadable slivers, and the shape of the day is the point.
- SQL aliases are `artist_name`/`album_name`, not `artist`/`album`: those names also exist as real
  columns on both joined tables and SQLite rejects the `GROUP BY` as ambiguous.

The genre block reuses `GenreDistributionStripComponent` from the artist/album pages rather than
adding a second bar chart.

## Roadmap

- **P2 — stats page.** ✅ Shipped (see above).
- **P3 — recommendations.** A play-count/recency axis in `SongFeatures` + `explainSimilarity`, a
  `most-played` recipe sort, and a real `albumOrderBy('frequent')`. Deliberately after P2 so it
  ships into a dataset that has history in it.
- **P4 — install analytics.** Anonymous aggregates: most-played across the install, never-played
  tracks, whether acquisitions get listened to. Note that on a small instance "most played across
  all users" is not meaningfully anonymous — settle that before building it (#454).
