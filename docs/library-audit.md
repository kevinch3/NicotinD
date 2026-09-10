# Library quality auditor

A single tool that **asserts the library is reliable** across the canonical
`library_*` SQLite tables **and** the music dir on disk — and a matching cleanup
pass + ingest-time prevention so the same defects don't recur.

Born from a real audit of the production library (1,783 albums / 6,842 songs /
777 artists): the aggregate was healthy but the **singles tail was polluted** by
DJ-pool / VA-source rips (one source, `ftpdjemilio.com`, accounted for 212 junk
singles), disk had **533 empty folders**, and **835 albums** were missing a year.
The auditor turns "is the library clean?" into a yes/no with a non-zero exit code.

## The three pieces

| Piece | File | Role |
|-------|------|------|
| **Detect** | `services/library-audit.ts` (DB), `services/library-disk-audit.ts` (disk) | Pure rule functions → `AuditReport`. CI-tested. |
| **Assert** | `scripts/audit-library.ts` | Prod CLI: DB + disk checks, `--json`, **exits non-zero on any HIGH finding** (gate-able). Read-only. |
| **Clean** | `scripts/repair-pollution.ts` | Deletes junk + sweeps empty dirs. **Dry-run unless `--apply`**, logged, mis-split-protected. |
| **Re-tag** | `services/library-retag.ts` + `scripts/retag-pollution.ts` | Recovers mis-tagged **real** music (the cleanup keeps) into correct artist/album. **Dry-run unless `--apply`**, reversible. |
| **Prevent** | `services/library-quality.ts` predicates wired into `library-organizer.ts` + `library-curator.ts` | Reject/auto-hide pollution at ingest so new patterns can't re-mint. |

The shared predicates (`looksLikeSourceWatermark`, `isNumericLikeName`,
`looksLikeDjSetTag`, `looksLikeVenueCredit` in `library-quality.ts`) are the
**single source of truth** reused by both detection
and prevention, alongside the existing `isUnknownLike` (audio-tags) /
`isPlaceholderArtist` (artwork-backfill) / `normalizeForGrouping` (album-grouping).

## Rule catalogue

Each finding has a `rule`, `severity` (`high`/`medium`/`low`), `subject` (id/name/path)
and a message. The CLI groups by rule (worst first); `--rule=<id>` lists one.

### Integrity (high)
- `album_count_mismatch` — `library_artists.album_count` ≠ actual album count.
- `album_song_count_mismatch` — `library_albums.song_count` ≠ actual song count.
- `dangling_album_artist` / `dangling_song_album` — a row references a missing parent.
- `orphan_artist` (medium) — an artist row reachable from nowhere: no album, no
  `library_songs.artist_id`, **and no `library_song_artists` credit**. The credit table was
  added to the predicate in issue #954; without it the rule read only the *primary*
  attribution, so every featured/guest artist looked orphaned — 485 findings on prod, 485 of
  them false, and the message said "should be pruned", which is an instruction a human or an
  agent may act on. It now states the fact instead of directing a deletion.

### Pollution (high; detection is **hidden-agnostic** — junk is junk even if the curator hid it)
- `watermark_artist` — artist name is a DJ-pool/VA-source watermark (`ftpdjemilio.com`,
  `Batea Especial…`). The distinct artist row often owns hundreds of junk singles.
- `numeric_artist` — artist name is a bare/disc-track number (`101`–`208`): a mis-parsed tag.
- `watermark_album` — album title is a source watermark (a **real** artist with the
  source in the album field, e.g. UMEK / `MUSICAUNO.COM`). Corroborated — see
  *Per-rule corroboration* below; a domain-shaped title alone does not flag.
