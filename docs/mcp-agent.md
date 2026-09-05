# MCP agent access (issue #232)

Lets an external MCP-speaking LLM/agent connect to a user's own NicotinD install
and **organize / curate** the library on their behalf, authorized at the
**`refiner`** level — library curation, never server admin. The secure backend,
the MCP endpoint, destructive delete tools, and the Settings UI to mint tokens
are all shipped.

## Why refiner

The role ladder is `listener < user < refiner < admin` (`@nicotind/core`
`roles.ts`). `refiner` is exactly "curate the library" — it's what relaxes
`requireAdmin`→`requireCurator` on the edit/merge/metadata routes — and it
deliberately excludes user management, backups, and server config. So an agent
token capped at refiner is the right boundary: curation works, server-admin
403s.

## Token model — `agent_tokens`

A new revocable-row credential (`db.ts` `agent_tokens`), the third instance of
the codebase's scoped-token shape after `pairing_tokens` / `paired_devices`:

- **Opaque, not a JWT.** The row *is* the credential, so revocation is instant
  and unconditional (a stateless JWT would stay valid until expiry). The token is
  `nca_<32 random bytes, base64url>`; the prefix makes a leaked secret greppable.
- **Only the sha256 hash is stored.** A leak of the table never leaks a live
  token — a stronger posture than `pairing_tokens`' raw storage, justified because
  these are long-lived.
- **Effective role capped at `refiner`** (`AGENT_EFFECTIVE_ROLE`) regardless of
  the owner's role, so an admin who mints a token does **not** get an admin agent.

