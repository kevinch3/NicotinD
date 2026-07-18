# Playlist-from-acquisition

A URL acquire job that's a _playlist_ — a Spotify playlist, a YouTube
playlist, or an archive.org item the user opted to treat as a playlist —
auto-generates a per-user **native playlist** from the landed tracks, in
download order. The Downloads card then offers an **Open playlist**
deep-link straight to `/library/playlists/<id>` instead of the album /
multi-album openers.

## Why

Acquiring a playlist before this feature worked but lost the playlist
identity: spotdl ran with a `--output` template, each track landed in its
own `<Artist>/<Album>/<track>` folder, and the user ended up with 16
unrelated albums — no native "Spotify playlist X" anywhere in the app.
Auto-generating a playlist on completion means the user keeps the
playlist concept intact: a single named list with the same tracks in
the same order, owned by them, editable like any other user playlist.

## Pieces

| Concern                                                                                | Where                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL classifier (pure)                                                                  | `packages/core/src/types/classify-acquire-url.ts` (`classifyAcquireUrl`)                                                                                 |
| Schema: `is_playlist` + `playlist_id` columns on `acquire_jobs`                        | `packages/api/src/db.ts`                                                                                                                                 |
| Schema: per-track rows (`acquire_job_tracks`) for the post-ingest step                 | `packages/api/src/db.ts`                                                                                                                                 |
| Per-track writes from resolve-capable plugins (archive + yt-dlp; spotdl is title-only) | host `emitTrack` (`packages/api/src/index.ts`) → `recordAcquireJobTrack` (`acquire-playlist.ts`); parsing in `acquire/process.ts` `parseYtdlpTrackEvent` |
| `AcquireJob` shape (`isPlaylist`, `playlistId`)                                        | `packages/core/src/types/acquire.ts`                                                                                                                     |
| `AcquireJobSubmitOptions` (`userId`, `as`)                                             | `packages/api/src/services/acquire-watcher.ts`                                                                                                           |
| Post-ingest playlist materialization                                                   | `packages/api/src/services/acquire-playlist.ts` (`resolveAcquireJobTracks`)                                                                              |
| Route wiring (forwards `userId` + `as`)                                                | `packages/api/src/routes/acquire.ts`                                                                                                                     |
| Link-intent toggle (archive-only "Treat as playlist")                                  | `packages/web/src/app/pages/search/search.component.{ts,html}`                                                                                           |
| Downloads card "Open playlist" deep-link                                               | `packages/web/src/app/components/download-item/download-item.component.{ts,html}` + `lib/route-utils.ts` `resolvePlaylistRoute`                          |

## URL classifier

A pure function in `@nicotind/core`:

```ts
classifyAcquireUrl(url) → { source: 'spotify'|'youtube'|'archive'|'other', kind: 'playlist'|'album'|'track'|'unknown' }
```

Patterns:

- `open.spotify.com/playlist/<id>` → playlist
- `open.spotify.com/album/<id>` → album
- `open.spotify.com/track/<id>` → track
- `youtube.com/playlist` → playlist
- `youtube.com/watch?v=…&list=…` → playlist
- `youtube.com/watch?v=…` (no `list`) → track
- `youtu.be/<id>` → track
- `archive.org/details/<id>` → album (the user can override via `as: 'playlist'` on submit)
- anything else → unknown

Reused by `AcquireWatcher.submit()` (sets `acquire_jobs.is_playlist` at submit
time) and the web's link-intent card (decides whether to render the
"Treat as playlist" toggle).

## Post-ingest step

`AcquireWatcher.ingest()` runs the organize → scan pipeline as before, then
if the job's `is_playlist=1`:

1. Reads `acquire_job_tracks` in `position` order. Rows are written by
   `recordAcquireJobTrack`, the host `emitTrack`'s upsert: keyed on
   `(job_id, title)`, re-emits (downloading → done, retry replays)
   update in place, new titles append — `position` is first-appearance
   (= playlist) order. **Every** event writes a row, path or not —
   title-only sources (spotdl) get `path=''`. (Gating the insert on
   `path` was the launch bug that silently disabled playlist generation
   for spotdl _and_ yt-dlp — the `path` was also being dropped at the
   `runAcquireProcess.onTrack` seam, which now forwards the full
   `TrackEvent`.)