- `djset_artist` (medium) — the artist name is a whole **DJ-set / release-listing
  line**, not a name (issue #679): `Enrico Sangiuliano @ Awakenings`,
  `Adam Beyer plays … "Biomorph"`, `Artist - Title - Label - CatNum [Vol`,
  `Secret Cinema B2B Egbert`. **Never deletable** — unlike a watermark the music is
  real and the artist is usually recoverable, so the finding carries its own
  remediation (`merge into "…"` from `djSetArtistName`), or says a human must
  decide when the credit is ambiguous.
- `fragmented_artist` (medium) — a base artist name plus N rows extending it with a
  per-track credit (issue #864): `Sanampay, V. PARRA`, `Luciano Pavarotti, Philharmonia
  Orchestra, Piero Gamba`. One album arrives as a dozen tiles in the artists grid.
  **Reported against the base row**, so the finding names the merge target; **never
  deletable** — the music is real. See *Why a name predicate cannot decide this* below.
- `numeric_single` — a one-track album titled a bare number (`07`).
- `placeholder_single` (medium) — a single whose identity is unknown/placeholder.
- `missplit_album` — ≥3 one-track singles share an edition-stripped title, carry
  genuinely different track numbers, **and** corroborate as one release: a real album
  fragmented per-track (an opera tagged with numeric per-track artists), or a real VA
  compilation. **These hold wanted music — re-merge, don't delete.** Corroborated — see
  *Per-rule corroboration* below; a shared title alone does not flag.
- `watermark_title` (medium) — a **song title** carries a source watermark on an album
  and artist that are both clean (issue #957): ten *Gwen Stefani* tracks stored as
  `Rich Girl www.GrWarez.com`. `looksLikeSourceWatermark` gated the artist and album rules
  and ran over titles only *inverted*, as the deletability guard, so nothing ever reported a
  title. **Never deletable** — the audio is fine, its name is not; retag with
  `fix_song_metadata`.
- `clip_not_song` (medium) — a track under 45 s with **no track number** and no siblings on
  its album (issue #966): a social-media clip indexed as a song, minting its own album row
  and often its own artist. The only rule that looks at `duration`; every other rule asks
  about text, which is why 139 caption fragments cleared all of them. `track IS NULL` is the
  load-bearing condition — 118 sub-45 s tracks on prod *do* carry one (album interludes,
  Pink Floyd segues, Calle 13 skits) and a rule without it reports *Speak to Me*.
  **Advisory, never deletable**: the audio really is junk, but 139 rows is an owner's call.
- `track_collision` (medium) — an album with a `(disc, track)` slot holding several
  **different** songs (issue #959): all 14 tracks of *With the Beatles* are numbered 63, so
  the album has no running order. Same-title collisions are excluded and belong to duplicate
  detection (#951) — measured 298 numbering vs 131 duplicate on prod, and the two want
  opposite remediations, so the titles decide which rule owns the row.
- `untracked_album` (low) — a multi-track album with songs carrying no track number at all.
- `brand_artist` (medium) — an artist credited on ≥5 songs and named in **none** of their own
  artist tags (issue #963): `IPAUTA`, a download site whose folder name became a co-credit on
  56 songs whose real artists were already correct. "The strings differ" cannot be the
  predicate — that is the normal state of a *featured* artist — so provenance decides: a
  genuine credit is derived by splitting the song's artist string and is therefore a
  substring of it, while a folder-derived owner is a substring of none. Folded in JS, never in
  SQL, because `lower`/`LIKE` are ASCII-only (#720).

### Render (low/medium; **visible albums only**)
- `missing_year` (low) — no usable year.
- `missing_artwork` (medium) — no **canonical** `library_artwork` row of `kind='album'`, via the
  shared `missingAlbumArtSql()` predicate (`artwork-store.ts`). Folder/embedded art still renders
  through the `/api/cover` fallback chain — this deliberately measures exactly the set
  `backfillArtwork` acts on. Fixed in issue #732: the rule previously also required
  `cover_art` to be empty, but the scanner always fills `cover_art` with the album id, so the
  rule structurally never fired (~0 findings against 2,691 actually-coverless prod albums). The
  count jumping after the fix is the fix; severity stays `medium` so `report.ok` is unaffected.
- `visible_unknown` (medium) — a visible album stuck at `classification='unknown'`.

### `missing_artwork` measures a row, not a picture (issues #952, #953)

`missingAlbumArtSql` answers *"has no canonical `library_artwork` row"* — exactly the set
`backfillArtwork` acts on, and correct for that job. But the rule's **name**, its worklist framing
and its remediation hint ("maintenance artwork-backfill (bulk)") all describe *"has no artwork"*,
and the serving path does not need a canonical row: `extractCover` is a three-tier fallback —
folder image, then embedded picture. An album with neither a row nor a folder image but embedded
art in its files renders perfectly and was still counted as missing.

Measured on prod (120 albums sampled, then applied to the real format distribution of all 4,271):

| | albums |
| --- | ---: |
| reported "missing artwork" | **4,271** |
| already render via the embedded fallback | ~2,859 |
| genuinely render nothing | **~1,412** |

**The headline number was ~3x the user-visible problem** — and it is the largest number in the
report, so it dominated any read of what is wrong with this library. The health report now carries
the tiers separately: `missing` (no canonical row), `noEmbeddedArt` (…and no track has an attached
picture), `unrenderable` (…and no folder image either). `unrenderable` is `null`, never a number,
when no `musicDir` was supplied — a tier that was not checked must not be reported as absent.

Recording the embedded tier needs the scanner: `library_songs.has_embedded_art` is filled from the
tag read on a scan-cache **miss** (so an unchanged file never re-parses), and the scan-cache version
marker was bumped to `3`, forcing one full re-parse. Without that flush a pre-existing file would
carry no answer forever and the new metric would launch on a partial denominator — the exact failure
it exists to fix.

**Secondary finding, and the bigger one (#953): zero of 1,719 non-mp3 files carry art**, against
~87% of mp3s. That is not a rate, it is an absolute — every path that *produces* a file drops the
cover. `transcodeToOpus` does it with `-vn` (an attached picture is a video stream, and
`-map_metadata` does not bring it back), and m4a never goes through the transcode at all, so at
least one download path drops it too.

Simply removing `-vn` does **not** fix it: ffmpeg's Ogg muxer cannot write an attached picture
stream, and Opus carries art as a base64 `METADATA_BLOCK_PICTURE` comment instead — the flag would
at best change nothing and at worst fail the strict run, which then falls through to the lenient
one. So `preserveFolderCover` writes the album's `cover.jpg` instead, before the transcode discards
anything and again as the organizer lands any format. One write per album rather than per track,
format-independent, and it feeds the tier `extractCover` checks **first** — a tier that was holding
art for 2 of 4,271 albums.

Fixing the producing paths stops the backlog growing; it does not recover the historical opus
albums, whose sources are gone after #827. Those still need a fetch, but closing the leak first is
what stops the backfill being re-run forever.

Both render rules are reported by the health report with a `missingMultiTrack` count beside
the total (issue #969). 81% of visible albums are single-track rows and 93–95% of these two
numbers land on them, so the total is inventory and the multi-track half is the work queue.
Dating a single-track row from its album title is actively wrong — the row is named after the
*release the track came out of*, so it would assign 2012 to a 2010 "Firework".

### Folder art is only the album's when the folder is the album's (issue #978)

`extractCover`'s first tier reads `cover.jpg` from `dirname(track)`. That is right only when the
directory *is* one album's folder, and the scanner has always known some directories are not:
`isLooseSinglesBucket` recognises a **shared bucket** — a `<Artist>/Singles/` leaf, or an
`Unknown Album` — and splits every track in one into its own single-album. The two sides never
agreed on what a directory is, and the readers lost.

On prod one `cover.jpg` a download dropped into `Various Artists/Unknown/` — 1,269 files, 1,247
distinct single-albums, artists with nothing in common — became the served cover of **1,229
albums**. Nothing wrote it through the app: `library_artwork` showed no duplication, `audit_log`
recorded no folder-cover write ever, and the organizer skips non-audio files. It arrived with the
download, which is why the fix has to be reader-side: an external addon will drop another one.

`folderArtBelongsToAlbum(db, relPath)` is the shared answer, and it asks twice because neither
question subsumes the other. **The name** (`isSinglesBucketDir`, the directory half of
`isLooseSinglesBucket` split out for readers) catches a `Singles/` folder that holds one track
today and five unrelated ones after the next download — a count cannot see that yet. **The
contents** — more than one album with tracks directly in the directory — catch a bucket nobody
named, which is what `Various Artists/Unknown/` is. A directory with no scanned rows is treated as
an album folder: an un-scanned file is not evidence of a bucket.

The count is a range scan over `idx_library_songs_path` (`path >= 'dir/' AND path < 'dir0'`) rather
than `LIKE 'dir/%'`, which SQLite cannot answer from that index and which would need wildcard
escaping — `100% Hits/` and `100X Hits/` are one LIKE pattern and two byte ranges.

Both readers ask it. `extractCover` takes the scope as a **required** parameter rather than an
optional one, so a third caller has to answer the question rather than inherit the old assumption.
The health report asks it too: it was calling 644 bucketed opus albums renderable on the strength
of that same stray image, which is the tiers defect above recurring one level down — a metric
agreeing with a predicate instead of with the app.

What the fix restores is asymmetric, and worth stating plainly: of the 1,247 albums in the bucket,
598 are mp3 with embedded art and get their **right** cover back, while 644 are opus with none
(#953's `-vn`) and get an honest placeholder instead of a wrong picture.


### Disk (from `library-disk-audit.ts`)
- `missing_file` (high) — a `library_songs.path` with no file on disk (stale row).
- `orphan_file` (medium) — an audio file on disk with no DB row. **Expected in part**:
  the scanner keeps one best file per track, so deluxe/alt-format extras on disk are
  legitimately not DB rows — review before deleting.
- `empty_dir` (low) — a directory with no entries (leftover folder, safe to `rmdir`).

## Usage

```bash
# Assert (read-only; exits 1 if any HIGH finding)
bun run packages/api/src/scripts/audit-library.ts
bun run packages/api/src/scripts/audit-library.ts --json
bun run packages/api/src/scripts/audit-library.ts --rule=watermark_artist
bun run packages/api/src/scripts/audit-library.ts --no-fail   # report but always exit 0

# Clean (DRY-RUN by default — review, then --apply)
bun run packages/api/src/scripts/repair-pollution.ts                 # default rules: watermark_artist
bun run packages/api/src/scripts/repair-pollution.ts --rules=all --empty-dirs
bun run packages/api/src/scripts/repair-pollution.ts --rules=watermark_artist,watermark_album --apply
```

Env: `NICOTIND_DATA_DIR`, `NICOTIND_MUSIC_DIR`, `NICOTIND_CONFIG` (same as the other
maintenance scripts).

### Hiding is derived state, and it is guarded like deleting (issues #962, #967)

`LibraryCurator.reclassify` re-applies `classification`/`hidden` on every pass for any row with
`manual_override = 0`. That is what makes auto-hiding safe: it is a *derived* verdict, not a stored
one, so fixing the metadata fixes the visibility. Two defects broke that contract in opposite
directions, and both are fixed here.

**The rule matched something it should not (#962).** The hide path tested
`looksLikeSourceWatermark` on the album name with no corroboration, while the *delete* path has
required `albumHasRealTrackTitles` since #705 — junk metadata is not junk audio. So Coolio's real
2001 album *Coolio.com* (9 full-length tracks) was invisible in the UI, and the watermark test also
short-circuited the "a known catalog release is never hidden" block immediately below it. Both paths
now share one predicate, `isRealTrackTitle` (`library-quality.ts`), and the guard is exactly what
separates the two prod populations: the five Tash Sultana rows that *should* stay hidden carry the
watermark as their track titles too.

Hiding is less destructive than deleting, but it is not harmless — the music leaves the user's view
and nothing reports it — so it earns the same guard.

**The outcome outlived the condition (#967).** Album ids are name-derived, so a rename mints a new
row and `metadata-fix.ts` copies the curation columns across. For `starred` and `manual_override`
that is right. For `hidden` it never is: the classifier's inputs are the name and the artist, which
are precisely what the rename changed. An album hidden for a watermarked name stayed hidden after
being renamed to a clean one, with `manual_override = 0` and no rule justifying it — and renaming is
the *main* way anyone fixes an album hidden for a bad name. `applyMetadataFix` now calls
`reclassifyAlbum` after the id move; `manual_override = 1` rows are still left alone. It delegates to
`LibraryCurator.reclassify([albumId])`, so the `protectedKeys` un-hide guard applies — it did not
before, which meant a renamed but deliberately hunted album could be auto-hidden here.

`unjustifiedHiddenAlbums` asserts the invariant that follows — a `hidden = 1` /
`manual_override = 0` row whose predicates are all false is always a bug — and the health report's
`classification` dimension carries it as `hiddenUnjustified` plus a worklist. That count was a bare
number before, so a wrongly-hidden album was indistinguishable from a correct one without running
the predicates by hand, which is how #967 was found.

### Cleanup safety model
`repair-pollution.ts` **deletes files on disk and their canonical rows**, then prunes
orphaned artists (`pruneOrphanArtist`) and empty folders. It is destructive and
irreversible — every deletion is appended to `<dataDir>/repair-pollution.log`.

- **Deletable rules** (`DELETABLE_RULES`): `watermark_artist`, `watermark_album`,
  `numeric_single`, `placeholder_single`. Default (no `--rules`) is
  `watermark_artist` only — the safest, highest-volume junk.
- **The governing rule: junk metadata is not junk audio** (issue #705). Every rule above
  judges a *name*; what `--apply` destroys is *files*. So an album is protected whenever
  **any of its tracks carries a real title** — one that is non-empty and not itself a
  watermark or a bare number (`albumHasRealTrackTitles`). A genuine dumping ground names
  its files after the watermark, so it has no real titles and stays deletable. Reported
  as `protectedRealAudio` in the dry run.

  This was measured, not assumed: on the prod library (2,885 artists / 4,924 albums) the
  audit flagged 6 pollution targets and **all 6 held real music** — including
  `Coolio.com`, Coolio's genuine 14-track 2001 album, one `--apply` from deletion because
  the title ends in `.com`. That one is now caught a layer earlier — #819 stopped it
  being *flagged* at all, so it no longer depends on this guard; the guard still holds
  for every other rule. `You Love Dance.TV` is a real DJ-pool watermark *as an
  artist* — and held a real 4 Strings track, "Acid Phase". The remediation for all of
  them is a retag, never a delete.

- **Per-rule corroboration.** A name-shaped rule may not authorise a delete on its own:
  - `numeric_single` additionally requires the **artist** to be junk (`artistLooksJunk`).
    A one-track album with a numeric title is exactly what a real numeric-titled single
    looks like — `777` (Latto), `2000` (Manuel Turizo), `666`, `222`, `7171` were all
    real. The single-track guard cannot discriminate; the artist can.
  - `watermark_album` additionally requires the album **not** to look like a genuine
    release on all three axes at once — more than one track, at least one real track
    title, and a non-junk artist (`looksLikeRealRelease`). Coolio's 2001 album is
    genuinely titled *coolio.com*, and it was 1 of only 3 findings on prod, so a third
    of a high-severity bucket was false (issue #819).

    The conjunction is load-bearing and was arrived at by measurement, not taste. The
    corroboration first proposed for this rule — *junk artist **or** no real track
    titles* — is satisfied by **neither** of the two genuine prod hits: `LOSERPOWER.ORG
    … VOLUMEN 8` (Nestor En Bloque) and `Most Wanted … ElectronicFresh.com` (Cassian)
    both have a real artist and a real track title. Applying it takes the rule from
    three findings to **zero**. What actually separates them is that the false positive
    has 23 tracks and both genuine hits have exactly one. `library-audit.test.ts`
    asserts that the genuine pair still flags, so a future "simplification" back to
    either single axis fails loudly rather than silently emptying the bucket.

    An album that clears all three and still carries a watermark title is a real release
    with a bad album tag; its remediation is a retag, never the delete this rule feeds.
  - `placeholder_single` uses `isPlaceholderArtistStrict`, not `isPlaceholderArtist`.
    The latter answers *"is this usable as a Lidarr query key?"*, under which the real
    band `!!!` (chk chk chk) normalizes to `""` and reads as a placeholder. That is the
    wrong question to authorise destruction.
  - `missplit_album` additionally requires the cluster's members to carry
    genuinely **different track numbers** (`library_songs.track`), not just a
    shared title (issues #875, #881). A shared title alone is coincidence: all 4
    prod findings before this guard were unrelated artists' own singles sharing a
    generic title — "Closer" (Adriatique / Christian Löffler / The Chainsmokers),
    "Baila Conmigo", "20 Grandes Exitos", "Pensando en Tí" — landed months apart.
    #881's own suggested fix (require the members to share/overlap an *artist*)
    is backwards for this rule: the genuine clusters (the Piazzolla opera, "DUSK
    VA010") have a **different**, often numeric, per-track artist on every member
    by construction — that's exactly why they're mis-split — so an artist-
    agreement gate would zero the rule out entirely. What separates them is that
    a real split keeps each track's original number from the release (92/97/99
    on "Latin Only", 2/3/8 on "DUSK VA010"), while a single is tagged track 1 —
    or untagged — essentially always, so a false-positive cluster's members
    share the same (or absent) track number. Requiring the cluster's non-null
    track numbers to include at least two distinct values removes all 4 known
    false positives while keeping both known true positives.

- **Always protected**: `numeric_artist` and **real-named** `missplit_album` clusters
  (the Piazzolla opera, real VA comps). A mis-split whose shared title is *itself* a
  watermark (`MUSICAUNO.COM`) is **not** protected — it's pure pollution and stays
  deletable. Selection lives in `selectPollutionTargets` (pure, unit-tested).
- Protected real-but-mis-tagged albums should be re-merged with the existing
  `normalize-library` / `repair-album-folders` scripts, not deleted here.

## Re-tagging low-hanging fruit (recover, don't delete)
`scripts/retag-pollution.ts` fixes pollution that is **real music, just mis-tagged** — the
albums the cleanup deliberately keeps — using only data already in the row (no external
lookup). Two patterns (`planRetag`, pure/tested):

- **watermark album, real artist** — `<RealArtist>/MUSICAUNO.COM/<Title>`: the artist is
  correct and only the album field is the watermark → drop it so the track becomes a clean
  single titled by its track name. Skips the *inverted* mis-tag (`DJ KAIRUZ- SERVICIO ARG`
  dumps where the title is itself the watermark and the real name sits in the artist field) —
  those are ambiguous junk left to the `watermark_album` delete path.
- **numeric-artist mis-split with an embedded title** — `101/1968 - Astor Piazzolla - MARÍA
  DE BUENOS AIRES/<Title>`: parse `YYYY - Artist - Album` out of the album title. Every
  fragment re-mints to the same corrected album id and **merges** back into one album.

Each correction goes through the existing `applyMetadataFix`: a **reversible** override in
`library_metadata_overrides` (survives rescans) plus an immediate canonical re-point (merging
collisions, pruning orphan artists). Files are not moved (`songId` stays stable); the on-disk
folder is tidied later by a reorg pass.

```bash
bun run packages/api/src/scripts/retag-pollution.ts           # dry run
bun run packages/api/src/scripts/retag-pollution.ts --apply   # write corrections (logged, reversible)
```

### Year backfill
Two paths, depending on whether a live metadata service is available:

- **Offline** — `scripts/backfill-years.ts` (+ pure `services/year-backfill.ts`) fills years
  with no network, from three local signals, highest-confidence first: the song **tag** year,
  the album **folder**-name year (`parseYearFromFolder` — reliable for comps like "Max Mix 2015"),
  and — opt-in via `--mb-cache` — the release date of the matching recording in the existing
  `mb-cache.json`. The mb-cache mapping often points at a **reissue**, so its year can be a
  reissue date (e.g. "Chocolate Starfish" → 2024 not 2000) — opt-in, logged, reversible; spot-check.
  Each year is written through the reversible `applyMetadataFix` (override + canonical columns),
  so it survives a full rescan even when the file tag has no year.
  ```bash
  bun run packages/api/src/scripts/backfill-years.ts --apply             # tag+folder (high-confidence)
  bun run packages/api/src/scripts/backfill-years.ts --mb-cache --apply  # + mb-cache (reissue caveat)
  ```
- **Online** — the existing **metadata-optimize** pass (`scripts/optimize-metadata.ts` / admin
  `POST /api/admin/metadata-optimize`) re-fetches year/cover/type from a live Lidarr — the highest
  accuracy, when Lidarr is configured. The admin route is **asynchronous** since issue #622: it
  answers 202 and reports progress through `GET /api/admin/review`; the script stays synchronous.
  See [metadata-optimize.md](metadata-optimize.md).

## Why a name predicate cannot decide `fragmented_artist` (issue #864)

Every other rule in this catalogue judges a name **on its own**. This one cannot, and
the reason is worth keeping: these two rows are the same string shape.

```
Sanampay, V. PARRA                    ← junk: the composer of that track
Charlotte de Witte, David Robertson   ← real: a collaboration
```

Nothing in the string separates them, so the signal is **relational** — how many rows
extend one base name that is itself an artist row. A per-track credit list shreds an
album into one artist row per track; genuine collaborations accumulate a handful.
Measured on the prod library (3,157 artists, 6.1 ms):

| base | rows | verdict |
| --- | --- | --- |
| Luciano Pavarotti | 15 | shredded album (`Luciano Pavarotti - The Best`) |
| Sanampay | 14 | shredded album (`En Esta Hora...`) |
| Charlotte de Witte / Eelke Kleijn / Los Ángeles Azules / Sentimental Animals / Tego Calderón | 2 each | real collaborations |

The gate is `minFragments = 2` — the lowest there is. A size threshold would have to sit
inside the measured 4→14 gap, and dropping a real 3-row shredding to spare a curator two
dismissals is the wrong trade: the finding is advisory and only a human can tell a
composer credit from an orchestra credit. **Recall over precision, deliberately.**

### How it stayed invisible

Worth recording, because four separate things had to line up:

1. **No name validation on the scan path.** `resolveTags` takes the tag as-is;
   `sanitizeArtistTag` is organizer-only, and `normalizeArtistForGrouping` preserves
   punctuation by design, so `Sanampay, A. BORDA` and `Sanampay` are different ids.
2. **`split_compound` was incomplete, not inverted.** `splitArtists` is all-or-nothing; an
   *unresolved* compound yields one primary, so `split_compound = 0` and the grid
   renders it — while a resolved one is hidden. Hiding on a *successful* split is right
   (the member tiles represent the row); what was missing was the other direction — a
   hide condition for a compound the splitter could **not** resolve whose base row
   already represents its music. That is `fragment_of`, shipped for the grid only
   → [library-scanner.md](library-scanner.md); this rule stays advisory, and still
   reports the fragments the visibility signal cannot reach.
3. **No detector iterated `library_artists` for fragmentation.** `checkFragments` and
   `checkMisSplitAlbums` both key on album *title*; `checkPollutedArtists` was a
   keyword/number/DJ-set list.
4. **The system already knew and had nowhere to say it.** `pendingArtistIdentityRows`
   selects on `name LIKE '%, %'` — it picked these rows up, failed to resolve them
   against Lidarr, recorded `decision: 'unknown'` and muted itself for 7 days. No
   finding, no flag, no metric. *A component that detects something and reports nothing
   is indistinguishable from no detector at all.*

## Prevention (so new patterns can't recur)
- `sanitizeArtistTag` / `sanitizeAlbumTag` (`library-organizer.ts`) now reject
  `looksLikeSourceWatermark` values at ingest, so a watermark never mints an artist/album.
- `cleanDisplayTitle` (`services/title-clean.ts`, issue #722) strips YouTube junk —
  "(Official Video)", "(Audio Oficial)", "[Lyric Video]" — from the title and album tags in
  `readWithFallback` before landing, whole-segment conservative so "(Remix)"/"(En Vivo)" survive.
  The curative half is the `lookup_song_metadata`/`fix_song_metadata` MCP pair
  ([mcp-agent.md](mcp-agent.md)).
- **Structural corruption (issue #679)** is caught by the same seam but handled
  differently, because it is not a keyword the source stamped on — it is a whole
  line of text that landed in the tag. `sanitizeArtistTag` first tries
  `djSetArtistName` to **recover** the leading credit (`Enrico Sangiuliano @
  Awakenings` → `Enrico Sangiuliano`); dropping instead would strand the track in
  Unsorted and throw away the one fact the string carried. Only when nothing is
  recoverable — an ambiguous `b2b` credit names two acts — is the tag dropped
  rather than guessed at. `sanitizeAlbumTag` applies `looksLikeDjSetTag` alone and
  **not** `looksLikeVenueCredit`: "Live @ Wembley" is a real album title, so the
  venue rule is artist-only by construction.

  Two markers are deliberately absent. A **single** ` - ` is not a marker —
  "Artist - Title" in an artist tag is indistinguishable from a hyphenated real
  name without already knowing the artist. A bare `@` without surrounding spaces is
  not one either. Both were left out because the false-positive cost (eating a real
  artist) is worse than the miss.
- `LibraryCurator.classify` auto-hides watermark artists/albums and bare-number artists
  on every scan, so pollution that predates the ingest guard disappears from the UI
  without deleting files (the cleanup pass still finds and removes it from disk/DB).

## Production run (2026-06-22)
Initial audit — 777 artists · 1783 albums · 6842 songs · 1040 visible singles; 101 HIGH:
`watermark_album 66 · numeric_artist 15 · missplit_album 10 · missing_file 6 · watermark_artist 2
(owns 222 albums) · album_count_mismatch 1 · numeric_single 1`; `orphan_file 577 · missing_year 835 ·
empty_dir 533`.

Actions taken:
1. **`repair-pollution --rules=watermark_artist --empty-dirs --apply`** — deleted the
   `ftpdjemilio.com`/`Batea` dump (222 albums / 2.3 GiB) and swept 533 empty dirs. (DB backed up first.)
2. **`retag-pollution --apply`** — recovered 31 watermark-album singles to their real artists
   (CID, UMEK, RÜFÜS DU SOL…) and merged the 15-fragment **Astor Piazzolla — María de Buenos
   Aires** mis-split into one album.

3. **`backfill-years --apply`** (tag+folder, offline) — filled 46 high-confidence years
   (missing-year 633→587). The remaining ~195 are recoverable offline via `--mb-cache` (reissue
   caveat) or accurately via a live Lidarr (`optimize-metadata`).

Result — 759 artists · 1545 albums · 6630 songs; **51 HIGH (from 101)**, `numeric_artist 0`,
`empty_dir 0`. Remaining `watermark_album 35` is the ambiguous `DJ KAIRUZ- SERVICIO ARG` DJ-pool
dump — re-tag can't cleanly recover it; delete via `--rules=watermark_album` if undesired.

## Library health report (issue #734)

`libraryHealth(db, { sampleSize })` (`services/library-health.ts`) is the **aggregation** the
auditor never had: one pure, synchronous, DB-only report where every curation dimension is
`{ metric, worklist, remediation }` — how much is missing, a bounded worst-first sample, and which
remediation acts on it. The route (`GET /api/library/health?sample=N`, curator), the CLI
(`scripts/library-health.ts`, always exits 0 — a dashboard, while `audit-library.ts` remains the
DB+disk *gate*) and the MCP `get_library_health` tool are three renderings of this one object; the
planned Admin panel (issue #736) is the fourth.

Dimensions: audit summary (per-rule counts, no findings array), fragments (dup-album clusters),
album covers (`missingAlbumArtSql`), artist portraits (`artistImageCoverage`), genres
(`unresolvedGenreSql`, landed songs only), years, classification, **format cohesion** (new),
**completeness** (new), lyrics (count only — fetch is on-demand by design), open curation flags.

Design rules it inherits:

- **A metric is what its remediation acts on** (the `NEEDS_PORTRAIT_SQL` doctrine): the covers
  number is `backfillArtwork`'s candidate set; the lossless-remaining count is
  `transcodeLibraryToOpus`'s; the confirmed-incomplete rows use the *same* matcher (`onDiskTitles` +
  `titlesOverlap`) as `acquireAlbum`, so "incomplete here" means "a hunt would enqueue something".
- **On-demand only, never polled.** The audit half issues per-row queries — fine as a snapshot,
  poison in the `ServiceReview` interval. The Admin panel fetches on expand.
- **Shared predicates, derived not restated** (`check:shared-helpers` spirit): `missingAlbumArtSql`
  (also adopted by `checkRenderGaps`, `backfillArtwork`, `optimizeAllAlbums`) and
  `losslessSuffixSql` (derived from `LOSSLESS` in `library-track-select.ts`).

### New detectors and their calibration (prod, 2026-08-26, 16,386 songs / 5,173 visible albums)

**Format cohesion** — mixed-format albums (visible, ≥2 tracks, >1 distinct suffix; 238 on prod),
low-bitrate albums (≥½ of known-bitrate tracks below the per-format floor: **128 kbps** lossy,
**96 kbps** opus; lossless exempt; `bit_rate <= 0` = unknown, never low — prod holds 8 zero-bitrate
probe-failure rows), and the lossless-remaining count (518). The floors are deliberate: a 160 kbps
floor would have flagged 39% of all prod mp3s — noise, not signal. 128/96 flagged 15 albums, all
genuinely degraded.

**Completeness, two-source and honest about it**:

- *confirmed* — `album_jobs` rows (newest per artist/title pair wins): canonical tracklist vs
  `onDiskTitles`, carrying `lidarrAlbumId` for the `complete_album` tool. Albums with **zero**
  matching tracks on disk are skipped — absent is a curator decision (maybe deleted on purpose),
  not incomplete.
- *suspected* — per-disc track-number gaps (`MAX(track) > COUNT(DISTINCT track)`), **advisory
  only**, never fed to a hunt without a curator confirming. Guards, each earned on prod: every
  owned track distinctly numbered (junk tags share one number), ≥3 numbered tracks owned (loose
  rips keep their source compilation's track number), `maxTrack ≤ 40` (disc-track mashes like
  `101`), albums/EPs/compilations only. Raw SQL found 1,627 album-discs; the guards cut it to 463,
  and the survivors sampled real (The Dark Side of the Moon 8/9, Midnights 12/13).


### `confirmed` must mean "a hunt would enqueue this" (issue #758)

The `completeness.confirmed` worklist is the input to Wave 4's bounded acquisition budget, so its
contract is operational, not descriptive: every row must be an album `complete_album` would act on.
It was not. A prod sample of 10 hunts returned **4 `already-complete`**, against a worklist whose
whole premise is "confirmed missing 1 track".

The cause is two predicates answering different questions:

| | asks | answers |
|---|---|---|
| `confirmedIncomplete` (the worklist) | does every canonical **title** have an on-disk match? | missing: 1 |
| `albumAlreadyComplete` (the hunt guard) | does the local album hold enough **rows**? | already-complete |

They disagree exactly when a song is on disk under a different spelling — full track count, one
title that does not overlap. The worklist's own comment claimed *"Same matcher acquireAlbum uses, so
'incomplete here' ⇒ 'a hunt would enqueue'"*, which was simply false, and is why every sampled row
carried `state: "done"` from a prior hunt that had in fact landed the file.

An album with the full track count and an unmatched title is a **tagging** problem: hunting it would
re-download a file already present. So `confirmedIncomplete` now applies the hunt's own guard, and
the excluded rows surface as `completeness.worklist.titleMismatches` with a `titleMismatch` metric —
reported rather than dropped, since 40% of a worklist is a finding, and its remediation (retag) is
real work, just not acquisition work.

The general rule, third instance of it: **a list whose contract is "X would act on these" must apply
X's own predicate, not a predicate that looks equivalent.**

### …and X's own *input* (issue #1080)

#758 aligned the predicate but not the data it runs on. The worklist read the tracklist stored in
`album_jobs.canonical_tracks_json` at hunt time; `acquireAlbum` re-fetches it from Lidarr
(`track.listByAlbum`), and Lidarr's monitored release can change afterwards. A prod sample of 6 hunts
returned 4 `already-complete`, and all four were this:

| album | stored list | live list | local songs |
|---|---|---|---|
| Tyranny of Beauty | 10 | 9 | 9 |
| Never Let Me Down | 14 | 13 | 13 |
| V | 20 (remixes) | 14 | 15 |
| Mi vida loca | 19 (live/remix bonus) | 14 | 14 |

So the MCP `get_library_health` tool and `GET /api/library/health` call `libraryHealthWithLidarr`,
which fetches the live tracklist for each confirmed candidate (8 at a time) and re-runs the same
evaluation on it. A failed fetch keeps that album's stored list; `completeness.metric.liveTracklists`
counts the albums re-checked and is `null` when no Lidarr was consulted (the CLI script). The
rows that fall out mostly land in `titleMismatches` (live count met, one title spelled differently:
`Stratosfear 1995` vs `1994`, `My Heart Is Open feat. Gwen Stefani`) — retag work, not hunts.

`owned` was also overstated (V: 19 against 15 songs held): a single on-disk `Maps` matches both
`Maps` and `Maps (Slaptop remix)`, so matched-title counts can exceed the album. `owned` is now capped
at the on-disk song count, and `expected − owned` no longer has to equal `missing` (the canonical
titles with no match).

## Tests / CI
`library-quality.test.ts`, `library-audit.test.ts`, `library-disk-audit.test.ts`,
`library-health.test.ts`, `routes/library.health.test.ts`,
and the `library-curator.test.ts` cases run in the `ci` job
(`bun test packages/api/src`). The pure predicates and `selectPollutionTargets`
mis-split protection are unit-tested directly; the auditor rules, health dimensions and curator
auto-hide use a seeded in-memory `bun:sqlite` DB (the health tests enumerate every
suspected-gap false-positive guard by name).

## Follow-up (deferred): BPM / genre at acquisition
On-demand `analyzeBpm` + `verifyGenre` (`track-analysis.ts`) could run in the ingest
pipeline (post-organize, gated on ffmpeg/Lidarr, best-effort/async) to auto-fill
`bpm`/`genre` so genre-browse / categorization improves. Out of the initial auditor
iteration; revisit once the audit/cleanup loop is established.
