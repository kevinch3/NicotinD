# Full-library Opus conversion with loudness normalization

**Status**: design, not approved. No code written.
**Date**: 2026-09-20
**Supersedes the narrow fix proposed in**: #723

## What this is

Convert every song in the library to Opus, applying EBU R128 loudness normalization in the same
ffmpeg pass, choosing the Opus bitrate per source rather than using one constant.

## What already exists

More than expected. `transcodeLibraryToOpus` (`library-transcode.ts:68`) already converts library
files to Opus, already handles the song-id change that a new file extension forces, and already
runs from both a CLI script and an Admin button. `downloads.transcodeLossless` is
`{enabled: true, format: opus, bitRate: 192}` by default, so lossless downloads are converted at
ingest — which is why only **3** lossless songs remain out of 21,641.

So this is not a new pipeline. It is a change of predicate, plus normalization, plus a bitrate
decision — and then the work of making machinery that was built for a handful of files survive
21,641 of them.

## Measured scope

Read-only against prod, 2026-09-20, `library_songs`, 21,641 songs / 122.17 GiB. Loudness coverage
is **100%** — no row has a null `loudness`.

| ext | songs | GiB | avg kbps |
|---|---|---|---|
| mp3 | 13,576 | 76.36 | 193 |
| **opus** | **7,774** | **43.81** | **184** |
| m4a | 238 | 1.63 | 254 |
| ogg | 44 | 0.23 | 235 |
| wma | 6 | 0.03 | 134 |
| flac | 3 | 0.11 | 975 |

**A third of the library is already Opus.** That changes the shape of the job: 13,864 files need a
re-encode, not 21,641, and the 7,774 that are already Opus must not be put through a second
generation for no reason.

It also largely answers the "will Opus play everywhere" question empirically rather than from
specification: 7,774 Opus files are in the library today and playing. Worth confirming explicitly
on iOS, where Ogg-Opus support arrived late, but this is not an unknown container being introduced
to the app for the first time.

The mp3 bitrate distribution is cleanly bimodal — 8,138 files at 128–159 kbps and 4,383 at 256+ —
which makes a source-adaptive mapping straightforward rather than a guess:

| source bucket | files | now | → Opus | after | saved |
|---|---|---|---|---|---|
| < 128 kbps | 80 | 0.34 GiB | 64 | 0.13 GiB | 0.21 |
| 128–159 | 8,153 | 30.19 GiB | 96 | 21.85 GiB | 8.34 |
| 160–255 | 1,038 | 5.76 GiB | 112 | 3.26 GiB | 2.50 |
| 256+ | 4,589 | 41.84 GiB | 128 | 16.57 GiB | 25.27 |
| **total** | **13,864** | **78.22 GiB** | | **41.85 GiB** | **36.4** |

The library goes from 122.17 GiB to about 85.8 GiB, a **30% reduction**, and 64% of files are
re-encoded once.

**Re-measured 2026-09-21**, replaying the shipped ladder read-only against prod: **13,867**
candidates (three files added since), 78.35 GiB → 41.86, saving **36.49 GiB**; library 122.16 →
85.67. **Zero candidates lack a duration**, so that figure is an estimate rather than a floor — the
`unestimated` caveat below does not apply to this run.

## The predicate change, and why it is a different decision in kind

The pass keeps a file only if `isLossless(suffix) || isLossless(ext(path))`
(`library-transcode.ts:93`), with a codec probe for `.m4a` containers. **Everything lossy — mp3,
aac, ogg, existing opus — is invisible to it** (pinned by `library-transcode.test.ts:259-271`).

Converting FLAC to Opus is lossless to lossy: a first-generation encode. Extending the predicate to
mp3 and aac is **lossy to lossy**, a second-generation encode across ~21,600 files, and the pass
deletes the original (`post-download-transcode.ts:195`) with no backup and no rollback. That is the
one thing here that cannot be undone.

## Five gaps that scale badly

Each is fine at three files and dangerous at 21,641. These are the actual work of this plan.

