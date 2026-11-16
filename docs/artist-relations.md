# Cultural artist relations (#1486)

Audio similarity (the embeddings behind radio and "Related artists") knows that two artists sound
alike. It cannot know that they share listeners, a scene or members. This is the non-audio signal:
who listeners of an artist also listen to, from ListenBrainz, stored locally.

## What is built

- **Storage.** `library_artist_relations (source_mbid, target_mbid, target_name, kind, score,
  raw_score, source, fetched_at)`, keyed by MusicBrainz id on both sides. A relation may point at an
  artist the library does not hold; it resolves to a library artist at read time, when one exists.
  `library_artist_relation_fetches` records every artist asked, including an empty answer, so the
  long tail a source knows nothing about is not asked again every window.
- **The score is relative.** ListenBrainz scores are unbounded co-occurrence counts whose top value
  runs from 19 to 2,710 across artists (measured on prod, 2026-11-09). `score` is the raw score
  over that artist's best one, so every artist's strongest relation is 1. `raw_score` keeps what
  the source said. Relations under `RELATION_MIN_SCORE` (0.05) are stored and not offered.
- **Fetching is a background task, never a page request.** The `artist-relations` enrichment task
  asks `ListenBrainzClient.getSimilarArtists` once per artist MBID, biggest artists first, through
  the client's 1 request per second limiter, and asks again after `RELATION_TTL_MS` (90 days). A
  failed request records nothing and is retried; an empty answer is an answer.
  **It is off by default** (`DEFAULT_PROCESSING_SETTINGS`): a first pass is about 3,000 outbound
  requests, so the owner turns it on in Admin → Library processing.
- **Identity.** `artistMbidIndex` joins library artists to `library_mbids` through the normalized
  name, which is how that table is keyed, and never hands out a curator's tombstone.
- **First consumer: Related artists.** `relatedArtists` ranks by audio exactly as before, then
  fills the places audio left empty with owned artists that share listeners, best first. The two
  scales (a cosine, a share of listeners) are **not mixed into one ranking**: nothing has
  calibrated one against the other. An artist both sources know keeps its audio place. An artist
  with too few analysed tracks for audio, the case this exists for, now gets a row instead of
  `no-signal`. Each tile's `signals` says which source backed it.

## Discovery: related artists the library does not have

`GET /api/library/artists/:id/related` also returns `notOwned`: the strongest related artists with
no library row (`notOwnedRelated`, at most `NOT_OWNED_LIMIT` = 8, `{ mbid, name, score }`). The field
is absent when there are none. Only listener data can name them, so an artist the source was never
asked about has none.

The artist page lists them under **Not in your library** (`RelatedArtistsComponent`, `notOwned`
input, `find` output). Picking one opens Get → Add with the name prefilled in the omnibox, the same
hand-over Library Find uses (#1663); nothing is searched or fetched until the user presses Enter.
The sample of 2026-11-09 had about 55 not-owned related artists per answered artist, so the cap is
what keeps this a short row.

## Stated relationships (MusicBrainz)

Similarity says two artists share listeners. A relationship is a fact MusicBrainz records: this
person is a member of that band.

- **Fetched** by the same opt-in `artist-relations` task, one `artist?inc=artist-rels` request per
  artist MBID on the shared, rate-limited MusicBrainz client (`getArtistRelationships`). It runs in
  what is left of a run's limit after the ListenBrainz requests, and has its own row in
  `library_artist_relation_fetches` (`source = 'musicbrainz'`), so one source failing does not make
  the other ask again. The task's pending count is requests still to make across both sources.
- **Kept kinds** (`MB_RELATIONSHIP_KINDS`): `member` (member of band, founder, subgroup), `collab`
  (collaboration), `support` (supporting musician), `alias` (a person and their performance
  name). Everything else MusicBrainz lists (tribute, family, teacher) is dropped.
- **Stored** in `library_artist_relations` with that `kind` and `source = 'musicbrainz'`
  (`storeArtistRelationships`). One row, from the side that was asked.
- **Read from either end** (`relationshipNeighbours`): a band finds its members and a member finds
  its band through the same row. Owned artists only; when two kinds link the same pair the stronger
  one is kept (member, alias, collab, support).
- **In Related artists** they take the first places, at most `RELATIONSHIP_SLOTS` (3). They are
  facts, not a score, so they are not ranked against a cosine; the cap keeps a long member list from
  pushing the sound-alikes out. The tile says which kind it is under the name.

## What is not built

- **Radio.** A cultural-affinity axis beside the embedding cosine needs calibration of the kind
  #1119 did for genre affinity, on prod. Until then radio does not read these rows.
- **A dump.** The labs API is the only source used; whether ListenBrainz publishes this dataset for
  offline use is still unanswered.

## Measured before building (prod, 2026-11-09, sample of 100 artists)

64% of sampled artists got an answer; 57% had at least one owned artist in their top 10. The 36%
with no answer are the long tail where neither source helps.
