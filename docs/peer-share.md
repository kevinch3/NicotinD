# Peer Share — library sharing between NicotinD servers  ·  **PROPOSAL, NOT IMPLEMENTED**

> **Status: viable idea, pitched 2026-08-29, never built.** Nothing in this document
> ships. There is no `/addon/v1` facade served by NicotinD itself, no share-token
> table, no peer lane. The pitch is kept because the viability argument is unusually
> strong — the consuming half already exists — and because the shape of the answer
> (facade-in-core, default-off) should not be re-derived if this is picked up.
> Original pitch artifact (visual, with diagrams):
> <https://claude.ai/code/artifact/b1a97656-751f-460c-94a2-78f5494aae42>

## The idea

Server B registers Server A exactly the way it registers the slskd addon today: a
URL and a token, pasted into Extensions (or scanned from a QR). From that moment A's
music shows up in B's blended search with a source chip like any other lane; **Get**
pulls the original file over HTTP, and B's organizer, scanner, dedupe guards and
quarantine treat it like any other download. A friend's server is just another place
music comes from — the source-agnostic north star, applied to peers.

The headline use case is the legally clean one: **your own second server** (home +
VPS). Friend circles are the addon-gated extension.

## Why it is unusually cheap

The consuming half is already shipped and prod-tested by three external addons
(slskd, ytdlp, spotdl):

| The peer lane needs                              | Already shipped as                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| Register a remote source by URL + token          | `addon_registrations`, Extensions "Add addon", marketplace QR/link flow   |
| Peer results in blended search                   | `AddonSearchProvider` → `ProviderRegistry`, zero route changes            |
| Pull files, organize, scan, tag provenance       | `AddonJobPoller` → organize → scan pipeline, provenance per addon id      |
| Don't re-download what you own                   | `albumAlreadyComplete`, FLAC>MP3 dedupe, edition collapsing, 409 guards   |
| Review before it lands                           | `holdForReview` download inbox triage                                     |
| Kill-switch & consent posture                    | `acquisitionEnabled` env floor, default-off consent-gated plugin cards    |
| Version safety between servers                   | `protocolVersion` same-major check at registration                        |

The protocol degenerates gracefully for a source whose files already exist: every
job item is `fileReady` at creation, so the hard protocol machinery (fallback
repoints, stalled items, retry waves) never occurs on this lane. What does **not**
exist is the serving half: an `/addon/v1` surface answered by NicotinD about its own
library, and a per-friend revocable share-token model (pattern precedents:
`agent_tokens`, `paired_devices` — pattern, not reuse).

A quiet payoff of an old decision: enrichment (BPM, genre, lyrics) is written to
**file tags**, so a meaningful slice of curation travels inside the files. DB-only
curation (origin, genre overrides, artwork URLs) stays home — a satellite fix, not a
blocker.

## Three ways to build it

1. **Native facade (recommended)** — the sharing server grows an optional
   `/addon/v1` route group: manifest, health, status, search (riding the shared
   folded token matcher), jobs (instant `fileReady`), files (original bytes, never
   the transcode path). Default-off behind its own env floor, the
   `acquisitionEnabled` pattern. The serving side needs core access no matter what
   (tokens, raw files, scan-aware listings), so the facade belongs where the data
   lives. Sharing is *serving*, not a bundled acquisition source, so the
   "core carries zero source code" posture survives. Bonus: NicotinD speaking its
   own addon protocol is a dogfooding proof for third-party addon authors.
2. **External bridge addon** — a `nicotind-peer-addon` repo + image fronting a
   remote server. Torrentio-pure, but the sharing server still needs a serving API
   and token model, so most of option 1 gets built anyway, plus a container per
   friendship. Its real destiny is later and bigger: a **Subsonic bridge** that
   turns any OpenSubsonic/Navidrome library into a NicotinD source.
3. **Streaming federation (the Funkwhale road)** — follow libraries and stream
   without copying. A whole new subsystem (remote catalogs, availability, caching,
   moderation) that bypasses the acquire flow and contradicts the canonical
   locally-scanned library architecture. Rejected; one slice survives as a
   satellite (preview a peer candidate by streaming before Get).

