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
applies it, then runs the handler; every write is audit-logged.

| tool | access | fronts |
| --- | --- | --- |
| `search_library` | read | library artists/albums/songs by name, via the shared folded matcher |
| `list_recent_songs` | read | recently-landed songs, newest first, paged, optional missing-genre filter |
| `get_artist` | read | one artist + their albums |
| `get_album_tracks` | read | an album's songs, with their genre |
| `set_song_genre` | curate | `services/song-genre-mutate.ts` `mutateSongGenre` + `song.genre` audit |
| `flag_for_review` | curate | `services/curation-flags.ts` `createCurationFlag` + `curation.flag` audit |
| `list_review_flags` | read | the open human-review queue, oldest first |
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
- **Acquisition tools** (`add_to_watchlist` / `acquire_album`) — the mechanism
  (`destructive` flag + `confirm` gate + `recordAudit` + the refiner cap) is
  proven by the delete tools above, so adding these is the same shape of work.
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
unknown-method JSON-RPC error, and `checkToolAccess` covering the scope +
confirm gates with synthetic tools).
`services/library-deletion.test.ts` covers `deleteOne`/`deleteAlbum` directly
(not just through the HTTP route), the test surface the MCP tools needed.
`AgentTokensComponent`'s spec covers mint/list/revoke and their error paths.
