# Inspecting production (read-only)

Several issues in this repo ask for a prod measurement _before_ the implementation, and it
repeatedly changed the answer rather than merely confirming it:

- **#262**'s stated root cause was wrong. The issue predicted a path→song-id mismatch; measurement
  found **20 of 28** stranded `organized` items already had a `library_songs` row at their exact
  recorded path. The real defect was that `markItemsScanned` only saw the current scan batch.
- **#259**'s apparent retention tension dissolved once measured: the curator tables the no-cascade
  design exists to protect have **zero** orphans (the scanner rebuilds them), while the growth was
  entirely in _regenerable_ tables.
- **#271**'s `BLOAT_RATIO` was calibrated, not guessed — 462 jobs showed a clean gap at 2×.

The discipline pays. What it lacked was an affordance: every probe was a throwaway script that
rediscovered the same boilerplate (the DB path, the readonly flag, the `VACUUM INTO` rule). That is
what `prod-probe.ts` is for.

## The rule

**Inspection is read-only.** Privileged or mutating commands on the prod host are the operator's to
run, not the agent's. Everything below only reads.

## `prod-probe.ts`

`packages/api/src/scripts/prod-probe.ts` — dev-only, in the same family as `dump-radio.ts` and
`check-fragments.ts` (both read-only diagnostics that exist so a change can be measured before it
ships).

```bash
# locally, against a dev DB
bun run packages/api/src/scripts/prod-probe.ts --db ~/.nicotind/nicotind.db --orphans

# against prod: pipe the file into the container and run it there
ssh kpc 'docker exec -i nicotind-nicotind-1 sh -lc "cat > /tmp/probe.ts && bun /tmp/probe.ts --orphans --jobs --transfers"' \
  < packages/api/src/scripts/prod-probe.ts
ssh kpc 'docker exec nicotind-nicotind-1 rm -f /tmp/probe.ts'   # clean up after
```

| mode          | answers                                                                           |
| ------------- | --------------------------------------------------------------------------------- |
| `--orphans`   | per-side-table row + orphan counts (#259)                                         |
| `--jobs`      | acquisition jobs by state/stage — the "stranded at `active/scanning`" view (#262) |
| `--transfers` | `hidden_transfers` backlog; should trend to zero after #265                       |
| `--sql "<q>"` | one-off read, forced read-only                                                    |
| `--json`      | machine-readable output instead of text tables                                    |
| `--db <path>` | override the database path (default `$NICOTIND_DATA_DIR/nicotind.db`)             |

### Safety model

Two independent layers, because this points at production:

1. **The connection is opened `{ readonly: true }`**, with no flag to disable it. This is the real
   enforcement — a write throws `SQLITE_READONLY` regardless of what got past the parser. Asserted
   in the tests, not assumed.
2. **`assertReadOnlySql`** is the fast, legible second layer, so a mistake fails with
   `refused: --sql must start with SELECT, WITH or PRAGMA (got "delete")` instead of a driver error.
   It requires a **single** statement beginning with `SELECT`/`WITH`/`PRAGMA`, rejects every
   mutating keyword as a whole word, and rejects an assigning `PRAGMA` (some pragmas write).

Two ordering details in that guard are load-bearing, and both have a test:

- **Comments are stripped first.** A guard that checks the leading keyword before stripping reads
  `-- SELECT 1\nDELETE FROM …` as a `SELECT`.
- **String literals are blanked before the keyword scan.** A literal cannot execute, so
  `WHERE title = 'update me'` is a fine read — and a `;` inside a literal is not a statement
  separator. Without this the guard is annoying enough to be worked around, which is worse than a
  guard that is merely strict.

### The probe's table list is wider than the pruner's

`ORPHAN_PROBE_TABLES` deliberately includes tables `orphan-prune.ts` would never touch —
`library_lyrics` (network-sourced _and_ user-editable), `library_song_genres`, `playlist_songs`.
That is the point: measuring a table you would never prune is exactly what tells you whether the
prune policy is right. This is the **measure** set; `ORPHAN_TABLES` is the **prune** set. Keeping
them separate is intentional, not duplication.

## Replays that must write

Some verification needs writes — #259's grace-period simulation had to run the real
`pruneOrphanRows` forward 31 days. Never against the live file. Snapshot first:

```
VACUUM INTO '/tmp/replay.db'
```

then run the real function against the copy and delete it. `VACUUM INTO` is itself a read of the
source, so the live database is untouched.

**The high-value pattern** is to dump prod state to JSON and run the _real_ pure function locally
against it, rather than re-implementing the logic in the probe — a port drifts from the shipped
code. It is how #212's verification found that the segmenter never fired, and it mirrors the repo's
own replay habit (`dump-radio.ts`, `album-hunter.replay.test.ts`).

## Other prod surfaces

- **SQLite**: `/data/nicotind/nicotind.db` inside `nicotind-nicotind-1`. There is no `sqlite3`
  binary in the container — use `bun:sqlite` with `{ readonly: true }`.
- **Lidarr**: the container already holds `NICOTIND_LIDARR_URL` + `LIDARR_API_KEY` as env vars. Run
  a script _inside_ the container that reads them and prints only derived results, so the key is
  never echoed.
- **slskd**: no API key in the container env (`X-API-Key` returns 401). Authenticate the way the app
  does — `POST $NICOTIND_SLSKD_URL/api/v0/session` with the `SLSKD_USERNAME`/`SLSKD_PASSWORD` env
  vars, then send the returned token as `Bearer`. `GET /api/v0/transfers/downloads` is the ground
  truth for anything about the Downloads feed.
- Containers are `nicotind-{nicotind,slskd,lidarr,analysis}-1`. Avoid `find /` — it
  times out.
