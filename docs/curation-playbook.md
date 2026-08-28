# The curation playbook (issues #734/#735)

The **standardized library curation pass**: a repeatable, measurable process that turns the ad-hoc
curator sessions of August 2026 into a pipeline — *measure → fix (auto → agent → human) → acquire →
re-measure* — with an evidence record per pass. It exists because two real passes over prod measured
the same failure shape repeatedly: the curation surface could **find far more than it could fix**,
discovery was search-by-name, and nothing aggregated "what is missing". The library health report
(`docs/library-audit.md` "Library health report") and the MCP parity tools (`docs/mcp-agent.md`)
are the machinery; this document is the process.

**Product embedding**: the Admin "Library Health" panel (issue #736) and the album-page
completeness affordance (issue #737) will render the same report this playbook consumes — the
playbook's waves are the spec for what those surfaces automate.

## Principles

1. **A metric is what its remediation acts on.** Every number in the health report is by
   construction the candidate set of a specific fix (the `NEEDS_PORTRAIT_SQL` doctrine), so a wave
   "done" is verifiable by the number moving.
2. **Escalate by ambiguity, not by convenience**: bulk automation first (it only does what is
   safe unattended), then the agent (evidence-based individual fixes), then the human queue.
   **An agent that is unsure flags (`flag_for_review`) — it never guesses.**
3. **Acquisition is curator-approved, per album, budgeted.** `confirm: true` on `complete_album`
   is the approval; **≤10 hunts per session**; the `suspected` completeness bucket is advisory and
   never hunted without explicit confirmation.
4. **Every pass leaves a record** in `docs/measurements/curation-pass-YYYY-MM.md`: baseline
   snapshot → per-wave actions/counts → final snapshot → delta table → issues filed. Systemic
   friction goes to GitHub issues, not prose in the record.

## The pass

### Wave 0 — Baseline

*Entry*: no maintenance task running (`GET /api/admin/maintenance/status` idle).

- `bun run packages/api/src/scripts/library-health.ts --json` (in-container on prod) — the
  dashboard snapshot.
- `bun run packages/api/src/scripts/audit-library.ts --json --no-fail` — adds the disk findings
  the health report deliberately excludes.

*Exit*: both JSON snapshots summarized into the pass record.

### Wave 1 — Auto-safe bulk (admin-triggered, dependency-ordered)

Dry-run first where supported; each step's counter is its health dimension.

1. `library-sync` — fresh canonical state.
2. `metadata-optimize` (onlyMissingOrPoor) — years, covers, release types, and **track numbers**,
   which directly sharpen Wave 4's completeness signal.
3. `artwork-backfill` (`lookupMissing`, `albumLookupMinTracks≈4`) — album covers + artist posters.
4. Enrichment window drain: `artist-image`, `artist-info`, `artist-origin`, the genre chain
   (`genre → genre-discogs → genre-audio`), `popularity`, audio tasks — until
   `ProcessingStatus.taskPending` is 0 or ledger-capped.
5. `transcode-library` — dry-run, review candidates/`bytesReclaimed`, then apply; clears the
   lossless half of format cohesion.

*Exit*: tasks completed or cancelled-clean; health re-run; deltas noted.

### Wave 2 — Agent pass (MCP)

*Entry*: Wave 1 drained (so the agent works residuals, not what automation was about to fix).

`get_library_health` → work each dimension's worklist, worst-first:

| Worklist | Tool |
| --- | --- |
| Polluted titles / fake single-albums | `lookup_song_metadata` → `fix_song_metadata` |
| Duplicate-artist spellings (fragments) | `merge_artist` |
| Watermark / wrong-field albums, missing years | `lookup_album_metadata` → `fix_album_metadata` |
| Visible `unknown` / oversized classification | `set_album_classification` |
| Coverless albums with a confident candidate URL | `set_album_cover` |
| Residual genre-less songs | `set_song_genre` (`mode: 'replace'` — a curator decision must survive a rescan) |
| A file whose tags cannot be trusted at all | `identify_song` — recording identity from the audio |
| Anything ambiguous | `flag_for_review` — never a guess |

*Exit*: every sampled worklist item fixed or flagged; `audit_log` tail spot-checked
(`agent:<tokenId>` attribution).

### Wave 3 — Human queue

The web-only remediations plus everything the agent flagged: cover picks needing eyes, missplit
preview→merge, hidden-by-classification judgment calls, `b2b` DJ credits. Close flags via the
Admin Needs-review card (or the agent resolves its own researched flags with
`resolve_review_flag`).

*Exit*: open flags 0, or each deferral named in the pass record.

### Wave 4 — Acquisition (curator-approved)

*Entry*: kill-switch on, acquisition addon healthy, curator present.

Source list: completeness **confirmed** first (hunt history, proven canonical), then
curator-confirmed **suspected** rows. Per album: approve → `complete_album` with `confirm: true`
(or the web hunt for catalog-only albums). **Budget: ≤10 hunts per session** — bounds spend and
review load; idempotence makes re-runs free, so the worklist simply carries over. Landed downloads
re-enter Wave 1's pipeline via normal ingest.

*Exit*: budget spent or list empty; outcomes tallied in the record.

### Wave 5 — Re-measure

Health + audit snapshots again; delta table into the pass record; systemic gaps → GitHub issues.

**Cadence: monthly, or after any bulk ingest.**

## The pass record

`docs/measurements/curation-pass-YYYY-MM.md` (the `radio-stations-2026-08` precedent — dated
measurements, distinct from the rolling feedback log). Sections: Baseline · Wave log (what ran,
counts, anomalies) · Final · Delta table (dimension | before | after) · Issues filed.
