# Genre radar (issue #222)

A radar/spider chart of how much of an artist's catalogue each genre actually covers, shown on the
genre-correction surface. The chips in that modal say *which* genres are in effect; the radar says
*how much of the artist* each one accounts for — the difference between a stray one-track tag and
their real identity.

## Placement: the curation surface, not the artist page

It lives inside `ArtistGenreModalComponent`, which the issue itself calls the highest-value spot
("the radar as a *review aid* for reclassification proposals is arguably the highest-value
placement"). That choice also **sidesteps the issue's open product question** — "is this a
user-facing identity feature or an admin QA tool?" — by shipping the half that needs no product
decision. Putting it on the artist page for every listener is the part still to settle, along with
"what should the everyday UI do with multiple genres."

## A radar is not the form the data would pick

Stated plainly because it constrains everything below: for "compare magnitude across categories,"
the correct default is a **horizontal bar**. A radar has three known defects, and this
implementation manages rather than fixes them:

1. **Enclosed area grows with the square of the radius**, so the shape overstates differences.
   *Mitigation:* the value table beside it is not an accessibility afterthought — it is where exact
   magnitudes are read. Chart and table always ship together; the e2e asserts that.
2. **The silhouette depends on axis order**, which is arbitrary. *Mitigation:* order is fixed and
   deterministic (count desc, then name asc) so the same artist always draws the same shape.
3. **It degrades badly past ~8 spokes.** *Mitigation:* `MAX_AXES = 8`, everything else folded into
   one "Other" axis, with the caption saying how many were hidden.

Radius is **linear in the value**, not area-corrected. Compensating for defect 1 geometrically
would distort the shape in the other direction; the table is the honest fix.

## The number: share of tracks, not share of a whole

`weight = tracks carrying this genre / tracks in scope`, so a value reads on its own ("86% of their
tracks are Folclore").

**Weights deliberately do not sum to 1.** Multi-genre sets overlap, and normalising to a
part-to-whole would silently under-report every genre on a multi-genre track — precisely the data
this chart exists to show. The caption says so outright ("a track can carry several genres, so
shares add up past 100%") because a reader who assumes a pie will otherwise read it as a bug.

It is **position-blind**: a genre counts the same whether it is the primary or an extra. That
matches `genreSetCloseness` (a position-blind MAX over sets), so the chart reflects how genres
actually behave in radio scoring rather than a weighting the engine doesn't believe. A
position-weighted variant is a real option, but it should follow a decision about scoring, not
precede it.

Quarantined tracks (`landed_at IS NULL`) are excluded — they aren't in the library yet.

## Pieces

| Piece | What it owns |
| --- | --- |
| `services/genre-distribution.ts` (API) | `artistGenreDistribution(db, artistId)` → `{ trackCount, genreCount, slices }`, incl. the `MAX_AXES` "Other" fold |
| `GET /api/library/artists/:id/genre-distribution` | thin route over it; `404` for an unknown artist |
| `lib/radar-geometry.ts` (web) | pure geometry — `radarAxes`, `polygonPoints`, `ringPoints`, `truncateLabel`. DI-free, so the maths is unit-tested without a DOM |
| `components/genre-radar/` | inline SVG + the paired value table |

No charting dependency was added, per the issue. Colour is a single hue (`--theme-accent`) because
there is one series — so no legend is needed (the heading names it) and no categorical palette
exists to validate. Light/dark come free from the theme system's CSS variables.

## Details that were wrong the first time

- **Rings are polygons, not circles.** A circular grid over a polygonal plot implies values exist
  *between* the spokes, and they don't.
- **Labels are truncated to 14 chars** with the full name in a `<title>`. SVG `<text>` neither wraps
  nor clips, and real genre names run long — Discogs' top-level vocab includes
  `Folk, World, & Country`, which overhung the chart box and collided with the table until the
  viewBox was widened (340×250, wider than tall: side labels need horizontal room the spokes don't
  use) and the label shortened. Caught by rendering the chart and looking at it, not by a test.
- **`text-anchor` follows the spoke direction** (`start` on the right half, `end` on the left,
  `middle` near-vertical). Centring every label overhangs the plot on both sides.
- **The value polygon is omitted below 3 axes** — a 2-point "polygon" is a line, not a shape.
- **The `Other` weight is capped at 1.** Its count is a sum over folded genres, which can exceed
  the track count when tracks carry several of them; uncapped, that axis renders outside the ring.

## Tests

`genre-distribution.test.ts` (weighting, extras counted, quarantine exclusion, the fold and its cap),
`radar-geometry.spec.ts` (angles, linear radius, clamping, anchors, truncation),
`genre-radar.component.spec.ts` (table sort doesn't rotate the polygon, hidden count, percent
formatting), and `e2e/tests/genre-radar.spec.ts` for the DOM — the web JIT vitest harness can't drive
Angular signal inputs (same constraint documented in `metric-pill.component.spec.ts`), so rendering
is covered there. That spec **creates its own genre data** via a curator override first; the
fixtures are silent FLACs with no genre tags, so without it the chart hides and every assertion
passes vacuously.

## Still open on #222

The issue's second sub-goal — "settle the multi-genre UX" — is untouched: whether to surface a
weighted multi-genre identity in the everyday UI, how that interacts with the genre filter, the
genre landing chips and the Genres tab, and whether weighting should become position-aware. The
before/after view for a *proposed* reclassification (two radars, or better, a dumbbell) is the
natural next build now that the distribution endpoint exists.