Service: `services/agent-tokens.ts` — `mintAgentToken` (returns the raw secret
exactly once), `verifyAgentToken` (hash lookup → not-revoked → not-expired →
touches `last_used_at`; never throws), `listAgentTokens` (never the hash),
`revokeAgentToken` (scoped to the owner, so no one can revoke another's token).

### Management routes

`routes/agent-tokens.ts`, mounted at `/api/agent-tokens` behind the **normal JWT
auth + `requireCurator`** (a logged-in curator manages the agents that will
curate *their* library):

- `POST /` — mint (`{ name, scope?, expiresInDays? }` → `{ id, name, scope,
  token }`, the token shown once). Audit-logged (`agent-token.mint`).
- `GET /` — list the caller's own tokens (no secret).
- `DELETE /:id` — revoke (audit-logged `agent-token.revoke`).

## Transport — MCP endpoints inside the Hono app

`routes/mcp.ts`, mounted at `/api/mcp`. Chosen over a standalone MCP server
process so **one deployment** serves both the desktop's `127.0.0.1` backend and a
self-hosted web install with zero extra process to supervise. The protocol is
hand-rolled JSON-RPC 2.0 (`initialize` / `tools/list` / `tools/call` / `ping`) —
no heavy `@modelcontextprotocol/sdk` dependency, consistent with the project's
dependency discipline and the small tool surface.

**Auth is the agent token, not the app JWT** — `/api/mcp` is deliberately *not*
in the blanket-auth list. Each POST reads `Authorization: Bearer nca_…`, verifies
it, and runs capped at refiner. An invalid/revoked token → 401.

## Tool surface (read + safe-curation + destructive writes)

`MCP_TOOLS` is the registry; each tool declares `access: 'read' | 'curate'` and
an optional `destructive` flag. `checkToolAccess` (pure, unit-tested) is the
guard: a `curate` tool needs the `:curate` scope (a `refiner:read` token is
refused), and a `destructive` tool needs `args.confirm === true`. `dispatchTool`
applies it, then `missingRequiredArgs`, then runs the handler; every write is
audit-logged.

| tool | access | fronts |
| --- | --- | --- |
| `search_library` | read | library artists/albums/songs by name, via the shared folded matcher |
| `get_library_health` | read | `services/library-health.ts` `libraryHealth` — the curation-pass entry point |
| `list_recent_songs` | read | recently-landed songs, newest first, paged, optional missing-genre filter |
| `get_artist` | read | one artist + their albums |
| `get_album_tracks` | read | one album: header (year/classification/cover status) + songs with genre, track/disc, suffix, bitrate |
| `set_song_genre` | curate | `services/song-genre-mutate.ts` `mutateSongGenre` + `song.genre` audit |
| `lookup_song_metadata` | read | `services/candidate-sources.ts` `gatherSongCandidates` + `services/title-clean.ts` `cleanDisplayTitle` |
| `identify_song` | read | `services/identify.ts` `identifySongById` — fpcalc + AcoustID only, the narrow fingerprint lane |
| `fix_song_metadata` | curate | `services/song-metadata-mutate.ts` `mutateSongMetadata` + `song.metadata` audit |
| `lookup_album_metadata` | read | `services/candidate-sources.ts` `gatherCandidates` — the album-scoped candidate search behind the web metadata-fix modal |
| `fix_album_metadata` | curate | `services/metadata-fix.ts` `applyMetadataFix` + `album.metadata` audit |
| `set_album_cover` | curate | `services/album-cover-mutate.ts` `applyAlbumCover` + `album.cover` audit |
| `set_album_classification` | curate | `LibraryCurator.setManualOverride` + `album.classify` audit |
| `flag_for_review` | curate | `services/curation-flags.ts` `createCurationFlag` + `curation.flag` audit |
| `list_review_flags` | read | the open human-review queue, oldest first |
| `resolve_review_flag` | curate | `services/curation-flags.ts` `resolveCurationFlag` + `curation.flag` audit |
| `complete_album` | curate, **destructive** | `services/album-acquire.ts` `acquireAlbum` (only-missing-tracks hunt) + `album.acquire` audit |
| `delete_song` | curate, **destructive** | `services/library-deletion.ts` `deleteOne` + `song.delete` audit |
| `delete_album` | curate, **destructive** | `services/library-deletion.ts` `deleteAlbum` + `album.delete` audit |
| `merge_artist` | curate, **destructive** | `services/artist-identity-mutate.ts` `mutateArtistIdentity` (merge mode, one or many raw names) + `artist.identity` audit |

### `search_library` matches the way the UI does (issue #706)

`search_library` is the **only** discovery tool on this surface, and it used to
match with a raw `LIKE ? COLLATE NOCASE`. SQLite's `NOCASE` collation is
ASCII-only: it folds neither diacritics nor a non-ASCII upper case. Against a
table holding `Américo`:

```
LIKE '%Americo%' NOCASE -> []
LIKE '%AMÉRICO%' NOCASE -> []      <- even the correctly-spelled query, in caps
LIKE '%américo%' NOCASE -> ["Américo"]
```

The harm is not a missed result, it is a **wrong conclusion**. An agent doing
what this document describes — find the canonical artist, merge the junk name
into it — searched for the canonical name, got nothing, concluded the artist did
not exist, and minted a duplicate instead of merging. On a Spanish-language
library that is the common case, not the edge case.

It now routes through `services/search-tokens.ts` (`tokenize` /
`matchesAllTokens` / `rankBy`), the same matcher `routes/library.ts`,
`catalog-search.service.ts`, `playlist.service.ts` and
`providers/library-provider.ts` use: SQL does the cheap row gating, JS does the
folded per-token AND match. The agent and the curator now find the same things.

`check:shared-helpers` could not have caught this — `routes/mcp.ts` never
re-declared `matchesAllTokens`, it *bypassed* it, and a name-based check cannot
see a bypass. `check:search-matching` asserts that invariant instead of the
symbol. → [quality-gates.md](quality-gates.md)

### A case/accent duplicate is a rename, not a refusal (issue #707)

`merge_artist` used to refuse any `mergeInto` that normalized the same as
`rawName`, on the reasoning that a same-normalized pair is a rename rather than
a merge. Correct on its own terms, and it made the tool unable to fix the only
artist duplication this library actually accumulates.

Measured over the **2,000 most recently added prod tracks** (2026-07-26 →
2026-08-25): 13 duplicate artist identities, **12 refused** by that guard and
**1 accepted** — and the accepted one (`ME` → `&ME`) was a false positive that
must *not* be merged. The boundary was inverted: it blocked all 12 safe repairs
and permitted the single risky one.

| canonical | duplicate spelling | tracks split |
| --- | --- | --- |
| `Héroes del Silencio` | `Héroes Del Silencio` | 53 / 3 |
| `Los Rodríguez` | `Los Rodriguez` | 23 / 2 |
| `Bandana` | `BANDANA` | 11 / 12 |
| `Ángela Leiva` | `Angela Leiva` | 2 / 7 |

A same-normalized target now routes to the **rename** path
(`library_artist_identity`'s alias fix), which is what the curator UI has always
done for this and what `mutateArtistIdentity`'s `rename` branch already allowed.
The alias write is byte-identical either way — only the reported `kind` differs,
and it reports `renamed`, so a curator reading the audit ledger can still tell a
respelling from a genuine two-artist merge. A batch can therefore hold both
kinds; each name carries its own `kind` in `merged[]`, and the top-level `kind`
reads `mixed` rather than mislabelling half the call. Only a **byte-identical**
target is still refused, since that is a true no-op.

### `list_recent_songs` (issues #676, #678)

`search_library`'s missing "browse" counterpart to its "search" — a curator (or an
agent asked to "curate the most recent downloads") had no way to list songs by
recency at all, and no way to filter for songs missing a genre without guessing
substring queries. Sorts by `landed_at` (indexed, "when curation actually
finished") rather than `created` (file mtime, unindexed on songs), reusing the
same `landed_at IS NOT NULL` quarantine-safety filter `search_library` already
applies. `missingGenre` reuses the `WHERE (genre IS NULL OR genre = '')` idiom
already used by the background genre-enrichment task. Real `limit`/`offset`
pagination — a page shorter than `limit` means no more results, so no separate
`COUNT(*)` call. Read-only, so (like the other 3 read tools) it does not call
`recordAudit`.

### `set_song_genre` (issue #677) — and the audit gap it exposed (#681)

Genre is the property a curating agent most often needs to *write*, and until
now the tool surface could only read it. Wiring it took the same extraction the
delete and merge tools took: the write is now
`services/song-genre-mutate.ts` `mutateSongGenre(db, { musicDir }, songId, body)`
— genre-list parsing, the song-scoped `library_genre_overrides` row for
`mode: 'replace'`, the `library_song_genres` rewrite, and the file-tag mirror —
called by both `POST /api/library/songs/:id/genre` and the MCP tool. `runSync`
and `recordAudit` stay caller-side, matching `deleteOne` / `mutateArtistIdentity`.

`mode` defaults to **append**, so an agent that resolves one missing genre never
clobbers a set a human curated; `replace` writes the durable song-scoped
override.

The `genre` argument is split on `;`, `,` and `|` — the scanner's own separators,
so a curated genre is always a value a rescan can reproduce, and a genre name
therefore cannot contain one of them. The tool description promised `;`-only
until issue #913 corrected it. → [genre-model.md](genre-model.md)

Extracting it surfaced **issue #681**: the artist-scoped genre route has always
called `recordAudit(…, 'artist.genre', …)` and the song-scoped one called nothing
at all, so every per-song genre edit a curator made through the web UI was
invisible in the audit log. Both callers now write `song.genre`, the MCP one with
the usual `(via MCP agent)` suffix.

### Batch merges (issue #680)

One root cause routinely produces several corrupted spellings of the same artist
— a single DJ-set-tag cluster needed **7** sequential `merge_artist` calls. The
tool now also takes `rawNames: string[]` (≤50, deduped) sharing one `mergeInto`,
one `confirm`, and **one** resync at the end instead of one rescan per name.
Failures are per-name (`failed[]`) rather than aborting the batch, and each
successful merge still writes its own `artist.identity` audit row keyed on that
raw name, so the log stays greppable per artist. `kind` and `artistId` remain
top-level — every name in a batch lands on the same target — so the one-name
call's response shape is unchanged.

### The third option: `flag_for_review` (issue #682)

A curating agent regularly meets a case it can *see* but must not resolve alone —
a `b2b` credit naming two acts, an identity with no confident target. Before this
there were only two moves: **act** (guess) or **say nothing durable** (mention it
in a chat transcript nobody re-reads). A flag is the third, and it is deliberately
**inert**: it writes to `curation_flags` and changes no library data, it only
records that a decision is owed.

Why its own table rather than widening `download_reviews`: that one gates a
download *before* it lands and its pending set is **derived** from scanner state
(so it can never drift); this is post-landing, about identity and metadata
ambiguity, and these rows *are* the record. A partial unique index keeps **one
open flag per target**, so an agent re-running its sweep updates the reason
instead of minting a row per pass — the failure mode that would otherwise turn a
queue into a feed.

Listing rides the shared `ServiceReview` snapshot (`reviewFlags`) rather than
adding a poller, per the one-resource rule, and surfaces as the Admin
**Needs review** card with a Resolve button. Curators can also raise and clear
flags over `POST /api/library/review-flags` and
`POST /api/library/review-flags/:id/resolve`.

This pairs with #679's `djSetArtistName`, which returns null precisely on the
ambiguous `b2b` case — the sanitizer declines to guess, and this is where that
case now goes instead of being lost.

### `get_library_health` / `resolve_review_flag` (issue #734)

Two real curator passes measured the same discovery failure: with only name-shaped
reads, an agent finds problems *incidentally* — artists it happened to search for,
songs that happened to be recent. There was no bulk "what needs fixing" view (the
audit ran only via SSH), so a pass could neither plan nor prove progress.

`get_library_health` wraps `libraryHealth` (`services/library-health.ts`, → see
docs/library-audit.md "Library health report"): every curation dimension as a
metric + bounded worst-first worklist + remediation hint. The intended loop is
**snapshot → work the worklists → snapshot again**, so a pass records its own
delta. The completeness dimension's `suspected` bucket is advisory-only — the
tool description says so, and the agent rule stands: ambiguity goes to
`flag_for_review`, never a guess.

`resolve_review_flag` closes the loop `flag_for_review` opened: session 2 of the
curator pass ended with four researched, answerable flags that *no agent could
close* — resolution was web-UI-only, so agent-raised flags accumulated forever.
It wraps the same `resolveCurationFlag` the HTTP route calls, audits as
`curation.flag` with the decision note, and refuses to re-resolve (idempotence
stays visible: "Flag not found or already resolved", no audit row).

`get_album_tracks` also grew an album header (year, classification, hidden,
`hasCanonicalCover` via the shared `missingAlbumArtSql`) and per-song
track/disc/suffix/bitrate — read parity so an agent can *see* the states the
upcoming album write tools will fix, without another tool.

### Album curation writes (issue #735)

The curator passes' hardest wall: album-level fixes (retag a watermark album, fix a
mis-classification, set a missing cover) were web-only, so the agent could *find*
6 misplit clusters and wrong-field watermarks and fix none of them. Each tool
wraps an existing tested module — nothing new was invented:

- **`fix_album_metadata`** wraps `applyMetadataFix` (the DB-override album fix:
  artist/title/year/releaseType/cover, merges album rows, survives rescans, never
  moves files). One consequence is load-bearing: album ids are name-derived, so a
  rename **re-mints the id** — the response's `albumId` is the new one and the
  tool description tells the agent to use it thereafter.
- **`set_album_cover`** wraps the new `services/album-cover-mutate.ts`
  `applyAlbumCover` — extracted from the inline `POST /albums/:id/cover` body so
  HTTP and MCP share one tested module (fifth instance of the shared-mutation
  lineage). Canonical-URL mode or embedded-picture→folder-cover mode. There is
  deliberately **no cover-candidates MCP tool**: `lookup_album_metadata` already
  returns candidate `coverUrl`s, and visual judgement stays in the web picker —
  the agent's use case is "no cover at all → apply the confident candidate".
- **`set_album_classification`** wraps `curator.setManualOverride`, folding the
  reclassify/hide/unhide routes into one tool and closing the measured
  "classification unreachable over MCP" gap.

Extracting these exposed that the HTTP album routes recorded **no audit at all**
(issue #733, the #681 pattern again): `POST /albums/:id/metadata`, `/reclassify`,
`/hide`, `/unhide` and both cover routes now `recordAudit` as `album.metadata` /
`album.classify` / `album.cover` — the same action names the MCP tools write with
their `agent:<tokenId>` actor.

### `complete_album` (issue #735) — acquisition behind the destructive gate

The owner's call for the standardized curation pass: completion includes
*acquiring the missing tracks* of incomplete albums, curator-approved per album.
The tool is `destructive: true` even though it deletes nothing — the `confirm`
gate **is** the per-album approval, and the destructive contract is the right
one for a tool that spends bandwidth/disk and contacts peers.

Order of refusals is deliberate: resolve the album, then the **kill-switch**
(`isAcquisitionEnabled` — the runtime toggle with the `NICOTIND_ACQUISITION=off`
env floor an agent cannot lift), then Lidarr-id resolution in owner-approved
scope: **(a)** the newest `album_jobs` row for the artist/title pair (proven
canonical tracklist — the health report's confirmed-incomplete population),
**(b)** a `lidarr.album.lookup` hit whose title `normalizeForGrouping`-matches;
anything else errors toward the web catalog flow — no Lidarr provisioning from
the agent surface in v1.

The hunt itself is `acquireAlbum` — the watchlist/auto-acquire shared core — so
every idempotence guard rides along: `already-complete` comes back as a notice
(never an error), an addon-side 409 maps to `in-flight`, and only the tracks not
already on disk are enqueued. Every call that reaches the hunt is audited as
`album.acquire` with `outcome=<x> lidarrAlbumId=<n>`. The runbook budget
(≤10 hunts per session) lives in docs/curation-playbook.md, not in code —
it bounds curator attention, and idempotence makes re-runs free.

### Destructive writes: the extraction that unblocked each one

The delete path used to be inline in `routes/library.ts` (folder-first `rmSync`
+ row delete) — fronting that to an LLM safely needed the logic **extracted
into a shared, tested service first**, which is now `services/library-deletion.ts`
(`deleteOne`, `deleteAlbum`, plus the path-resolution/fuzzy-match/cleanup
helpers they need). Both the HTTP routes (`DELETE /albums/:id`, `DELETE
/songs/:id`, `POST /songs/bulk-delete`) and the two MCP delete tools call the
**same** functions — `db`, `musicDir`, and a `ShareRescanScheduler` instance are
explicit params rather than closures, so each caller wires its own dependencies
(`mcpRoutes(musicDir, slskdRef, dataDir, runSync)` constructs its own debounced
scheduler, mirroring the one `libraryRoutes` already builds). `delete_album`/
`delete_song` reuse the exact `recordAudit` action names (`album.delete`,
`song.delete`) the HTTP routes use, with a `(via MCP agent)` suffix on the
detail string so an audit-log reader can tell the two apart.

**`merge_artist` (issue #339) got the same treatment.** The rename/merge/
one-act/split decision logic that used to live inline in
`POST /api/library/artists/identity` is now `services/artist-identity-mutate.ts`
`mutateArtistIdentity(db, { dataDir }, body)` — it mints the
`library_artist_aliases` row (or the `library_artist_identity` row for
single/split) and carries curation (`carryArtistCuration`) to the new artist id,
but deliberately does **not** resync the library or `recordAudit` itself: those
stay caller-side, same as `deleteOne`/`deleteAlbum`, since the HTTP route
formats a richer audit detail string than the MCP tool needs. The MCP tool
surface is narrower than the route's: only `merge_artist` (mergeInto) shipped —
`single`/`split` are exposed to the curator UI but not to an agent, since a
merge is the one case with an unambiguous, single, LLM-describable target name
and a split's member list is harder to hand to a tool call safely.
`artistIdentity: { dataDir, runSync }` on
`McpToolContext` is separate from `deletion` — a different HTTP route wires
these in `index.ts` (`expandedDataDir`, `runSyncAndCurate`), so `mcpRoutes` now
takes both pairs of deps explicitly rather than growing an implicit shared
context object.

### `lookup_song_metadata` / `fix_song_metadata` (issue #722)

YouTube-sourced downloads land with the raw video title ("Pegao (Official
Video)", "(Audio Oficial)", "[Lyric Video]"), and because the scanner derives
`album = title` for loose singles, each one also mints a fake single-track
album mirroring the junk. The agent could *see* the pollution but had no tool
to look up what the track is really called or where it belongs, and none to fix
it. These two tools are that pair — and their write goes through the same
shared module as `PATCH /api/library/songs/:id/metadata`, per the extraction
rule the other curate tools established.

- **`lookup_song_metadata` is the surface's first outbound-network tool.** It
  fronts `gatherSongCandidates`, the song-scoped sibling of the album
  candidates gatherer: Lidarr album lookup, the MusicBrainz *recording* search
  (track title → best Official release — the one track→album call in the
  codebase), Discogs `release-candidates`, the file's own tags, and an opt-out
  AcoustID fingerprint (`fingerprint: false`), each timeout-bounded with a
  down source degrading to `ok:false` in `sources` rather than failing the
  call. It also always returns an offline `suggested` block from
  `cleanDisplayTitle` — a conservative whole-segment junk vocabulary that
  strips "(Official Video)"-class noise while preserving "(Remix)", "(En
  Vivo)", "(feat. X)" (deliberately unlike core's query-only
  `stripTitleQualifiers`, which strips every bracket). The vocabulary also
  covers reissue labels (`remaster*`, with year-like tokens, `version` and
  `edition` as modifiers), and `scripts/normalize-titles.ts` applies the same
  cleaner to rows already in the library — see
  [library-scanner.md](library-scanner.md).
- **`fix_song_metadata` retags the file in place and rescans — it never moves
  or renames it.** `songId` is path-derived, so playlists/likes/history keep
  pointing at the song; the *name-derived* album id re-minting on rescan is
  the point — the fake single-album dissolves, merging into the real album
  when the cleaned name collides with its group key. This follows the
  retag-vs-override doctrine ([download-review.md](download-review.md)):
  `applyMetadataFix`/`library_metadata_overrides` stay album-scoped (they have
  no title column) and a per-song title is a file-tag fact. The tag write is
  guarded by `buildIdentifyApplyTags` — add/replace only, a value can never be
  cleared — and is `curate` but not `destructive`: like `set_song_genre` it is
  a reversible, audited write, not a delete.
- **`applied` is read back, never echoed (issue #776).** It used to return the
  *request*, so a write that never reached the row was indistinguishable from
  success. `mutateSongMetadata` now re-reads the song after the rescan: a
  divergence fails with `Tag write did not persist` plus `requested` and the
  `actual` row values, and a success carries `verified: true` with the values
  actually on the row. Without a rescanner wired there is nothing to read back
  through, so the result says `verified: false` rather than claiming a check it
  did not perform. Anything automating retags — an agent, the `normalize-titles`
  bulk pass — depends on this to avoid reporting a clean run having changed
  nothing.
  **`albumArtist` was missing from this check entirely (issue #865).** It is
  written into the file tag (`writeAudioTags`) exactly like the other four
  fields, but `SongMetadataSnapshot`/`readSnapshot`'s `SELECT`/the divergence
  block/`pickApplied` only ever named title/artist/album/year — so
  `applied.albumArtist` on a *successful* response was always the request
  echoed straight through, unverified, and a call that changed nothing on a
  file whose shape made the scanner decline the field (e.g. `COMPILATION=1`)
  still came back `verified: true`. All four now cover `albumArtist` the same
  way they cover every other field; there is no longer a fifth, silently
  unchecked column.

### A missing argument is an error, not an empty result (issue #778)

`missingRequiredArgs` (pure, unit-tested) rejects a call whose declared-required
argument is absent, naming both the keys the tool wants **and the keys the
caller sent**. Before it, a wrong key resolved to `undefined`, got queried,
missed, and the miss was reported as *data*: `get_artist({name})` answered
`{"error":"artist not found"}` and `get_album_tracks({albumId})` answered
`{"album": null, "songs": []}` — both of which read as "the library does not
have this".

That is not hypothetical. During the 2026-08-28 curation pass three consecutive
`{album: null, songs: []}` responses were read as *the tool being broken*, and
the album-sibling technique — which had closed 49 genre gaps in a single earlier
pass — was written off as unavailable. The key was wrong each time. Separately,
three planning subagents each invented a *different* wrong signature for
`merge_artist`. Wrong-key calls are a routine failure mode for this surface, so
the guard is driven by each tool's own `inputSchema.required` rather than by
per-handler checks: every tool, including every tool added later, is covered by
construction.

Present-but-falsy is present — `confirm: false` and `year: 0` are real values,
and the confirm gate owns the former. Only `undefined`, `null`, a blank string
and an empty array count as missing. The guard reads the schema and never
invents a requirement: `complete_album` declares only `confirm`, because
`albumId` and `artist` + `album` are alternatives its handler arbitrates.

### An HTML entity in a name is refused, not stored (issue #787)

`htmlEntityArgs` is the same guard shape one step later in `dispatchTool`: a
string argument matching a named or numeric HTML entity is refused with the
character it probably meant.

```
"fix_song_metadata": `artist` contains the HTML entity "&amp;".
Send the bare character ("&"). MCP arguments are not HTML-escaped,
so this would be stored literally.
```

This is **not** a server bug in the strict sense — JSON carries no escaping
convention, so `&amp;` is a legitimate five-character string and the server is
right not to unescape it. But on the fields where it shows up it is a mistake
essentially every time, and unlike the wrong-key case above it is **durable**:
it lands in the library instead of bouncing. An agent that wrote `&amp;` got an
artist row literally named `Wisin &amp; Yandel`; `&lt;` produced an album
literally named `while(1&lt;2)`. Both happened during real curation passes, and
each needed a follow-up **destructive** `merge_artist` to undo — which is the
asymmetry that justifies refusing a technically-valid string.

Like `missingRequiredArgs` it is pure, unit-tested and applied to every tool by
construction, and it walks arrays because the identity arguments that matter
most (`merge_artist.rawNames`) are lists of names. `reason` and `note` are
exempt: they are free text written for a human to read, never an identity, so
quoting an entity in one is a legitimate thing to do.

### `identify_song` — identity from the audio (issue #777)

Fingerprint identity answers questions no tag-derived tool can: a junk or
episode-numbered filename (`CD A 2000.opus`), a watermark bucket (IPAUTA,
SharingDB.top) where every field is polluted, and true cross-format duplicates —
the `(title, artist, duration)` heuristic a curation pass used to delete 29 dupes
misses an mp3-320-vs-opus pair.

**For dedupe the identity is `recordingId`, not `acoustId`** (issue #789).
`acoustId` is a fingerprint *cluster*, and AcoustID can hold two unmerged
clusters for one recording: measured on prod, four files of `Vilma Palma e
Vampiros — La pachanga` carry **two** acoustIds and **one** `recordingId`. So the
same `acoustId` proves the same recording, while a different `acoustId` proves
nothing and needs the `recordingId` comparison. A match can also arrive with no
`recordingId` at all (2 of 14 in a random sample) — a fingerprint hit AcoustID has
not linked to MusicBrainz, still a real identification but with nothing to dedupe
on. Duration is no substitute either: 162s and 163s are one recording here, while
163s and 225s are two.

The fingerprint was already *reachable* before this tool: `lookup_song_metadata`
runs it by default and returns the typed outcome. What was missing is a way to
ask for **only** that. `lookup_song_metadata` fans out to ~4 outbound sources
per call and is measured to 502 the origin above ~4 concurrent calls (#757), so
the one lane that is safe to batch was locked behind the one that is not.
`identify_song` is fpcalc plus a single lookup.

It suggests only — applying stays `fix_song_metadata`, so the write keeps its
audit row and its add/replace-never-clear guard. The typed `outcome` is the
point: `no-match` (genuinely unknown to AcoustID — common for regional and
long-tail catalogue), `undecodable` (**the file** is likely truncated or corrupt
— a triage signal, not a metadata answer), `fpcalc-missing` (a deployment gap,
no file at fault), `file-missing`, `source-error` (retry later). Every refusal
before the attempt is likewise distinct: an agent that cannot tell "no plugin
configured" from "the audio matched nothing" records the second as a fact about
the recording — the same empty-result-as-data failure #778 fixes on the argument
side.

**It carries no genre, by construction.** `IdentifyResult` has no genre field;
its only genre path is `recordingId` → MusicBrainz tags, which measured *empty*
for this library's long tail (`Los Rebujitos`, `Niklas Dee`: `genres: []`,
`tags: []`). It is also strictly weaker than what already failed — `genre-audio`
is a real audio classifier that has listened to these files and ledgered 2,142
of them as below-threshold
([genre-audio-confidence-2026-08.md](measurements/genre-audio-confidence-2026-08.md)).

Two premises this tool was proposed on turned out to be wrong and are recorded
so nobody re-derives them: `fpcalc` **does** ship in the runtime image (#549
installs `libchromaprint-tools`), and the AcoustID API key **was** configured on
prod — the Extensions card read UNAVAILABLE because a blank optional config
field defeated the plugin's own default (#781). A proposed `undecodable`
health-report rollup was dropped on measurement: across 26,000 ledger rows the
prod library has **no** decode-failure population at all (the `bpm`/`key` rows
are low-confidence analysis, not corruption), so the dimension would have
reported zero against a denominator that does not mean what its name says.

## Origin and rare genres (issues #759, #761)

Two gaps a curation pass hit that the MCP surface could not express at all.

**`set_artist_origin` + origin/MBID on `get_artist`.** The library resolved `Emilia` (Emilia
Mernes, Argentine) to Sweden — plausibly Emilia Rydberg, who performs under the same bare name.
`get_artist` returned `id`/`name`/`albums` only, so an MCP-only curator could not see the wrong
value, let alone fix it; the sole surface was the web UI's `ArtistOriginComponent`.

`get_artist` now returns `origin` **and `mbid`** together, deliberately. A wrong origin is almost
always *inherited* from a wrong MBID on a homonym — `routes/library.ts`'s own MBID-correction
docblock uses "Emilia → ten exact hits" as its example — so an agent shown only the country will
keep correcting the symptom while the bio, Discogs genres and artist image stay wrong. Seeing both
is what makes "the MBID is wrong, escalate" a possible conclusion. Correcting the MBID itself
remains web-only (`PUT /api/library/artists/:id/mbid`).

`country: null` is a decision, not an absence: it writes the permanent `user` tombstone that stops
the MusicBrainz pass re-deriving the wrong value, so `mutateArtistOrigin` distinguishes an explicit
`null` from a missing key. The write is `services/artist-origin-mutate.ts`, shared with the HTTP
route — the fifth instance of the one-tested-write doctrine.

**`get_rare_genres`.** A genre carried by one or two songs library-wide is usually a mistag, a
scanner mis-split, or an over-specific tag that should fold into a broader one. Nothing on the
surface could ask: the health report's `genres` dimension counts genre-*less* songs,
`list_recent_songs(missingGenre)` filters the same, and `search_library` is text-match — leaving
"tally 16k songs client-side over per-call limits", which is not a workaround.

`rareGenres` counts the **primary** genre only (`position = 0`): a rare *secondary* tag is ordinary
enrichment noise, while a rare primary is what actually mis-files a song. It excludes hidden
artists, so the denominator matches the rest of the curation surface.

## Batch lookups have a concurrency ceiling (issue #757)

`lookup_album_metadata` / `lookup_song_metadata` each fan out to ~4 outbound sources, so N parallel
MCP calls is ~4N outbound requests. A pass running batches of ~10 measured two consecutive
`origin_bad_gateway` 502s mid-batch (prod, 2026-08-26), with earlier and later batches of the same
size succeeding.

Both tool descriptions now carry the ceiling — **concurrency ≤ 4, back off on 502, `retry_after` is
authoritative** — rather than only this page, because the description is what an agent actually
reads. Whether the 502 originates in `nicotind` under load or in a source upstream of it is still
unconfirmed and needs prod-side measurement; the guidance is a floor, not a diagnosis.

## Settings UI

`pages/settings/agent-tokens/` (`AgentTokensComponent` +
`AgentTokensApiService`, mirroring the paired-devices settings page) mints
(shown once, with a copy affordance), lists, and revokes tokens against the
already-wired `/api/agent-tokens` routes. Reachable from Settings → Account
→ "Agent tokens →", gated on `auth.canCurate()` client-side (a new
`curatorGuard` in `guards/auth.guard.ts`, mirroring `adminGuard`) to match the
server's `requireCurator` gate on the same routes.

## Left as follow-ups

- **single/split artist-identity tools** — `merge_artist` (issue #339) shipped,
  and it now reaches the `rename` kind too (see "A case/accent duplicate is a
  rename" below); `single` and `split` are exposed to
  `services/artist-identity-mutate.ts` already but have no MCP tool wrapping
  them yet, since neither has an unambiguous single target name to hand an LLM.
- **Acquisition tools** — `acquire_album` shipped as `complete_album` (issue
  #735, see its section above); `add_to_watchlist` remains open, same shape of
  work.
- **Reuse existing routes via internal dispatch** — as the tool surface grows,
  fronting the real Hono routes (with a short-lived internal refiner token)
  instead of re-implementing each write keeps the MCP surface from drifting.

## Tests

`services`/`routes`: `routes/agent-tokens.test.ts` (mint/verify/list/revoke,
hash-only storage, expiry, revocation scoping, curator-gating, mint-once) and
`routes/mcp.test.ts` (401 without a token, initialize/tools-list/tools-call, a
read tool, `list_recent_songs`'s recency ordering + quarantine exclusion +
`missingGenre` filter + `limit`/`offset` paging, `set_song_genre`'s append /
`replace`-override / unknown-song / read-only-token paths, `merge_artist`'s
batch `rawNames` form including a partial failure, the audited curate write,
read-only-token refusal, `flag_for_review`'s record/inertness/bad-kind/scope
cases and `list_review_flags`' ordering, `delete_song`/`delete_album` against a real temp-dir
music folder — confirm gate, scope gate, and the audited happy path —
`lookup_song_metadata`'s read-only-token offline suggestion + unknown-song
payload, `fix_song_metadata`'s audited tag-write/rescan happy path,
failure-without-audit and read-only-token refusal,
`get_library_health`'s read-token report + worklist bound,
`resolve_review_flag`'s audited resolve / not-found-without-audit /
read-only-token refusal, `get_album_tracks`' album header + per-song format
fields and unknown-album shape, the album curation tools
(`lookup_album_metadata`'s read-token + unknown-album paths,
`fix_album_metadata`'s re-mint + audited old→new / empty-body / unknown /
read-only refusals, `set_album_cover`'s canonical write + error passthrough,
`set_album_classification`'s override + hide + validation set),
`complete_album`'s confirm gate, kill-switch refusal, album_jobs-first vs
lookup-fallback resolution, idempotent already-complete notice and
unresolvable-without-audit paths,
unknown-method JSON-RPC error, and `checkToolAccess` covering the scope +
confirm gates with synthetic tools).
`services/library-deletion.test.ts` covers `deleteOne`/`deleteAlbum` directly
(not just through the HTTP route), the test surface the MCP tools needed.
`AgentTokensComponent`'s spec covers mint/list/revoke and their error paths.
