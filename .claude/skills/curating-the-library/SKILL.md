---
name: curating-the-library
description: Use when curating the NicotinD music library over MCP — running a curation pass, filling missing genres, fixing song/album metadata, consolidating duplicate artists, working the library health worklist, or resolving review flags.
---

# Curating the library

Curation runs against the **production** library. Every write is real, and the tools
return `ok: true` whether or not the write survived. This skill is the operational
layer; `docs/curation-playbook.md` is the wave structure (measure → fix → acquire →
re-measure) and `docs/mcp-agent.md` is the tool reference.

## Start here: pick the right worklist

| Want | Use | Not |
| --- | --- | --- |
| Genre-less songs | `list_recent_songs({missingGenre: true, limit, offset})` | `get_library_health` — its genre worklist walks the alphabet |
| Every other dimension, and before/after deltas | `get_library_health({sample})` | — |
| Open human decisions | `list_review_flags` | — |

`list_recent_songs` is cheap and surfaces what *just landed*. It is **not** one
homogeneous ingest — it is the union of every unresolved ingest ever. Check `landedAt`
before assuming two adjacent pages are the same scene.

## Tool signatures that get guessed wrong

**A wrong argument key does not error — it comes back as empty data** (issue #778).
`get_artist` with `name` returns `{"error":"artist not found"}`; `get_album_tracks` with
`albumId` returns `{"album": null, "songs": []}`. Both read as "the library doesn't have
this", and both are wrong. Never conclude something is absent from one empty read —
re-check the key first.

| Tool | Key | Not |
| --- | --- | --- |
| `get_artist` | `id` | `name` |
| `get_album_tracks` | `id` | `albumId` |
| `merge_artist` | `mergeInto` + `rawName`/`rawNames` + `confirm` | ids of any kind |

`merge_artist` takes **display names, not ids**, and requires `confirm`:

```json
{"mergeInto": "Wisin & Yandel", "rawName": "Wisin y Yandel", "confirm": true}
{"mergeInto": "Los Rodríguez", "rawNames": ["Los Rodriguez", "los rodrigues"], "confirm": true}
```

`complete_album` requires `confirm: true` — that IS the per-album approval. Budget
**≤10 hunts per session**; expect ~40% to return `already-complete` (issue #758).

## The genre mode rule

**A curator genre decision uses `mode: 'replace'`. Always.**

```json
{"songId": "...", "genre": "House", "mode": "replace"}
```

`mode` defaults to `append`, which writes only the volatile `library_song_genres`.
`replace` writes a song-scoped `library_genre_overrides` row — the store the scanner
re-applies at scan time. On a song whose file tag holds a real-but-wrong genre (a label
like "Relief Records", a mistag), an append **adds your genre next to the wrong one and
is then lost on rescan**. Leave `append` for automated detectors adding an extra tag.

`docs/curation-playbook.md`'s Wave 2 table still says `set_song_genre` (append). It is
stale on this point; `replace` is correct for curator decisions.

## Type bare characters in every MCP argument

HTML entities arrive **literally** — there is no unescaping. Writing `&amp;` created two
real artist rows named `Wisin &amp; Yandel`; writing `&lt;` created an album literally
named `while(1&lt;2)`. Type `&`, `<`, `>`. Re-read any argument containing one before sending.

## Verify every write by reading back

`ok: true` is not proof of persistence (issue #760: title/album silently reverted on
`.opus` across three calls while artist stuck). After a mutation, re-read with
`list_recent_songs` / `search_library` / `get_album_tracks` and confirm the new value.
Never resolve a flag or report a fix on the apply call's return value alone.

## Spend searches on artists and clusters, never on songs

**The remaining genre-less songs are the residue after every automated lane already ran
to its retry cap** — Lidarr (`genre`), Discogs (`genre-discogs`) and the audio classifier
(`genre-audio`) each hold thousands of capped failure rows. Low yield is the expected
state, not neglect. Do not try to clear the backlog; take the cheap wins and stop.

Search is budgeted and runs out. When it did, throughput fell from 10–15 songs a session
to 1–5. The lane that kept working was zero-search. So: **check the free lanes first, and
amortize every search over an artist or a cluster.**

| Free lane (no search) | Call |
| --- | --- |
| Sibling album's genre, artist country, MBID | `get_artist({id})` — albums carry `genre`, plus `origin.country` and `mbid` |
| Other tracks on the same album | `get_album_tracks({id})` — songs carry `genre` |
| A coherent ingest wave (one scene, one arrival) | one judgment covers every song in it |

Propagate from siblings only where **≥2 tagged siblings agree** — a lone sibling
propagates one mistag.

Then, and only then, spend a search:

1. **Triage first.** Singleton artist (one album, one song) with no `mbid` and no
   `origin.country` is unresolvable — leave it, spend nothing. A generic artist name *and*
   a generic title ("OldChild" / "Relax", "Nathan C" / "Body") returns noise; skip it.
   Distinctive proper nouns (Tjuvjakt, Figa Flawas, Los Chichos) are what actually resolve.
2. **Search in the artist's own language.** Mares and Tjuvjakt sat unresolved for sessions
   until Swedish queries; `origin.country` from `get_artist` tells you which language.
3. Search conclusive → write it, and apply it across that artist or cluster.
4. Search inconclusive → **leave the song untagged**. Do not flag it. The health report's
   genre worklist is already the tracker; a flag per unknown-genre single is queue noise.
5. Prefer the release page (Beatport/Discogs/MusicBrainz) over a downloaded file's own tag.

`flag_for_review` is for ambiguity that risks **wrong data** — a b2b DJ credit, two
plausible artist identities, an authenticity call — not for "I don't know this one".

## Before destructive work

- **`get_artist` before merging a placeholder bucket.** Buckets named `artist`/`Unknown`
  hold unrelated albums; `merge_artist` moves the whole bucket.
- **An episode-numbered or junk-named title is not evidence of junk.** Junk metadata ≠
  junk audio (issue #705). A junk-named orphan is often a real album's missing track —
  check the target album's numbering for a gap first.
- **Duplicate rips: merge first, diff, then delete.** The owner's standing ruling is to
  delete the redundant copy and keep the best — but a dupe bucket may hold a track the
  kept copy lacks.
- **Mid-ingest, suspend destructive work.** A "duplicate" during an ingest can be an
  in-flight partial. `list_recent_songs` detects arrivals; wait for them to stop.

## Reading the health report honestly

- `album_count_mismatch` / `album_song_count_mismatch` spike right after deletions and
  settle by themselves (#774). Don't read post-delete churn as new pollution.
- `completeness.suspected` is advisory — never hunt it without explicit confirmation.
- Wave 1 (`artwork-backfill`, `metadata-optimize`, `library-sync`, `transcode-library`)
  is **admin-only** and unreachable from a refiner MCP session. Say so rather than
  reporting those dimensions as workable.

## Close the session

Record the pass in `docs/measurements/curation-pass-YYYY-MM.md` (baseline → actions and
counts → final → delta table → issues filed). Systemic friction becomes a GitHub issue,
not prose. Confirm deltas against a re-run of the metric, not against your own tally.
