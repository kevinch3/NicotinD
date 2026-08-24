# Music licence / rights per track — ROLLED BACK (issue #683, 2026-08-24)

**This feature no longer exists.** A track's rights/licence code used to be
displayed, curator-editable, filterable, tag-mirrored and background-filled; all of
that is removed. This page is kept as the record of what was built and why it was
undone, because the reasoning generalises to the next optional-metadata idea.

## Why it was removed

It failed on its own stated goal — *"efficiently retrieve, reasonable accuracy"* —
in two measured steps, not one:

1. **Issue #329** already cut the MusicBrainz `license` url-relation lookup after a
   read-only prod sweep found it had succeeded **0 times across 14.5k songs** while
   spending the shared 1-req/sec MusicBrainz budget on three attempts per new
   download. The tag-only step was left in place because it was believed to be
   "producing all the data".
2. **This issue.** A hand-reviewed curation sample of ~46 recently-landed tracks
   found the tag-only remainder is *also* essentially not yielding: every sampled
   track still read `licence: null`. With both automatic paths at ~zero, what was
   left was a UI row, a filter, an enrichment task and a scanner column that a
   human would have had to populate entirely by hand.

The lesson worth keeping: **#329 deescalated the half that was measurably dead and
kept the half that was assumed alive.** The assumption was never measured. When an
optional-source feature underdelivers, measure *every* path before deciding which
one to keep.

## What was removed

- The `licence` enrichment task, its `lookupLicence` context primitive, and
  `scripts/backfill-licence.ts`.
- `GET /api/library/songs/:id/licence-suggestion` and
  `POST /api/library/songs/:id/licence`, plus the `set_song_licence` MCP tool and
  `licence` in `get_album_tracks`'s response.
- `@nicotind/core` `types/licence.ts` in full — the vocabulary, labels, badges,
  guards and `normalizeLicence` — and the `LicenceSuggestion` DTO.
- Scanner threading: `licenceFromTags`, the `ScannedTrack → SongRow → persist`
  column, and the `unanimousLicence` album aggregate. The scanner no longer reads
  or writes `LICENSE`/`WCOP`/`TCOP` frames.
- `MusicBrainzClient.getLicence`.
- `LibraryFilter.licences`, `licenceWheres`, and their use in the song / album /
  artist filter SQL.
- Web: the track-info sheet's Licence row (value, Detect, curator `<select>`), the
  filter panel's Licence chip group, the album-header Public-Domain badge, and the
  Admin → Library processing task toggle.

## What was deliberately kept

- **The DB columns.** `library_songs.licence`, `library_songs.licence_source` and
  `library_albums.licence` are still there and still hold whatever was written
  before. CLAUDE.md's schema rule is additive-only with no down-migration path, so
  they are orphaned rather than dropped — and any value a curator did set is
  preserved, should the feature ever be revived.
- **`'licence'` in `LIBRARY_FILTER_PARAM_KEYS`.** That list is what *clears* filter
  params from the URL, so keeping the key lets a bookmarked `?licence=…` still be
  cleared instead of sticking forever. `parseLibraryFilter` ignores the value.

## Related

- Issue #329 — the earlier partial deescalation this extends.
- Issue #683 — the rollback decision (curator review, 2026-08-24).
