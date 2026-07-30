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

## Tool surface (read + safe-curation + destructive delete)

`MCP_TOOLS` is the registry; each tool declares `access: 'read' | 'curate'` and
an optional `destructive` flag. `checkToolAccess` (pure, unit-tested) is the
guard: a `curate` tool needs the `:curate` scope (a `refiner:read` token is
refused), and a `destructive` tool needs `args.confirm === true`. `dispatchTool`
applies it, then runs the handler; every write is audit-logged.

| tool | access | fronts |
| --- | --- | --- |
| `search_library` | read | library artists/albums/songs by name |
| `get_artist` | read | one artist + their albums |
| `get_album_tracks` | read | an album's songs (genre, licence) |
| `set_song_licence` | curate | the same UPDATE + `song.licence` audit as the route |
| `delete_song` | curate, **destructive** | `services/library-deletion.ts` `deleteOne` + `song.delete` audit |
| `delete_album` | curate, **destructive** | `services/library-deletion.ts` `deleteAlbum` + `album.delete` audit |

### Destructive deletion: the extraction that unblocked it

The delete path used to be inline in `routes/library.ts` (folder-first `rmSync`
+ row delete) — fronting that to an LLM safely needed the logic **extracted
into a shared, tested service first**, which is now `services/library-deletion.ts`
(`deleteOne`, `deleteAlbum`, plus the path-resolution/fuzzy-match/cleanup
helpers they need). Both the HTTP routes (`DELETE /albums/:id`, `DELETE
/songs/:id`, `POST /songs/bulk-delete`) and the two MCP tools above call the
**same** functions — `db`, `musicDir`, and a `ShareRescanScheduler` instance are
explicit params rather than closures, so each caller wires its own dependencies
(`mcpRoutes(musicDir, slskdRef)` constructs its own debounced scheduler,
mirroring the one `libraryRoutes` already builds). `delete_album`/`delete_song`
reuse the exact `recordAudit` action names (`album.delete`, `song.delete`) the
HTTP routes use, with a `(via MCP agent)` suffix on the detail string so an
audit-log reader can tell the two apart. Merge tools remain unbuilt — merge has
no equivalent shared service yet.

## Settings UI

`pages/settings/agent-tokens/` (`AgentTokensComponent` +
`AgentTokensApiService`, mirroring the paired-devices settings page) mints
(shown once, with a copy affordance), lists, and revokes tokens against the
already-wired `/api/agent-tokens` routes. Reachable from Settings → Account
→ "Agent tokens →", gated on `auth.canCurate()` client-side (a new
`curatorGuard` in `guards/auth.guard.ts`, mirroring `adminGuard`) to match the
server's `requireCurator` gate on the same routes.

## Left as follow-ups

- **Merge tools** — `merge_artist` needs its own shared-service extraction the
  way deletion got one; not started.
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
read tool, the audited curate write, read-only-token refusal,
`delete_song`/`delete_album` against a real temp-dir music folder — confirm
gate, scope gate, and the audited happy path — unknown-method JSON-RPC error,
and `checkToolAccess` covering the scope + confirm gates with synthetic tools).
`services/library-deletion.test.ts` covers `deleteOne`/`deleteAlbum` directly
(not just through the HTTP route), the test surface the MCP tools needed.
`AgentTokensComponent`'s spec covers mint/list/revoke and their error paths.
