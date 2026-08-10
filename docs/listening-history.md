# Listening history

An append-only, per-user log of what was actually listened to. Phase 1 of a program whose later
phases are a stats page, a radio scoring axis, and install-level analytics — see
[Roadmap](#roadmap).

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
regardless, which is what a year review reads.

## Roadmap

- **P2 — stats page.** Top songs/artists/genres by period, total listening time, listening clock.
  All aggregates over `play_events`; no schema change.
- **P3 — recommendations.** A play-count/recency axis in `SongFeatures` + `explainSimilarity`, a
  `most-played` recipe sort, and a real `albumOrderBy('frequent')`. Deliberately after P2 so it
  ships into a dataset that has history in it.
- **P4 — install analytics.** Anonymous aggregates: most-played across the install, never-played
  tracks, whether acquisitions get listened to. Note that on a small instance "most played across
  all users" is not meaningfully anonymous — settle that before building it (#454).