### 1. The identity migration covers 4 tables of ~14

`songId(relPath) = sha1('song:' + relPath)` (`library-scanner.ts:298`), so changing `.mp3` to
`.opus` re-mints the id. There are no foreign keys on `song_id` — deliberately, since a cascade
would delete listening history on a routine rescan (`db.ts:1777-1782`). Nothing errors. Rows stop
matching, silently. The codebase has been burned once already: `db.ts:1782` cites "the failure that
produced dangling playlist_songs, #259".

The existing migration (`library-transcode.ts:153-198`) carries across four things: `starred` and
`hidden`, `playlist_songs`, the song-scope genre override (#856), and `acquisitions` provenance.
`scanPaths` then rebuilds `library_song_genres` and `library_song_artists` from the new file's tags.

**Not carried, and therefore orphaned:**

| Table | Cost of losing it |
|---|---|
| `library_lyrics` | **2,436 rows.** Deliberately outside `ORPHAN_TABLES`, so nothing prunes it and nothing repairs it. Synced LRC offsets are database-only and are simply lost |
| `library_embeddings` | ~46% of the prod database by bytes; sidecar must re-embed everything |
| `library_song_descriptors` | timbre/groove/band, ~5 s each to recompute |
| `recommendation_feedback` | "never recommend this" exclusions silently reset |
| `curation_flags` (song-scoped) | open review flags orphan under the unique-open-flag index |
| `play_events` | history de-links; partly softened because title/artist/album are snapshotted onto the event, but the play-count index goes cold |
| `library_song_analysis_failures`, `library_song_provenance`, `completed_downloads`, `acquisition_job_items`, `scan_cache` | stale or unreachable rows |

Albums and artists are **name**-derived (`library-scanner.ts:304`, `:314`), so they survive, and
`library_artwork` is keyed on album id, so album covers survive.

Four repoint helpers already exist for this shape and are not used here — `playlist-repoint.ts`,
`acquisition-repoint.ts`, `genre-override-repoint.ts`, `artist-curation-carry.ts` — and each cites
`library-transcode.ts` as its precedent.

**Design.** Do not extend the ad-hoc list by hand, and do not fall back on the heuristic matcher:
`repointGenreOverridesBeforePrune` matches on `(title, artist, duration)` with exactly one survivor
(`genre-override-repoint.ts:73-79`), and duration is an integer of seconds that an Opus encode can
shift across a rounding boundary. At whole-library scale that quietly drops curation.

Instead, since the conversion knows `oldPath` and `newPath` exactly, it knows `oldId` and `newId`
exactly. Record that map, apply it in one transaction, and **gate coverage off the schema**: a test
that enumerates every table carrying a `song_id` column via `pragma_table_info` and fails if the
migration does not name it. A table added later then cannot silently fall out. This matches the
repo's existing rule that gates assert their own denominator.

### 2. `-map_metadata 0` silently loses the analysis tags on mp3 sources

This one invalidates the obvious shortcut. Analysis results are mirrored into file tags — `BPM`,
`KEY`, `ENERGY`, `LOUDNESS_LUFS`, `VALENCE`, `DANCEABILITY`, `ACOUSTICNESS`, `INSTRUMENTALNESS`,
`MOOD` (`audio-tags.ts:110-118`) — so the tempting plan is to let `-map_metadata 0` carry them into
the Opus file and have the scanner read them back, skipping re-analysis of 21,641 files.

That works for FLAC, because Vorbis comments map onto Vorbis comments. It does **not** work for
mp3: those values live in ID3 `TXXX` frames and lyrics in `USLT`, and ffmpeg has no guaranteed
`TXXX`-to-Vorbis-comment mapping. Expect silent loss of every analysis tag and of the
embedded-lyrics recovery path — which is also the only fallback for the orphaned `library_lyrics`
rows in gap 1. **No test covers tag preservation at all.**

**Design.** Read tags with the existing reader before encoding, and write them explicitly with
`writeAudioTags` after, rather than trusting `-map_metadata 0`. Add the tag-preservation test the
pass has never had.

### 3. `-vn` drops embedded artwork, and the folder fallback only fires when the folder is bare

The encoder passes `-vn` (`post-download-transcode.ts:145`) because ffmpeg's Ogg muxer cannot write
an attached picture stream; Opus wants a base64 `METADATA_BLOCK_PICTURE` comment instead.
`preserveFolderCover` runs first (`:128`) but writes a folder cover **only if the folder has none**
(`cover-sources.ts:167-180`).

At lossless volumes that is a reasonable trade. Across the whole library it means: every track's
embedded art is discarded, one cover per album is kept, and per-track distinct artwork —
compilations, singles sharing a folder — is **lost**. The library already reports 4,462 albums
missing artwork and 1,181 with no embedded art. This would convert a cosmetic gap into a permanent
one, and it rhymes with #978, where one stray `cover.jpg` became the cover of 1,229 albums.

**Design.** Write `METADATA_BLOCK_PICTURE` properly so embedded art survives the container change,
or treat artwork extraction as a required pre-step with per-track fidelity. Not a `-vn` and a hope.

### 4. Verification is duration-only and fails open, yet the original is deleted unconditionally

The swap is temp-then-rename, which is right, and a failed encode leaves the source untouched
(`post-download-transcode.test.ts:147-158`). But the only check before
`rmSync(absPath, {force: true})` is a duration comparison with a 1.0 s tolerance
(`transcode.ts:232-239`), and it **returns `true` when either probe returns null**. There is no
size check, no bitrate check, no channel or sample-rate check, and no decode-integrity check.

For lossless sources that is tolerable: the failure it catches, truncation, is the realistic one.
For lossy sources it is not, because generation loss is invisible to a duration check, and the
original is gone the moment the rename lands.

The duration comparison is also mildly biased toward passing, and it is worth knowing why:
**`ffprobe` does not subtract pre-skip for Ogg-Opus**, so it over-reports an Opus file's playable
length by the pre-skip, measured at 6.5 ms on a reference encode. The check reads source duration
from `music-metadata` and output duration from `ffprobe`, so the output always looks slightly
longer than it is. That is far inside the 1.0 s tolerance and harmless today, but it means the
check is not measuring what it appears to measure.

The library database is unaffected — the scanner takes duration from `music-metadata`
(`library-scanner.ts:1159`), not `ffprobe`. It does round to whole seconds, which is the rounding
that makes the heuristic repoint matcher in gap 1 unsafe.

**Design.** Verify what actually matters before deleting an irreplaceable file: decoded sample
count, channel count, sample rate, and a measured output loudness within tolerance of the target.
Fail closed when a probe returns null. Consider a quarantine window instead of `rmSync` for the
first production batches.

### 5. Throughput, cancellation, and a row delete that commits outside its transaction

- **Concurrency is 1** (`library-transcode.ts:111`, a plain sequential loop). At a few seconds per
  track, 21,641 files is on the order of a day and a half of wall clock. The download path already
  has a pooling model to copy (`library-organizer.ts:905-923`).
- **Cancellation is checked only between files** (`:112-115`); an in-flight ffmpeg is never killed.
- **`DELETE FROM library_songs WHERE id = ?` at `:155` commits before `scanPaths` runs and outside
  the migration transaction.** If the scan throws, the catch only logs and increments `failed`: the
  old row is gone, the new one was never inserted, and the song is invisible until a full rescan.
  At whole-library scale this is a way to lose many songs quietly.
- `SELECT` with no `WHERE` pulls the entire song table into memory and filters in JS (`:86-93`).
- Dry-run's `bytesReclaimed` adds the **full original size** rather than the difference (`:125-130`
  versus `:201`), so it over-reports by the size of every resulting file.
