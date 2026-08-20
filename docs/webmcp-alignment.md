# WebMCP alignment (proposed — not yet implemented)

**Status:** design decision, 2026-08-19. **Verdict: align the *contract*, defer the
*platform*.** Phase 1 (extract one host-agnostic tool registry) is worth doing on its own
merits and ships no browser code. Phase 2 (a browser host on `document.modelContext`) waits
behind a flag while WebMCP is an origin trial.

This doc answers "can NicotinD align to WebMCP?" It is a plan, not a shipped feature — no
symbol named below as *proposed* exists yet. The shipped half it builds on is
[docs/mcp-agent.md](mcp-agent.md).

## What WebMCP is (and which Chrome thing it is not)

Chrome ships two unrelated things people both call "Chrome's MCP API":

| | **WebMCP** | **Chrome DevTools MCP** |
| --- | --- | --- |
| What | a *page* registers tools an in-browser agent can call | an agent-facing debugger (traces, heap, HAR, Lighthouse) |
| Surface | `document.modelContext.registerTool(...)` + a declarative HTML-form annotation API | an MCP server you point a coding agent at |
| Relevance here | a **product** surface — the subject of this doc | **dev tooling** only; see "Not in scope" |
| Status (2026-08) | Chrome 149 **origin trial**; flag `chrome://flags/#enable-webmcp-testing`; Edge 147 native; stable targeted ~Q3 2026 | shipped, v0.19 |

## The observation this whole plan rests on

Our MCP tool descriptor is **already** WebMCP's descriptor. From `routes/mcp.ts`:

```ts
// ours (shipped)
interface McpTool {
  name: string; description: string; inputSchema: Record<string, unknown>;
  access: 'read' | 'curate'; destructive?: boolean;
  handler(ctx, args): Promise<string> | string;   // dispatchTool wraps → { content: [{ type: 'text', text }] }
}

// WebMCP (Chrome 149 OT)
document.modelContext.registerTool({
  name, description, inputSchema, async execute(args) { return { content: [...] } }
});
```

Same four fields, same result shape. So `MCP_TOOLS` is not "the MCP server's tool list" — it
is a **host-agnostic registry that currently has exactly one host**. Aligning to WebMCP means
naming that fact in the type system, not porting anything.

## Why a second host is worth having at all

`/api/mcp` is server-side and therefore *structurally cannot* reach the thing users most want
an agent to drive: the running player. Its tools are all library-state
(`search_library` / `get_artist` / `get_album_tracks` / `set_song_licence` /
`delete_song` / `delete_album` / `merge_artist`). Everything in `PlayerService`
(`playSingle`, `queueNext`, `startRadioWithFilter`, `jumpToQueueIndex`, `toggleVocalMute`),
`LikeService`, the Library find bar and the `/get` omnibox lives only in the tab. There is no
server expression of "queue three more like this, but nothing over 140 BPM".

The two hosts are therefore **complementary, not redundant**:

| Host | Transport | Auth | Owns |
| --- | --- | --- | --- |
| `/api/mcp` | JSON-RPC over Hono | `nca_` agent token, capped `refiner`, `confirm: true`, `recordAudit` | library state (incl. destructive) |
| browser (proposed) | `document.modelContext` | the tab's ambient JWT | session state: playback, queue, radio, likes |
| our own UI | direct calls | the session | already enumerates intents via `SongMenuService.build()` |

That third row is the tell — `SongMenuService` has been the "single source of truth for a
song's actions" since before any of this. We have been building tool-shaped without the word.

## Phase 1 — extract the contract (no browser code)

Extract the registry contract to a shared leaf, the same move as the addon protocol →
`@nicotind/addon-sdk`:

- A generic tool-descriptor type, parameterised over its context, so a server tool takes
  `{ db, identity }` and a browser tool takes `{ player, api }`.
- **Promote `checkToolAccess`** — it is already pure and unit-tested. It must be the one
  predicate both hosts run, not a shape each host reimplements (that is precisely the drift
  class `check:shared-helpers` exists to catch).
- Add an explicit **`hosts` field**, defaulting to server-only.

`hosts` is the load-bearing part. Exposure becomes a *declared property of the tool* rather
than an accident of which file it is defined in. Every tool that reaches a browser agent
does so because someone wrote it down.

**Why this pays off even if WebMCP never ships:** today "which tools are safe to expose
where" is knowledge held in `routes/mcp.ts`'s file boundary. Writing it down and gating it is
an improvement to the MCP server we already run in production.

### The gate

A test asserting **no `destructive` tool declares the browser host**. Same shape as
`check:route-auth`: a class of mistake that is silent when you make it, so it needs a check
rather than a convention.

## The security asymmetry (the reason for default-deny)

A browser tool runs under the tab's ambient JWT. Every control that makes `/api/mcp` safe is
*structurally absent*:

