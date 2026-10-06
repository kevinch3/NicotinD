# Related artists

The artist page ends with a row of **library artists related to this one**, nearest first
(`RelatedArtistsComponent`, fed by `GET /api/library/artists/:id/related`). It exists because
nothing else on the page leads to *another* artist. Issue #1484.

## Shape: sources, then one ranking

Related artists is split into **sources** and **one orchestrator**, so a second kind of
evidence can be added without the route or the client changing shape:

- A **source** answers "which artists relate to this one, and how strongly, by my measure",
  and knows nothing about the others. Today there is one, **audio** (`artist-centroids.ts`,
  `audioNeighbours`).
- **`related-artists.ts`** gathers every source's candidates, merges them by artist id into
  `RelatedSignals` (one optional key per source), filters visibility **once** for all sources,
  and hands the merged list to `rankRelated`, the single place that decides what survives
  and in what order.
- The response carries each pick's `signals`, so a tile can later say *why* ("sounds alike",
  "shares listeners").

`reason: 'no-signal'` means no source knows the artist. It is not called "unanalysed",
because once a second source exists an artist with no audio may still have data.

### Planned second source: cultural relations (#1486)

Audio finds artists that *sound* alike; it can't see shared listeners, a scene or shared
members. **ListenBrainz** similar-artists (listener-session co-occurrence) and
**MusicBrainz** artist relationships (member-of, collaboration) fill that in. Both are
MBID-native, and 74% of prod artists have an MBID. They are meant to be fetched
**asynchronously and stored**, at provisioning or metadata time, never on a request. To plug
in, a source adds a key to `RelatedSignals` and a gather step, and `rankRelated` blends it.
Related artists that are **not in the library** will arrive as a separate, additive
`discoveries` list, so a library tile's `id` stays non-null.

## The audio source: artist centroids

`computeArtistCentroids` makes the same single fold as `computeGenreCentroids`
([genre-affinity.md](genre-affinity.md)), keyed by artist instead of genre. Each analysed
track's L2-normalised embedding is added to the centroid of every **primary** artist it
credits (`library_song_artists.role = 'primary'`). A featured guest is not credited, because
a guest verse must not pull the guest toward the host's sound. The norm of the mean is the
members' mean cosine to their centroid (`coherence`), so it costs nothing extra.

- **Same eligibility and content check as genre centroids:** hidden songs and albums are
  out (`feedEligibilitySql` tier 2), a vector of a file replaced since analysis is out
  (`file_size IS s.size`), and only the dominant model is used.
- **`library_artist_centroids`** is fully derived and rebuilt from scratch in one transaction
  by `maybeRunDailyArtistCentroids`, on the processing tick right after the genre rebuild.
  It has no orphan marker and no carry: a merged or renamed artist simply drops out at the
  next build.
- **Read path:** an in-memory index holds one contiguous matrix of every centroid at or above
  `MIN_ARTIST_MEMBERS`. It reloads when the table's build stamp (`MAX(computed_at)`, row
  count) moves, so a request is one dot product per artist with no BLOB reads.
- **Visibility is filtered at read time:** hidden, `split_compound` and `fragment_of` artist
  rows are dropped per request, so a curator's hide takes effect on the next page load, not
  the next rebuild.

## Measured on prod (2026-10-06)

Read-only, in the prod container, against the live DB:

| | value |
|---|---|
| songs / embedded (one model) | 21,790 / 18,984 |
| eligible primary credits folded | 12,930 |
| artists with ≥ 1 / 2 / 3 / 5 / 10 analysed tracks | 2,332 / 807 / **511** / 357 / 286 |
| index at the floor of 3 | 2.6 MB, ~4 ms per full scan |
| 1st-neighbour cosine p1 / p10 / p50 | 0.80 / 0.86 / 0.92 |
| 12th-neighbour cosine p5 / p50 | 0.73 / 0.85 |

The neighbours read right on inspection. Pink Floyd → Spinetta, Queen, Serú Girán, Bowie,
Charly García. El Polaco → Ke Personajes, La T y La M (cumbia). Edgardo Donato → D'Arienzo,
Lomuto, Canaro (tango). Röyksopp → WhoMadeWho, The Chemical Brothers, Moderat.

- **`MIN_ARTIST_MEMBERS = 3`.** Below that a centroid is one or two songs, not an artist.
- **`MIN_RELATED_COSINE = 0.75`** is an absolute floor, set just above the 12th neighbour's
  p5. Effnet space shares a large common component, so cosines run high and an absolute floor
  separates little; the ranking can be relative (see below).
- **Coverage is capped by #1485, not by the floor.** 43% of songs carry a stale or missing
  embedding and are never re-queued (most of them from the Opus conversion), so many artists
  have fewer analysed tracks than they own.

## Ranking

`rankRelated(candidates, limit)` receives the visible candidates. They come in source order:
audio by cosine, highest first, with the seed already excluded. Each candidate carries
`signals.audio = { cosine, members, coherence }`. Every rule must keep the contract in
`related-artists.test.ts`: at most `limit` picks, drawn from the candidates, no duplicates,
scores non-increasing, and nothing returned when nothing is close.