## Precedents

- **Funkwhale** — the only self-hosted music platform with real federation
  (ActivityPub pods since 2018, expanding in 2.0). Proves demand and feasibility,
  and that allow-listing/moderation is needed from day one.
- **Ampache** — "remote catalogs": one server mounts another via its API as a music
  source, for over a decade. The direct ancestor of this idea.
- **Plex** — friend-to-friend server sharing was its killer social feature; the
  2025 remote-playback paywall pushed self-hosters to look for exactly this.
- **Navidrome / Jellyfin** — neither federates; the gap is filled client-side
  (Symfonium, Feishin aggregate servers in one app) — streaming only, no
  acquisition. The hole is real and unserved.
- **Soulseek** — the culture this product already lives in; Peer Share is
  "Soulseek among friends, with clean metadata and no strangers".
- **Syncthing / rsync** — why dumb file sync fails: no music identity, no
  FLAC-beats-MP3 judgement, no edition collapsing, all-or-nothing scope. The
  library must be synced *semantically*, which is what the acquire pipeline does.
- **Stremio / Torrentio** — the addon-distribution thesis: capability varies by
  region, legal framework and user choice via addons. This feature slots into it.

## Risks, ranked

1. **Exposing a private server (high)** — default-off with an env floor; per-friend
   revocable tokens scoped to the share surface only (never a user JWT);
   tailnet-first docs; rate limiting; grants and fetches in `audit_log`.
   `check:route-auth` will demand a reasoned entry for the unauth
   `manifest`/`health` pair.
2. **Legal variance (high)** — private invited circles only, no public discovery or
   directory; own-second-server as the headline; per-region `ADDON_CATALOG` lists
   let the capability exist only where it should.
3. **Library pollution (med)** — organize→scan re-mints everything; dedupe guards
   catch owned music; `holdForReview` can be the peer lane's default; provenance
   rows say which friend every track came from.
4. **Leeching / bandwidth (med)** — per-token quotas + concurrent-transfer caps;
   serve originals only, never spend transcode CPU on peers.
5. **Metadata divergence (med)** — tag-borne curation travels; DB-only curation
   needs a later "curation bundle" capability (config-export machinery is the
   precedent). Song ids are `sha1(path)` per server and must never cross the wire
   as identity; matching stays metadata-based.
6. **Version skew (low)** — already handled by the `protocolVersion` same-major
   registration check.

## Phasing (weekend-PR units)

- **Phase 1 — MVP "my second server + one friend"** (≈ 4–6 PRs, consuming side 0):
  share tokens + consent UI + env floor · facade manifest/health/status/search ·
  jobs with instant `fileReady` + files endpoint · two-server e2e proving
  register → search → Get → scan → provenance · QR registration reuse + docs.
- **Phase 2 — trust & scope hardening** (≈ 3–4 PRs): quotas, rate limits, transfer
  caps · shelf-scoped tokens (share a collection, not the hard drive) ·
  hold-for-review as the peer default · preview streaming.
- **Phase 3 — ecosystem** (own specs, own repos, each optional): Subsonic bridge
  addon · curation bundle · watchlist gossip (auto-hunt asks friends first — the
  cheapest, highest-quality source; slots into the watchlist poller as another
  provider) · region catalogs · mirror mode between one's own servers
  (watch-everything ≈ differential library sync from existing machinery).

Honest unknowns: NAT reachability between homes (tailnet-first docs; QR carries the
full URL) · facade search latency on prod-sized libraries (must ride the indexed
matcher, and be measured, not assumed) · a deliberate security pass on the new
surface.

## Decisions that shape phase 1 (recommendations, not rulings)

- **Copy or stream?** Copy-first; streaming federation is a different product.
- **Facade in core or external?** In core, default-off, env-floored; the facade
  doubles as the API any future bridge addon consumes.
- **Whole library or shelves at MVP?** Whole-library per-friend token first;
  shelves in phase 2 where the product story wants them.
- **Trust UX?** Mirror device pairing: a QR/link carrying URL + minted token,
  revocable from an admin list — the pattern already ships twice.
