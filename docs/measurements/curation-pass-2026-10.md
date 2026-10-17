# Curation pass — 2026-10 (umbrella-only genres; the worklist's artist label is not the songs' artist)

Genre-focused pass over `genres.lowInformation` (songs whose only genre is a catch-all such as
`Electronic`). Run against prod over MCP on 2026-10-17 at v0.8.112.

## Library totals (2026-10-17)

4,303 artists · 7,597 albums (7,596 visible) · 22,302 songs.

## Baseline → final

| Metric | Baseline | Final | Delta |
| --- | --- | --- | --- |
| genres.lowInformation | 169 | 134 | −35 |
| genres.missing | 118 | 118 | 0 |
| flags.open | 1 | 1 | 0 |

Every other dimension was unchanged between the two reads. `lowInformation` was re-read from
`get_library_health` after each batch; the 35 matches the 30 + 5 songs written below.

## Actions

| Scope | Songs | Genre | Evidence |
| --- | --- | --- | --- |
| Green Velvet — *Factory Town Miami 2026: La La Land (DJ Mix)* | 30 | `Electronic` → `Tech House` | Track list: Cajmere/Percolator, Street Slang, CASSIMM, Green Velvet's own tracks. Read back: 30/30. |
| Mha Iri — *Hold On*, *Post Punk*, *Elements of Dance*, *Neon Storm*, *No Return* | 5 | `Electronic` → `Techno` | Press describes the artist as a peak-time/hard techno act. |

All writes were `mode: replace`; the worklist only lists songs whose catch-all is their only
genre, so no other genre was dropped.

## Left untagged (search inconclusive, per the skill's rule)

- **Dekel — *Ancient Future*** (8 songs): the search found no such release. Collaborators
  (Out of Orbit, Freedom Fighters) suggest psychedelic dance music, but that is inference.
- **Ibu Selva — *Ngo-bo Sontg-pa*** (4 Electronic-only songs): nothing found. A lone sibling
  (*Milonga*, `Organic House`) does not propagate.
- **Latin club remixes in *01 - Pop Aguante*** (KAROL G ×2, Bandana, Beéle): the titles say
  "Club Mix", which is not a self-declared genre; no source for the specific remixes.

## Finding: a worklist row's artist name is not the artist of its songs

`lowInformationWorklist` is grouped by album-artist id but labelled with a song artist. The row
`Abraham (ES) & S.Hai` (30 songs) resolved to Green Velvet's DJ-mix album, whose 30 tracks have
30 different artists; `Carolina de Jesus` (4) resolved to Ibu Selva and `Boiler Room` (2) to
Matías Aguayo. Applying one genre per row *label* would have mis-tagged them. Read the album
(`get_album_tracks`) before writing.

## Open

- Flag 28 (listener `quality` report) has no question/options, so it is `servable:false`.