- The Admin button ignores `enabled: false` (`tasks.ts:196`).

## Normalization: do not bake it into the audio

The obvious design — an ffmpeg `loudnorm` filter in the encode — is the wrong one, for two
reasons.

**It corrupts the recommender's input for every song ingested afterwards.**
`computeEnergy(integratedLufs, loudnessRange)` maps loudness onto a 0..1 energy score: −25 LUFS is
0, −7 LUFS is 1 (`loudness-analysis.ts:70-76`), and `energy` feeds radio, playlists and the
recommendation feeds. Flatten every file to one target and the measured loudness of every file *is*
that target, so energy collapses to a function of loudness range alone.

The timing matters, and it is worse than it first looks. `computeEnergy` is called from exactly one
place — inside `analyzeLoudness` itself (`loudness-analysis.ts:145`) — and the enrichment selector
is `energy IS NULL` (`enrichment/tasks.ts:791`), so already-analyzed songs are never re-analyzed.
Baking gain would therefore leave today's values intact and silently produce wrong energy for
**every song ingested from then on**. A gradual, invisible corruption is harder to notice than an
abrupt one.

(An earlier draft of this plan also claimed `loudness` drives a radio loudness-jump avoidance.
**It does not.** No such feature exists; the only occurrence in the repo is an aspirational doc
comment at `loudness-analysis.ts:18`. `loudness` is selected into the radio and library DTOs and
scored on by nothing. The claim came from #723's triage, which has now been wrong three times.)

**It is irreversible and it cannot be re-tuned.** Baked-in gain means changing the target later is
another full re-encode of the library.

### Use the Opus header gain instead

Opus carries an `output_gain` field in its `OpusHead` identification header, and RFC 7845 §5.1
requires a decoder to apply it. It is a gain applied at decode time, in a header, not in the coded
audio.

That separates the two decisions cleanly:

- **The encode** decides which files become Opus and at what bitrate. One generation, once.
- **The normalization** is a header value. Lossless, re-tunable by rewriting a couple of bytes,
  and it never touches a sample.

Three consequences follow, and they are the reason to prefer this shape:

1. **The descriptor trap disappears entirely.** The audio is unmodified, so `loudness` keeps
   describing the master as acquired and `computeEnergy` keeps working. No second column, no
   pre-capture dance, no migration.
2. **The 7,774 files that are already Opus can be normalized right now**, losslessly, without
   waiting for or depending on any conversion. That is a third of the library, and it is the
   cheapest available answer to #723.
3. **The target stays a decision, not a commitment.** Picking −14 and later preferring −12 costs a
   header rewrite, not 13,864 re-encodes.

Negative gain is unconditionally safe. Positive gain can clip at the output, but the files needing
positive gain are the quiet ones, which by construction have headroom. Clamp the positive direction
against measured true peak.

**Two things to confirm before committing to this** (a spike, not a build): that browsers and the
Capacitor WebViews honour `output_gain` in practice rather than merely in specification, and which
tool writes it — `opusenc --gain` at encode time is straightforward, but patching an existing file's
header means recomputing the Ogg page CRC, and `opus-tools` is not currently in the image
(`Dockerfile:94` installs ffmpeg only).

If the spike fails, fall back to a `loudnorm` encode **plus** a new column preserving the
pre-normalization loudness, so the descriptor survives. That fallback is strictly worse: it is
irreversible and it cannot normalize the existing Opus third without a second generation.

### Album gain, not track gain — decided

The header gain is one baked value that the decoder applies unconditionally, so it cannot switch per
playback context. Radio and shuffle want every track at the same level; album playback wants the
quiet interlude to stay quiet relative to the track beside it, which is what album sequencing
encodes.

**Decided: album gain goes in the header, and the per-track delta is stored as an
`R128_TRACK_GAIN` Vorbis comment.** Album intent is preserved by default, and a future client that
wants track normalization has the number without another pass over the library. Album grouping
already exists via `library_songs.album_id`.

## Adaptive bitrate

Two readings; this plan takes the first.

**Source-adaptive encode bitrate.** Pick the Opus target per file from the source's quality instead
of one constant. Today every file gets the same `-b:a ${bitRate}k` (`post-download-transcode.ts:150`)
with no `-vbr`, no `-application audio`, and no per-file adaptation. Spending 192 kbps of Opus on a
96 kbps mp3 stores artifacts at high fidelity and wastes roughly half the bytes; spending 96 kbps
on a 320 kbps source discards quality that was there.

The input already exists and is reliable: `library_songs.bit_rate` is populated at scan from
`music-metadata` (`library-scanner.ts:1163`), and the measurement above found **only 4 rows** in the
whole library with an unknown bitrate. Note `probeAudioFile` (`transcode.ts:317-368`) is *not* the
right fallback — it never falls back to `format=bit_rate` and so returns null for many real files,
and a `bit_rate` of `0` means probe failure, not a real bitrate.

The mapping in the scope table above is the proposal: 64 / 96 / 112 / 128 kbps against the four
source buckets. It is deliberately conservative at the top — Opus at 128 kbps is generally held to
be transparent for stereo music, so spending more on a 320 kbps mp3 source preserves artifacts
rather than music. The exact numbers are an open decision, and the function should be pure and
table-driven so they can be argued about in a test rather than in the encoder.

**Network-adaptive streaming** (HLS/DASH, switching rendition mid-playback) needs a segmenting
pipeline and a player that can switch. Out of scope.

## Requirement: back up before transcoding

Not a preference and not an open question. The pass deletes the original unconditionally
(`post-download-transcode.ts:195`) after a duration check that fails open, and generation loss is
invisible to that check. Nothing in the repo currently moves a library file anywhere but to
`unlink`.

Two backups, because two different things can be lost:

**The originals.** Move each converted file to `<dataDir>/quarantine/<batch>/` rather than
unlinking it, and release the batch only once its outputs are verified. `dataDir` rather than
`musicDir` is deliberate and settles open decision 4 — it avoids needing a new `PathConfig` reserved
directory (`services/library-paths.ts:16-21`), avoids the full-scan warning at
`library-scanner.ts:1085-1093`, and avoids colliding with the path stems the remap matches on. It
also follows the existing precedent, since both database backup paths already live under `dataDir`.

Retention copies that precedent exactly: **count-based, scoped to its own name pattern, never
time-based, never a blanket delete of the root** (`services/migration-backup.ts:34-43`,
`:105-110`, `:136-149`). Disk is bounded by quarantining one batch at a time, not the library.

**The database.** The id remap rewrites rows across roughly a dozen tables, and a wrong remap is
not recoverable from the files. Take a snapshot before the run using the existing
`services/backup.ts`, on the `pre-migrate` model rather than the daily rotation — a snapshot taken
for a destructive pass must not age out on the seven-day clock
(`services/migration-backup.ts:66-76`).

If `dataDir` and `musicDir` sit on different filesystems the move is a copy, which is another reason
to bound it to one batch.

## The container is a real decision, and Ogg is not automatically right

Ogg-Opus carries **no duration field anywhere**. RFC 7845 defines none; duration is recoverable only
as `(final granule position − pre-skip) / 48000`, which means reading the *last* page. Both engines
do exactly that and both gate it on the transport being seekable — Chromium through ffmpeg's
`ogg_get_length()`, which seeks to the last 64 KB, and Firefox through `OggDemuxer::RangeEndTime()`,
guarded on a known content length. Fail that and `duration` is `Infinity` and seeking is dead.

**Our server already meets the full contract**, which is why the 7,774 Ogg-Opus files play today:
`Accept-Ranges: bytes` on every response, `206` with `Content-Range`, accurate `Content-Length`,
`If-Range` validation, and suffix ranges handled specially for iOS CoreMedia
(`streaming.ts:432-534`). There is also **no compression middleware anywhere in the API**, which
matters more than it sounds: gzipping audio silently costs both duration and seeking, and Firefox
disables seekability outright on a compressed response.

Two live browser defects survive a correct server:

- **Chromium 40781739** — repeatedly seeking an Ogg `<audio>` element makes the reported duration
  creep upward, with a storm of `durationchange` events. Closed **Won't Fix, Intended Behavior** in
  2024, root-caused to ffmpeg's Ogg seek handling. Firefox does not reproduce it.
- **Mozilla 1810378** — long Ogg files stall for 15–20 s on load and seek, and the built-in player
  caps near 12 h 25 m. Still unassigned. The reporter fixed it by remuxing to WebM. Our longest
  content is DJ sets, comfortably under that threshold.

WebM-Opus answers both: its `Info/Duration` element sits about **250 bytes into the file**, so no
tail read is needed, and it decodes sample-exact via `CodecDelay` and `DiscardPadding`. It is a
**remux, not a re-encode** — `-c copy`, no quality cost, applicable to the whole library at any later
date.

**But WebM forfeits the tag simplification.** Matroska carries its own tag system rather than Vorbis
comments, and `.webm` is in `AUDIO_EXTENSIONS` but in **neither** `ID3_EXTS` nor `VORBIS_EXTS` — the
library can index a WebM file today but cannot write its tags at all. Choosing WebM means building a
third tag path instead of deleting two.

### The iOS floor, which is the one hard constraint here

**Safari gained Ogg container support only in iOS 18.4 / macOS 15.4, shipped 2025-03-31.** Before
that it plays no Ogg-Opus at all. Converting the library to Ogg-Opus therefore sets a hard minimum
OS version for the iOS app, and anything older gets silence rather than a degraded experience.

That is survivable eighteen months on, but it must be a decision rather than a discovery, and it
needs two things checked before the conversion rather than after:

- Confirm on a real device that the 7,774 Ogg-Opus files already in the library play on the iOS
  app, and that seeking and reported duration behave. There is no good public evidence on Ogg-Opus
  seek behaviour in Safari 18.4+, so this is a measurement, not a lookup.
- Decide what happens below the floor. An AAC or MP3 fallback rendition is the conventional answer;
  the per-stream transcode path this plan otherwise retires could serve exactly that, which is an
  argument for not deleting it outright.

**Recommendation: stay on Ogg-Opus.** The server contract is already correct, the files already
play, and the one-tag-path collapse is worth more than two defects we have not hit. Record WebM as a
documented escape hatch rather than a decision deferred.

The other containers are out on their own merits: Chromium has never supported CAF (its `kContainerCAF`
constant is metrics-only, which is a trap for anyone grepping), and MP4-Opus requires `+faststart`
and Safari has never played it. Electron is not a constraint — Opus can never be stripped by the
proprietary-codec switch, and Chromium demuxes Opus from Ogg, WebM, Matroska and MP4 in both
brandings.

## Simplifications that follow

### One tag path instead of three

`writeAudioTags` (`audio-tags.ts:408-436`) branches three ways today: `.mp3` through `node-id3`,
then a read-back verification, then — when the in-place write did not stick — a full container
rewrite through ffmpeg, then a *second* `node-id3` write to restore lyrics that ffmpeg turned from
`USLT` into `TXXX`; `.flac/.ogg/.opus` through ffmpeg Vorbis comments; `.m4a` through ffmpeg, where
the mov muxer silently drops keys.

With one container it becomes `writeFfmpegTags`. That deletes `writeId3Tags`, the read-back repair
loop, `ID3_VERIFIABLE_FIELDS`, the lyrics restoration workaround, `getNodeId3`, the `node-id3`
dependency and its hand-written declaration at `packages/api/src/types/node-id3.d.ts`. The read
path collapses the same way. `ID3_EXTS` becomes empty and `audio-extensions.ts` keeps one
tag-container set instead of two.

### Issues this closes

| Issue | Why |
|---|---|
| **#723** loudness normalization | Done by construction, on every surface, with no client gain path and no per-stream transcode. Note the client-side option that issue proposes is independently ruled out: `player.component.ts:551-554` records that routing the audio element through a `MediaElementAudioSourceNode` **silenced playback entirely on Android**, with an explicit "do not reintroduce", corroborated at `now-playing-vfx.component.ts:8-13` |
| **#964** one mp3 refuses a tag write | The issue names a malformed ID3 structure as the likely cause. A re-encode replaces the file with clean Vorbis comments |
| **#1177** no BPM on `.m4a` | ~~The mov muxer is never invoked again; its pinned test branch gets deleted rather than inverted~~ **Fixed directly instead, not by avoidance.** Once the operator chooses the library's format (#1256), "the mov muxer is never invoked again" stopped being true — an `.m4a` target invokes it on every file. `BPM_METADATA_KEY` maps the key to `tmpo` for that container; the pinned branch was deleted as planned |

### Measured defects this clears

- **248 mixed-format albums** go to zero, and `formatCohesion.mixedFormatAlbums`
  (`library-health.ts:500-506`) becomes structurally unreachable and can be retired.
- `lowBitrateAlbums` stops conflating a bad source with a bad container. Afterwards a low bitrate
  means a genuinely poor source, which is a re-hunt signal.

### Runtime

Per-stream transcoding stops being needed for *format* reasons. `transcodeEnabled` is already
`false` by default and can stay off for ordinary playback. It should **not** be deleted, though:
the iOS floor above means an AAC fallback rendition is the likely answer for pre-18.4 clients, and
this path is exactly what would serve it. e2e fixtures collapse to one format.

## What this does not fix

- **19 low-bitrate albums** are low-bitrate because the source is 32–94 kbps. Re-encoding adds
  nothing back; they stay re-hunt candidates.
- **The 3 remaining lossless files** would take real first-generation loss. Exclude them, or decide
  knowingly.
- Disk pressure is relieved, not solved. kpc's Docker root filled to zero once (#1021).

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| 2,436 lyric rows, embeddings, descriptors and open curation flags orphaned by the id re-mint | **Highest** | Exact `(oldId, newId)` map; schema-derived coverage gate; no heuristic matching |
| Analysis tags silently lost converting from ID3 | **Highest** | Explicit read-then-write of tags; a tag-preservation test the pass has never had |
| Per-track embedded artwork discarded by `-vn` | High | Write `METADATA_BLOCK_PICTURE`; do not rely on the bare-folder fallback |
| Irreversible generation loss on 13,864 lossy files | High | Source-adaptive bitrate; pilot batch; quarantine instead of `rmSync` early on; an explicit owner decision |
| A verification that fails open deletes an unrecoverable original | High | Fail closed on null probes; verify samples, channels, rate and measured loudness |
| Energy and radio descriptors flattened by normalization | High → **dissolved** | Normalize via the Opus header gain, which leaves the audio untouched. Only returns if the spike fails and `loudnorm` is used |
| Re-encoding the 7,774 files that are already Opus | High | Exclude already-Opus from the encode predicate; they need a header gain, not a generation |
| An all-Ogg library is silent on iOS below 18.4 | High | Verify on device before converting; keep the per-stream transcode path for an AAC fallback rather than retiring it |
| Song lost when the pre-scan delete commits and the scan then throws | Medium | Move the delete inside the transaction, or insert before deleting |
| Disk exhaustion or a day-and-a-half run | Medium | Pool the encodes, batch with headroom checks, make the pass resumable |

## Sequencing

One PR per piece of work, since PR granularity is deploy granularity.

The order matters: the cheapest, most reversible win ships first, and nothing irreversible happens
until the safety work is in.

0. ~~**Measure.**~~ Done.
1. **Spike, on a real iOS device.** *Still open, and now the only thing blocking the rest.* Two
   questions in one sitting: does `output_gain` take effect on our surfaces, and do the 7,774
   Ogg-Opus files already in the library play, seek and report duration correctly on iOS 18.4+.
   Together these decide the normalization mechanism and the container.
2. **Normalize the 7,774 existing Opus files.** BUILT (#1243 the header-gain primitive, #1245 the
   pass), and deliberately **off** behind `NICOTIND_OPUS_HEADER_GAIN` until step 1 answers. Nothing
   else waits on it: it is lossless, reversible, needs none of the conversion machinery, and closes
   #723 for a third of the library. All 7,774 files have a loudness reading, so none would be
   skipped.
3. ~~**Song-id remap infrastructure.**~~ Shipped: #1221 the shared carry, #1224 the coverage gate
   reading the live schema, #1227 the delete-before-scan song-loss fix.
4. ~~**Tag and artwork preservation.**~~ Shipped: #1225 the three dropped ID3 frames, #1229 the
   harness and the 512 KB reader cap, #1230 art at encode time plus the mis-named MusicBrainz and
   AcoustID keys, #1233 re-embedding into files that already lost it.
5. ~~**Verification hardening.**~~ Shipped: #1227 fails closed before the delete, #1228 quarantine,
   #1235 and #1236 wiring that quarantine into the callers that had silently bypassed it, #1232
   pooled encodes, #1239 a durable run record.
6. ~~**Source-adaptive bitrate selection.**~~ Shipped: #1242 `opusBitrateFor`, pure and
   table-driven. It shipped **inert** — the pass took only lossless files, which all get the top
   rate — and #1244 made it live.
7. **The conversion pass.** BUILT: #1244 `scope: 'all'` takes every non-Opus file, asked for by
   name (`?scope=all`, `--all`) so a bare click stays on the safe half. **Not run.** The remaining
   sequence is the owner's: dry run, pilot batch, then the rest.
8. **The simplification sweep** — delete the ID3 path, `node-id3` and the mixed-format rule. Close
   #964 and #1177. Not started; strictly after step 7.

Steps 3 to 5 were each worth landing even if the conversion is abandoned, and they landed: they
harden a pass that already runs today on every lossless download. Step 2 remains the same kind of
bet — a complete answer to #723 for a third of the library, with no conversion machinery involved.

## Open decisions

Every one of these is a closed choice with a recommendation and the measurement behind it. None
needs research to answer. Nothing below step 5 of the sequencing proceeds until they are settled,
because the pass they configure cannot be undone.

| # | Decision | Options | Recommended | Why |
| --- | --- | --- | --- | --- |
| 1 | A second lossy generation on 13,864 files? | convert / leave as-is | **convert** | Saves 36.4 GiB and collapses the format-specific code. It is the irreversible one, and the only reason to hesitate. Quarantine now makes it recoverable for as long as the run dir is kept. |
| 2 | Normalization target | −14 LUFS / −18 / −23 / leave alone | **−14** | The library's median is −10.1, louder than the −14 streaming convention; −23 would make everything dramatically quieter. Header gain makes this re-tunable later, so it is a cheap decision. |
| 3 | Bitrate mapping | 64 / 96 / 112 / 128 as proposed, or different | **as proposed** | mp3 bitrate is bimodal: 8,138 files at 128–159 kbps and 4,383 at 256+. A source-adaptive table reads that rather than guessing one number. |
| 4 | Container | Ogg / WebM | **Ogg** | Keeps the one-tag-path collapse. WebM trades that for immunity to two browser defects we have not hit, and stays available later as a lossless remux. |
| 5 | The 3 FLAC files | convert / keep as masters | **keep** | They are the only true masters in the library, and 3 files is not a uniformity problem worth first-generation loss. |
| 6 | The 6 `.wma` files | convert / delete / leave | **convert** | `.wma` is in neither `ID3_EXTS` nor `VORBIS_EXTS`, so no current path can tag them at all. Converting is a strict improvement; worth confirming they are wanted at all first. |

~~Originals replaced, or quarantined until verified?~~ **Settled: back up before transcoding.** The
quarantine ships and, since #1235 and #1236, is actually reachable from every caller.

**Decision 1 is the only one that cannot be revisited.** 2 is re-tunable by design, 3 applies only
to files not yet converted, 4 leaves WebM available as a lossless remux, and 5 and 6 concern nine
files between them.

**The iOS device check is not a decision and cannot be answered from here.** On an iOS 18.4+ device:
play a known-quiet track, change its Opus header gain, confirm the level moves, and confirm seeking
and duration still behave. It gates decisions 2 and 4 and step 2 of the sequencing, which is the
shippable third-of-the-library win.