2. For each row, joins against `acquisitions` (filtered by `source_ref =
jobUrl`) → `library_songs` to find the post-scan song id. The path
   match compares basename **stems** (extension stripped) so the
   lossless→Opus in-place transcode (`track01.flac` → `track01.opus`)
   still matches. The title fallback (path missing or stem miss) tries
   the exact title first, then strips leading `"Artist - "` segments —
   spotdl logs `Downloaded "Artist - Title"` while `library_songs.title`
   is just the title. Exact matches always win over stripped variants.
3. De-dups and skips any row whose status isn't `done`/`skipped` — a
   partial download surfaces as a shorter playlist, matching the "X of
   N" warning on the job row.
4. Creates or refreshes the playlist (see Retry contract below): reuse
   `acquire_jobs.playlist_id` when the playlist still exists and is
   owned by this user (replace its contents in place), else
   `PlaylistService.create(userId, { name: label, songIds })` →
   `kind='user'` playlist, owned by the submitter.
5. Persists the playlist id to `acquire_jobs.playlist_id` so the
   Downloads card can deep-link straight to it.

The step is best-effort: a failure (empty resolve, playlist-service
throw) is logged at `warn` and never breaks the job — the files are
already in the library, and the user can still build a playlist manually.

## Per-source behavior

| Source                    | URL pattern identifies playlist?                                | Per-track `path` written?                                                                                                                                                                                                                   | Auto-generates playlist?                                                         |
| ------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **spotdl** (Spotify)      | yes (`/playlist/<id>`)                                          | no — spotdl's log lines don't expose the file path; rows are title-only (`path=''`) and resolve via the title fallback incl. `"Artist - "` prefix stripping                                                                                 | yes                                                                              |
| **yt-dlp** (YouTube/etc.) | yes (`/playlist`, or `watch?v=&list=`)                          | yes — `%(filename)s` is appended to the `TRACK_START::` / `TRACK_DONE::` markers after a **tab** (`parseYtdlpTrackEvent` splits at the last tab; a `::` delimiter would break on titles containing `::`, which propagate into the filename) | yes                                                                              |
| **archive.org**           | no (the URL is just an item)                                    | yes — the plugin already knows the file name it's streaming                                                                                                                                                                                 | only when the user opts in via the link-intent toggle (server: `as: 'playlist'`) |
| **slskd**                 | n/a — slskd downloads are by-folder / by-album, not by-playlist | n/a                                                                                                                                                                                                                                         | no (out of scope)                                                                |

**Why slskd is out of scope** (explored, decided against): a Soulseek
acquisition starts from a peer's _folder_ — an album or a discography dump —
so there is no source-side playlist object to mirror; the unit a user asks
for is already the unit that lands. If a "folder as playlist" affordance ever
proves wanted, the `as: 'playlist'` override + `acquire_job_tracks` plumbing
is source-agnostic and would extend to it without schema changes — but slskd
transfers don't run through `AcquireWatcher` today (they're `album_jobs` /
hunt flows), so wiring it means teaching that pipeline to emit track rows,
not a classifier tweak.

**Tracks you already own are absent from the generated playlist** (accepted
trade-off): a playlist track that dup-skips at ingest (already in the
library) never gets an `acquisitions` row for this job's URL, so the resolver
can't include it. The generated playlist mirrors _what this job landed_, not
the source playlist's full tracklist. Revisit if users read this as "missing
songs".

## Retry / dedupe contract

- **Idempotent submit** (existing dedupe guard in `submit()`): if the
  URL already has a `queued`/`running` job, the second submit returns
  the existing `jobId` — no second playlist created.
- **Retry**: reuses the same `jobId`. When `playlist_id` is set and the
  playlist still exists **and is owned by the retrying user**, the
  post-ingest step refreshes it in place (same id, contents replaced) —
  no duplicate playlist per retry. If the user deleted it (the FK sets
  `playlist_id` NULL) or a _different_ user retries, a fresh playlist is
  created, owned by the retrier. `acquire_job_tracks` rows survive the
  retry and update in place as the plugin re-emits them.
