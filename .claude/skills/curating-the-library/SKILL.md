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

A wrong argument key now **errors**, naming the key it wanted and the keys you sent
(fixed in #778 — it used to answer with empty data that read as "not in the library").
So a wrong signature costs a retry, not a wrong conclusion. Save the retry:

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

**`replace` overwrites the song's ENTIRE genre set, not just the one string you're
fixing.** A rare-genre near-duplicate (`Alt Pop` vs `Alt-Pop`, `Rkt` vs `RKT` — see
`get_rare_genres`) is usually the song's genre at a *non-zero* position, meaning the
mistag sits alongside a real primary genre and other tags. Calling `set_song_genre` with
just the corrected string on one of those songs **deletes everything else it carried**.
Read the song's actual genre list (a targeted `prod-probe.ts --sql` read against
`library_song_genres WHERE song_id = ?`, ordered by `position`) before touching any
non-zero-position match, and pass the full corrected ordered list back, not the one
string that was wrong. Position-0 matches are the only ones safe to fix with a bare
single-genre `replace`.


## Type bare characters in every MCP argument

HTML entities arrive **literally** — there is no unescaping. Writing `&amp;` created two
real artist rows named `Wisin &amp; Yandel`; writing `&lt;` created an album literally
named `while(1&lt;2)`. Type `&`, `<`, `>`. Re-read any argument containing one before
sending. Unlike a wrong key, this one *lands* — undoing it costs a merge or a retag. (A
server-side guard is proposed in #787; until it ships this is entirely on you.)

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

**And only where the siblings are independent.** Check `suffix`/`bitRateKbps` before
counting them: 11 tracks that are all mp3 320 from one rip carrying one blanket
album-level genre are **n=1, not n=11**. Green Velvet *Unshakable* read 11×`Techno` that
way, while the 2 stragglers were opus from a different rip — and a third copy of one of
those tracks disagreed outright (`Tech House`). A uniform genre across a uniform format
is one source's tag, not a majority.

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

**Check the track title for a self-declared genre before searching at all.** A downloaded track's
title sometimes carries its own genre in brackets — `"Doorways [Downtempo / Folktronica]"`,
`"Mojave [World Downtempo / Slow Rave / Desert Rock]"` — text the scanner's genre field never parses.
That is source evidence, not a guess; apply it directly, zero search spent.

**The same discipline applies to `missing_year`, and the trap is the same shape.** A compilation's
own title is not proof of its contents' date — a locally-stored "album" is often one track ripped
out of a much larger release, and that track can predate or postdate the compilation's title year by
years. `fix_album_metadata`'s `year` writes onto whatever songs the row actually holds, so check
`get_album_tracks` first: "Superventas 07" holding only Shakira's own 2007-titled single is safe to
date from the title; a various-artists "Watergate 08" holding one WhoMadeWho remix is not — "08" is
that mix series' *installment number*, not a year, and the compilation's own real year (2011) still
would not have been the remix's true release year. When recall and a title-derived guess disagree,
that disagreement is the signal to search, not to silently pick the more confident-sounding one.

`flag_for_review` is for ambiguity that risks **wrong data** — a b2b DJ credit, two
plausible artist identities, an authenticity call — not for "I don't know this one".

## `identify_song` — when the tags cannot be trusted at all

Fingerprint identity from the audio, independent of every tag. It is `read` access,
one fpcalc run plus **one** outbound call, and safe to batch — unlike
`lookup_song_metadata`, whose ~4-source fan-out 502s the origin above ~4 concurrent
calls (#757). It suggests only; apply with `fix_song_metadata`. It carries **no genre**,
by construction — do not reach for it on the genre backlog.

What it is actually for: a junk-named file (`Track 1`…`Track 10`, `Pista 4`, `CD A 2000`)
and true cross-format duplicates.

**Measured on prod 2026-08-28** (v0.5.29, after the API key was fixed — #786): a random
sample of 14 songs matched **14/14**, scores 0.92–0.995, 12 of them carrying a
MusicBrainz `recordingId`. Across all 22 songs tried, 21 matched. This library's Latin
and regional catalogue turned out to be **very well covered** — I predicted thin
coverage and was wrong. Treat `identify_song` as a high-yield lane, not a last resort.

### For dedupe, `recordingId` is the identity — not `acoustId`

`acoustId` is a fingerprint *cluster*; AcoustID sometimes holds two clusters for one
recording. So:

- **same `acoustId` → same recording.** Proof.
- **different `acoustId` → inconclusive.** Compare `recordingId` before concluding
  anything.

Both cases occur in this library:

| files | acoustId | recordingId | verdict |
| --- | --- | --- | --- |
| Chalchaleros 162s ogg + 163s mp3 | same | same | same recording, cross-format dupe |
| Chalchaleros 225s mp3 | differs | differs | **a different recording** of the same song |
| Vilma Palma 278s×2 opus + 279s/282s mp3 | **two ids** | **one id** | all four are one recording |

Reading `acoustId` alone would have called the four Vilma Palma files two different
recordings. It also shows why a duration window is not a substitute: 162 vs 163 is the
same recording and 278 vs 282 is too, but 163 vs 225 is not.

A match can arrive with **no** `recordingId` (2 of 14) — a fingerprint hit AcoustID has
not linked to MusicBrainz. Still a real identification; just no MB id to dedupe on.

**Read the `outcome`; it is the whole point.** Do not treat every negative the same:

| outcome | what it means | what to do |
| --- | --- | --- |
| `match` | a recording identity, with `score` | apply via `fix_song_metadata` |
| `no-match` | genuinely unknown to AcoustID — rare here (1 of 22), but real | retag by hand or leave it |
| `undecodable` | **the file** is likely truncated or corrupt | a triage signal, not a metadata answer |
| `fpcalc-missing` | deployment gap, no file at fault | escalate, stop calling it |
| `source-error` | check `detail` before assuming transient | see below |

`source-error` is documented as transient, **and is not always** — a `detail` of
`AcoustID HTTP 400` is deterministic and no retry will ever succeed. Before the key was
fixed every call returned exactly that, identically to a key invented on the spot (#786).
One call plus its `detail` diagnosed it; a retry loop would have burned the pass.
**A repeated `source-error` means escalate, not back off.**

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
  Read **`landedAt` clustering, never the row count**: song ids are `sha1(path)`, so a
  reorganize or transcode re-mints every id and the whole library reads as "just landed".
  One identical `landedAt` across a page of long-owned catalogue is a re-land, not an
  arrival — and a genuine arrival is a page of *distinct*, recent timestamps.

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

## Maintaining this file

Two kinds of content live here and only one of them ages.

**Judgment** — the genre mode rule, the search-spend gate, "junk metadata is not junk
audio", "don't flag what you merely don't know" — is what no code can enforce. It stays.

**Workarounds for defects** are debt. Each one is a bug that should be *filed*, and when
that issue closes the line here becomes an active lie — it teaches distrust of a surface
that no longer lies, and buys a retry that no longer helps. So every workaround carries
its issue number, and closing an issue means pruning this file in the same pass.

The wrong-key trap is the worked example: "a wrong key comes back as empty data, never
conclude absence from one empty read" was the most useful line in this file until #778
shipped, and the most misleading one the day after. It has been pruned to a signature
table. **As of 2026-08-28 nothing here is a workaround** — read-back verification and
bare characters survive because they are discipline that holds whether or not a guard
ever ships, not because a bug is open. Keep it that way: if you find yourself writing
"the tool lies, so do X", file the bug first and write the issue number next to X.
