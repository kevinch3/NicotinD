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

## What is not built

- **Radio.** A cultural-affinity axis beside the embedding cosine needs calibration of the kind
  #1119 did for genre affinity, on prod. Until then radio does not read these rows.
- **MusicBrainz relationships** (member of, collaboration): `kind` has room for them; only
  `similar` from `listenbrainz` is written.
- **Discovery.** `culturalNeighbours` already returns the not-owned related artists (`id: null`),
  about 55 per answered artist in the 2026-11-09 sample. Nothing shows them yet.
- **A dump.** The labs API is the only source used; whether ListenBrainz publishes this dataset for
  offline use is still unanswered.

## Measured before building (prod, 2026-11-09, sample of 100 artists)

64% of sampled artists got an answer; 57% had at least one owned artist in their top 10. The 36%
with no answer are the long tail where neither source helps.