| Control | `/api/mcp` | browser host |
| --- | --- | --- |
| Effective role cap | `AGENT_EFFECTIVE_ROLE` = `refiner`, even for an admin owner | none — the user's own role |
| Credential | opaque revocable `nca_` row, sha256-stored | the session JWT already in the tab |
| Destructive gate | `confirm: true` enforced by `checkToolAccess` | nothing built in |
| Attribution | `recordAudit` on every write | writes look like the user performed them |

Consequences, non-negotiable:

1. **No destructive tool is ever browser-exposed.** Deletes and `merge_artist` stay
   server-only, permanently.
2. **Registration is role-gated** on `AuthService.canAcquire()` / `canCurate()`, mirroring
   the server's scope check — a listener's tab must not advertise an acquire tool.
3. **Writes route through `ConfirmService`.** An agent calls a tool with no user gesture, so
   the existing confirm path is the human-in-the-loop gate, plus a visible "an agent is
   driving" indicator.
4. **Agent-driven writes need attribution** — a header or per-call origin flag so audit rows
   read "via page agent" instead of being indistinguishable from a click.
5. **Cross-origin exposure is default-deny** — WebMCP's `exposedTo` / `allow="tools"` are
   opt-in per trusted origin, never blanket.

## Phase 2 — the browser host (behind a flag)

A small Angular service registering at app-shell init, feature-detected
(`'modelContext' in document`) so it is inert in Capacitor WebView, Electron, Firefox and
Safari — the same progressive-enhancement shape as `getCapacitorPlugin` / `canScanBarcode()`.

Proposed starting set, deliberately tiny, read + session-mutating only:

| Tool | Backed by | Why it earns a seat |
| --- | --- | --- |
| `now_playing` | `PlayerService` signals | the state an agent needs before it can do anything else |
| `play_song` / `queue_song` | `playSingle` / `queueNext` | the two verbs every "play X" request reduces to |
| `start_radio` | `startRadioWithFilter` + `LibraryFilter` | see below — the differentiated one |
| `like_song` | `LikeService` | cheap, reversible, high-frequency |

**`start_radio` is the tool worth building the host for.** "Play something like this but
slower and less vocal" is the query people actually want against a music library, and we
already have a machine-legible vibe grammar for it: `LibraryFilter`,
`serializeLibraryFilter` / `parseLibraryFilter`, `songFilterWheres`, `seedCentroid`, and the
recipe `where`s. Its `inputSchema` is a direct transcription of a type we already maintain and
test. Most libraries would have to invent a query language to expose this; ours is shipped.

**Do not** reimplement `search_library` client-side. The local search lane already tokenizes
and accent-folds server-side; a browser copy is a second matcher that will drift.

## Phase 3 — the declarative half, and curation queues

- The HTML-form annotation API maps onto the Library find bar and the `/get` omnibox with
  markup only. Our `data-testid` discipline already gives every e2e-targeted element a stable
  semantic anchor — same discipline, a new consumer.
- **Curation queues are the better agent story than direct mutation.** Genre overrides carry a
  `status` review queue; the download inbox is hold-for-review; fragmentation defects carry
  their remediation; `resolve-artist-identity.ts` is propose → review → `--apply`. That is the
  human-gated pattern four times over. An agent that *proposes into those queues* needs **no
  new trust model** — a curator approves exactly as today.

## Not in scope

- **Chrome DevTools MCP** is dev tooling (bundle budget, LCP, a11y work), not a product
  surface. Keep it out of CI: a check that is not in `bun run verify` and does not block
  `release` is advisory, which is the #457 shape.
- **Client-side GPU/ML** (WebGPU, WebNN) is a separate question, already answered NO-GO in
  [docs/client-side-ml-feasibility.md](client-side-ml-feasibility.md) — the argument was never
  capability, it was that canonical, tag-writing, whole-library enrichment must come from one
  pipeline. WebGPU reaching full browser support in 2026 does not change it.
- **Addon-contributed tools** (a `tools` capability on the acquisition addon protocol) — a
  coherent later option, deliberately not part of this plan.

## Risks

- **Origin trial, not stable.** The API name has already moved (`navigator.modelContext` →
  `document.modelContext`). Pin against the OT docs at build time; do not treat the surface as
  a public contract of ours.
- **Single-vendor so far.** Edge follows Chromium; Safari and Firefox have not committed.
  Phase 1 carries no platform risk, which is why it goes first and alone.

## Bottom line

- Our tool descriptor already **is** the WebMCP descriptor; alignment is extraction, not a port.
- Phase 1 (shared registry + declared `hosts` + a destructive-never-browser gate) is a
  standalone improvement to the shipped MCP server. Do it regardless.
- Phase 2 is small, flagged, session-scoped, and its reason to exist is `start_radio`.
- Nothing destructive ever reaches the browser host — the refiner cap, the confirm gate and
  the audit ledger do not exist there.

See also [docs/mcp-agent.md](mcp-agent.md) (the shipped server + token model),
[docs/roles.md](roles.md) (the role ladder the gating mirrors),
[docs/radio.md](radio.md) (the filter grammar `start_radio` would expose).
