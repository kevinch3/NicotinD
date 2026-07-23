# Discogs metadata plugin

Canonical reference for the Discogs source: config, auth choice, rate-limit
budget, and the matching strategy. Index entry in [CLAUDE.md](../CLAUDE.md);
one-line summary in [plugins.md](plugins.md).

Discogs is a community-maintained music database with unusually deep coverage of
**Latin / regional / pre-2000 / DJ-pool** repertoire — the exact residual gap
that #187's MusicBrainz release-group genres could not close (José Larralde still
resolves to `Latin;World`, not `Folk`/`Chamamé`). This plugin is the **shell**
that lets us test and, if worthwhile, ship that: manifest, HTTP client, and the
matching primitives, wired into a `genre` metadata capability.

> **Scope.** This is issue #193 — the shell only. There is **no enrichment-task
> wiring**: nothing calls `fetchGenres` from the windowed processor, and nothing
> writes `library_genre_overrides`, yet. Whether that wiring is built at all is
> gated by the **#191 coverage spike** (`docs/measurements/discogs-coverage-2026-07.md`).
> The plugin is registered (so it's manageable in Extensions) and fully
> functional on demand, but dormant in the background.

## Layout

```
packages/api/src/services/plugins/discogs/
├── index.ts      # DiscogsPlugin — Plugin impl + manifest + GenreCapability
├── client.ts     # HTTP + auth + on-disk cache + token-bucket rate limiter
├── matching.ts   # pure: MBID-first → name search w/ normalizeArtistForGrouping
└── *.test.ts
```

The client is deliberately **plugin-private** (`plugins/discogs/client.ts`, not
`lib/`) — it's an implementation detail of this source, not shared infrastructure.

## Auth: Consumer Key + Secret

Discogs offers four credential tiers; we use **Consumer Key + Secret**.

| Credentials             | Rate limit | Image URLs | Per-user  |
| ----------------------- | ---------- | ---------- | --------- |
| Anonymous               | 25/min     | stripped   | no        |
| **Consumer key+secret** | **60/min** | yes        | no        |
| Personal access token   | 60/min     | yes        | one human |
| OAuth 1.0a              | 60/min     | yes        | yes       |

OAuth 1.0a only buys acting _on behalf of a user_ (edit their collection /
wantlist) — we never do. A personal access token ties quota + image rights to
one individual, wrong for a shared self-hosted server. So: the admin registers a
free app at `discogs.com/settings/developers` and pastes the **Consumer Key**
(text field) + **Consumer Secret** (write-only password field) into the Discogs
extension card. Sent as `Authorization: Discogs key=…, secret=…` on every
request. `isAvailable()` is `!!consumerKey && !!consumerSecret` — the registry's
enable flag is the separate on/off gate (there is no `acquire.discogs.enabled`
YAML source, so a local `enabled` term in availability would be permanently
false; see the `// why` in `index.ts`).

Config fields: `consumerKey` (text), `consumerSecret` (password), optional
`userAgent` (text), `cacheTtlDays` (text → int). `configSchema` validates + the
registry merges partial updates, so leaving the secret blank keeps the stored one.
`cacheTtlDays` is the only numeric field among the config schemas — its
`z.coerce.number()` is wrapped in a `z.preprocess` that maps `''` → `undefined`
first. Without it, the web form's "always send every text field, blank = no
override" behavior (`buildPluginConfigPayload`) coerced a blank cache-TTL to
`0`, which then failed `.positive()` and threw — and because `setConfig`
parses the whole payload atomically, that rejected the entire save, including
`consumerKey`/`consumerSecret`. Symptom in prod: the card stayed enabled +
credentials appeared to never persist ("Unavailable" forever).

## Rate limiting — one shared 55/min bucket

Discogs enforces **60 req/min per source IP** on a 60-second moving window, with
**no `Retry-After` guarantee on a 429**. The only safe strategy is to stay under
the cap, not react after crossing it — so the client self-throttles to **55/min**
(a 5-request margin) via a single in-process **token bucket**, and additionally
**honours `X-Discogs-Ratelimit-Remaining`** on every response (aligning the bucket
down to the server's own count so we never overrun it).

One bucket is shared between any interactive fetch (a future "Detect genre"
button) and background enrichment — **no second bucket** (at 55/min the
background is still 92% of full speed). Interactive requests get **soft
priority**: a background request needs a full token _plus_ an `INTERACTIVE_RESERVE`
(3) of headroom, an interactive one needs only a full token, so when the bucket
is nearly empty the interactive request drains ahead of the next background
refill. `clock`/`sleep` are injected for tests.

## Matching — MBID-first, then corroborated name search

`matching.ts` is **pure** (no I/O, no clock). Two strategies, in priority order:

1. **MBID-first (trusted).** When the host carries an MBID, the enrichment layer
   resolves it to a Discogs URL via **MusicBrainz's own `discogs` url-relation**,
   and `parseDiscogsRef(url)` extracts the Discogs `{ kind, id }`. No fuzzy step,
   so no same-name false pair. The `GenreQuery` carries **MBID only** (no
   provider-specific id) — the matcher resolves MBID → Discogs id internally, via
   an injected `resolveDiscogsRef` (the MusicBrainz-backed default lands with the
   enrichment wiring; injected/faked in tests so the shell stays self-contained).
2. **Name search (fallback).** A Discogs `/database/search` by artist +
   release title, then `selectBestRelease` picks the best release/master hit —
   but **only when both the artist AND the album title corroborate**
   (`scoreSearchHit` collapses to 0 if either half misses). Album-title
   corroboration is what rejects the **"Emilia (Argentine) → Emilia (Swedish)"**
   false match that same-name artists otherwise produce (#187's named case).
   Artist folding uses `normalizeArtistForGrouping` (accent-insensitive, keeps
   punctuation so `Miranda!` ≠ `Miranda`); title folding is punctuation-light.

`fetchGenres` returns the release/master's **genres + styles flattened**
(general first, de-duplicated) with a **real confidence** in `[0,1]` — an
MBID-resolved match scores 0.95, a name-search match scores its corroboration
score. **There is no `confidence: 1.0` shortcut** — that "trust the tag" path
belongs to the tag layer, not a network source that had to match a release first.

## Deliberate non-features

Recorded so a later PR doesn't re-litigate them:

- **No `scope: 'artist'` genre lookup.** Per #187 finding 3, artist-level
  coverage measured ~4× worse than release-level; `GenreQuery` is release-scoped
  and not offering the option is safer than documenting "don't use it".
- **No provider-specific id in the query types (MBID only).** Keeps the
  `GenreCapability` contract source-agnostic; the matcher owns the MBID →
  Discogs-id resolution.
- **Metadata only.** There is no Discogs audio API and never will be.

## Hard constraints (from the Discogs API docs)

- **User-Agent required on every request** — an empty UA returns silently-empty
  responses. Injected in the client headers, not at init.
- **Rate limit is per source IP**, 60-second moving window.
- **No `Retry-After` on 429** — self-throttle rather than react.
- **Image URLs are signed** — swapping an id into a URL 404s; store + replay
  verbatim, never re-derive. (Images/bios are not fetched by this shell.)
- **Documented 5xx on ordinary queries** (`"Query time exceeded"`) — treated as
  transient (retry with backoff), then a `null` the caller ledgers as a persistent
  miss via the `NoConfidentResultError` discipline once the enrichment wiring lands.

## Core capability additions

`MetadataCapabilityName` gains `'genre'` (`packages/core/src/plugin/manifest.ts`);
`GenreQuery` / `GenreResult` / `GenreCapability` are added to
`packages/core/src/plugin/capabilities.ts`, and `Plugin.genre?` to
`plugin/index.ts`. The web mirrors the capability string in `plugin.service.ts`'s
hand-written `PluginCapability` union.

## Testing

Client (`client.test.ts`): scripted 200 / 404 / 429-retry / persistent-5xx,
cache hit + on-disk roundtrip, `X-Discogs-Ratelimit-Remaining` throttling, and
User-Agent + auth header presence on **every** request. Matching
(`matching.test.ts`): URL parsing, folding, scoring, the Emilia rejection,
master-over-release preference, genre/style mapping. Plugin (`index.test.ts`):
manifest validity, credential-gated availability, init config merge, and both the
name-search and MBID-first `fetchGenres` paths. All in `bun run test` — **no
live-API test in CI.**