- **Partial downloads**: only landed tracks make it into the
  generated playlist (per the resolve helper's status filter).
  Truncated downloads also surface as a "X of N" warning on the job
  row — same UX as a non-playlist acquire.
- **No retroactive generation**: pre-feature jobs (`is_playlist=0`)
  never get a playlist, even after a re-submit (the dedupe guard
  short-circuits to the existing job).

## Privacy / multi-user

Each user gets their own copy of the generated playlist (matches the
existing private-playlists model). The `playlists.user_id` FK scopes
visibility — a listener can't acquire, so they never get a playlist
generated on their behalf. Acquiring users get a `kind='user'` playlist
under their account; the schema already supports per-user playlist
visibility.

## Web UX

### Link-intent card (search omnibox)

- Spotify playlist URL → chip + Get button (no toggle — auto-detected).
- archive.org URL → chip + "Treat as playlist" checkbox (only when the
  job isn't already running) + Get button.
- YouTube playlist → chip + Get button (no toggle).
- Non-playlist sources → unchanged.

Toggling the checkbox flips a client-side signal that the submit
handler sends to the server as `as: 'playlist'`. The default is
`'album'` (the safer legacy behavior). A fresh URL resets the toggle.

### Downloads card

For a playlist-classified job that completed, the row offers:

> **Open playlist** → `/library/playlists/<id>`

instead of the existing **Open in Library** / **View N albums**
openers. The link wins over both (`@if canOpenPlaylist() @else if
canOpen()` in the template), because a playlist spanning many albums
is a more useful destination than any single album.

For jobs without a `playlistId`, behavior is unchanged (legacy
pre-feature rows, non-playlist acquires, in-flight jobs).

### Library tab

The new `kind='user'` playlist appears alongside the user's existing
playlists — same visibility / sharing UX as any user playlist.

## Tests

- Unit: `packages/core/src/types/classify-acquire-url.test.ts` —
  classifier returns the right kind for every supported URL pattern.
- Unit: `packages/api/src/services/acquire-playlist.test.ts` —
  `resolveAcquireJobTracks` joins `acquire_job_tracks` → `acquisitions`
  → `library_songs` correctly, de-dups, respects status, scopes by
  source_ref; stem matching across an extension change; title-only rows
  - `"Artist - "` prefix stripping (exact match wins).
    `recordAcquireJobTrack` — append order, in-place re-emit updates,
    title-only rows, retry idempotence.
- Unit: `packages/api/src/services/plugins/acquire/process.test.ts` +
  `ytdlp/index.test.ts` — the tab-delimited marker parse and, critically,
  that the FULL `TrackEvent` (path included) crosses the
  `runAcquireProcess.onTrack` → `emitTrack` seam. **Do not weaken these
  into title/status-tuple assertions**: dropping `path` at that seam is
  invisible to every downstream unit test (the watcher tests seed
  `acquire_job_tracks` themselves) and shipped as the launch bug.
- Unit: `packages/api/src/services/acquire-watcher.test.ts` —
  playlist generation describe block covers the classifier-driven
  `is_playlist` flag, the `as` override, the user-id guard, and the
  end-to-end post-ingest materialize (with a fake plugin emitting
  `acquire_job_tracks` rows).
- Unit: `packages/api/src/routes/acquire.test.ts` — playlist submission
  wiring describe block asserts the route forwards `userId` + `as` to
  the watcher on POST / and on POST /jobs/:id/retry.
- Unit (web): `packages/web/src/app/components/download-item/download-item.component.spec.ts`
  — `canOpenPlaylist` + `resolvePlaylistRoute` + the template's
  playlist-first branching.
- e2e: `packages/e2e/tests/playlist-from-acquire.spec.ts` — the
  link-intent toggle renders for archive URLs only (the spec enables the
  archive plugin itself — no resolve plugin is enabled on a fresh e2e
  server — and disables it after), the route accepts `as` on an
  authenticated submit (API calls attach `bearer(token)` explicitly —
  the Playwright `request` fixture is NOT authenticated by
  `storageState`), the playlist deep-link testid is correctly
  conditional on `playlistId`. See docs/e2e.md "What the e2e environment
  does NOT give you" for both environment rules. The full materialize
  step can't run in CI (spotdl needs YouTube egress + Spotify creds), so
  the e2e suite covers the user-facing surface, not the post-ingest
  orchestration. CI is wired through the shared `playwright test`
  invocation in `.github/workflows/ci.yml`'s `e2e` job.
