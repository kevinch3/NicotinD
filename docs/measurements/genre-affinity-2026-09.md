# Genre affinity — prod calibration (#1119)

Companion to [../genre-affinity.md](../genre-affinity.md). #1118 shipped the
learned genre axis with **four priors chosen without seeing this library's
numbers**. This file is the measurement that replaced them, and the A/B that
decides whether the axis becomes the default.

## Status

Run **2026-09-12** against the prod deploy host (`kpc`), inside
`nicotind-nicotind-1`, on the live `library_genre_centroids` table as the daily
sweep last rebuilt it (`genre_centroids_last_day = 2026-09-12`, written
15:36 UTC). **Nothing was written**: because the sweep had already run that day,
`--refresh` was unnecessary, so the whole pass used the read-only openings only
(`docs/prod-inspection.md` "The rule").

- model: `discogs-effnet-bs64-1`, the only one present (18,179 live embeddings)
- centroids: **648** genre names, **368 usable** at `MIN_MEMBERS` ≥ 5
- pairwise cosines compared: **67,528**

The A/B ran the real `dump-radio.ts` three ways per seed — axis off, axis on
with #1118's priors, axis on with the calibrated constants — the third from a
throwaway copy of `/app` under `/tmp`, so the running deploy was never modified.

## Verdicts

| Prior (as #1118 shipped it)                                  | Verdict                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `COS_FLOOR` 0.6, "set it near the all-pairs p10"              | **Wrong, and the guidance was wrong too** — see below. Now **0.75**      |
| `COHERENCE_LOW` 0.55                                          | **Outside the data** — the lowest coherence on prod is 0.658, so the discount floor was unreachable. Now **0.70** |
| `COHERENCE_HIGH` 0.9                                          | **Too high** — p90 is 0.886, so the leaf styles the axis exists to separate never reached full credit. Now **0.81** |
| `BREADTH_DISCOUNT` 0.5                                        | **Confirmed** — at the calibrated band an umbrella exact match scores 0.500 against a named neighbour's 0.872 |
| `MIN_MEMBERS` 5                                               | **Confirmed** — the 59 tags at 3–4 members do not behave (below)         |

## Results

### 1. The cosine distribution, and why "near p10" was the wrong rule

```
pairwise cosine over 67528 pairs
  p1 0.327  p5 0.394  p10 0.439  p25 0.524  p50 0.634  p75 0.745  p90 0.837  p95 0.883  p99 0.943
  min 0.235  max 1.000
nearest-neighbour cosine, per genre (368 values)
  min 0.796  p5 0.890  p10 0.909  p25 0.939  p50 0.963  p75 0.980  p90 0.992
```

The two rows answer different questions, and #1118's guidance used the wrong
one. The all-pairs distribution says **which pairs are far** — most of the
vocabulary is Tango against Techno, so its p10 (0.439) is a statement about
strangers. The axis needs the opposite: **which pairs are close**. No genre's
nearest neighbour is below 0.796, so every pair under ~0.8 is *nobody's*
neighbour — and a floor at 0.439 hands those pairs half credit, which is
precisely the drift the feature exists to stop.

`COS_FLOOR` is therefore anchored to the bottom of the **nearest-neighbour**
distribution: **0.75**, just under the weakest link (0.796). Raising the floor
also widens the affine rescale (`1 − FLOOR` shrinks), so discrimination among
the pairs that survive goes *up*:

| floor | good-vs-drift gap, Tech House seed | genres with no neighbour ≥ 0.2 |
| ----- | ----------------------------------- | ------------------------------ |
| 0.60 (shipped) | 0.235 | 0 / 368 |
| 0.70 | 0.353 | 0 / 368 |
| **0.75** | **0.426** | **2 / 368** (Euro Disco, Hardcore) |
| 0.80 | 0.531 | 5 / 368 |
| 0.85 | — | 19 / 368 |

("good" = Deep House, Techno, Minimal Techno, Melodic Techno, Deep Tech, Afro
House; "drift" = Edm, Big Room House, Electro House, Future House, Festival
Progressive House, Dutch House, Brostep, Complextro, Future Rave. Both means at
the calibrated coherence band.) 0.80 buys a wider gap for 2.5× the strandings;
0.75 is the last floor that still clears essentially every genre's best link.

### 2. The coherence ranking — the umbrella signal is real and clean

Over the 368 usable centroids: min 0.658, p10 0.708, p25 0.743, p50 0.793,
p75 0.843, p90 0.886, max 0.953.

| bottom (umbrella-like) | coh | | top (leaf-like) | coh |
| --- | --- | --- | --- | --- |
| Soul (250) | 0.658 | | Hardcore (6) | 0.953 |
| R&B (173) | 0.663 | | Opera (49) | 0.926 |
| **Latin (2005)** | 0.665 | | Saeta (12) | 0.922 |
| **Pop (2476)** | 0.672 | | Big Room House (7) | 0.914 |
| **Rock (2165)** / **World (169)** | 0.682 | | Festival Progressive House (23) | 0.906 |
| **Electronic (1063)** | 0.693 | | Deep Tech (14) | 0.905 |

Every umbrella #1119 named lands **below 0.70**, and the styles the axis exists
to separate land at or above 0.81 (Tech House 0.809, Minimal Techno 0.812, Deep
House 0.817). That is the band: `COHERENCE_LOW` 0.70, `COHERENCE_HIGH` 0.81.
The shipped 0.55/0.9 was outside the data at both ends — nothing could reach the
discount floor, and everything past p90 saturated at full credit.

Note the ranking is a *breadth* measure, not a quality one: "Soul" and "R&B"
score as umbrellas here because this library's soul tag spans six decades, and
the one-album junk buckets (`_ Columbia`, `@playlist easy`) score as perfectly
coherent leaves. Coherence answers "do the tracks wearing this tag sound alike",
nothing more.

### 3. The four pinned pairs (seed: Tech House)

| pair | cosine | credit (prior → tuned) | affinity prior | affinity tuned |
| --- | --- | --- | --- | --- |
| Tech House ↔ Minimal Techno | 0.969 | 0.870 → 0.995 | 0.803 | **0.872** |
| Tech House ↔ Big Room House | 0.851 | 0.870 → 0.995 | 0.545 | **0.402** |
| Tech House ↔ Electronic | 0.930 | 0.704 → 0.500 | 0.581 | **0.360** |
| Tech House ↔ Tango | 0.474 | 0.798 → 0.764 | 0.000 | **0.000** |

Two departures from the issue's predicted ordering, both real:

- **"Big Room" is not a tag in this library** — `--pair "Tech House" "Big Room"`
  returns the lexical fallback. The tag that carries festival EDM here is **Big
  Room House** (7 members).
- **Big Room House edges above Electronic** (0.402 vs 0.360), where the issue
  predicted `Electronic > Big Room`. The measurement is not wrong: big-room
  tracks in *this* library genuinely sit 0.851 from tech house, while Electronic
  is penalised for being a catch-all. What matters is that both collapse to
  ~0.4 against a real neighbour's 0.872 — a **2.2× separation**, where the
  priors gave 1.5×. The regression test pins that ratio, not the issue's guess.

### 4. `MIN_MEMBERS` stays 5

280 of 648 centroids sit under 5 members; 59 of them at 3–4. Those 59 include
plenty of real scenes (Thrash Metal, Bossa Nova, Norteño, Vallenato, Microhouse,
Tech Trance, Smooth Jazz), which is the condition #1119 set for lowering the
bar — but admitting them makes the axis worse, because a 3-track mean is noise
and it would *replace* a lexical rule that gets several of them right:

```
Celtic(4)            → Melodic House 0.65 | Funky House 0.50 | Progressive House 0.49
Crossover Thrash(4)  → Neo Soul 0.45 | Female Vocals 0.33
Surf(4)              → Ska Argentin 0.24 | Funk 0.22 | Wassoulou 0.22
Anarcho-Punk(4)      → New Wave 0.14 | Shoegaze 0.14 | Post-Punk 0.13
Thrash Metal(4)      → Metal 0.28 | Heavy Metal 0.27        (lexical already shares "Metal")
```

A handful do land correctly (Neoperreo→Reggaeton 0.78, Spiritual Jazz→Hard Bop
0.81, Latin House→Tech House 0.75), but not at a rate that beats the fallback.

## The A/B — `dump-radio.ts`, 15 tracks, three seeds

### Tech house — seed: Kaskade — I Remember (`09dc746e`)

The seed carries **22 tags**, `Pop` among them. That is the whole failure:

```
axis off      mean embedding cosine 0.604   15/15 "share a seed genre"
 1. Cirez D — Teaser                        genre 1.00
 2. Katy Perry — WOMAN'S WORLD              genre 1.00   ← genres: Pop
 3. The Weeknd — São Paulo                  genre 1.00
 5. Black Eyed Peas — GUARANTEE             genre 1.00
13. Kiesza — Hideaway                       genre 1.00
14. Gwen Stefani — Orange County Girl       genre 1.00
15. Black Eyed Peas — Mare                  genre 1.00
```

Every one of the 15 scores **exactly 1.00** on the genre axis, so the axis
orders nothing at all — five mainstream-pop tracks ride a shared `Pop` tag into
a tech-house radio.

```
axis on, priors   mean embedding cosine 0.666   15 distinct artists
  Black Eyed Peas — AUDIOS (0.87) · Enrico Sangiuliano ×2 (0.84) · Solomun (0.88)
  Echonomist (0.97) · Peggy Gou (0.77) · Sergio Mendes remix (0.87) · Disclosure — Latch (0.97)
  Daft Punk (0.88) · Bob Sinclar (0.85) · SOFI TUKKER (0.88) · Madonna (0.85)
  WhoMadeWho (0.75) · Moxy Edits (0.87) · Gorgon City (0.88)

axis on, tuned    mean embedding cosine 0.706
  Enrico Sangiuliano — Igloo (0.91) · CamelPhat (1.00) · Eelke Kleijn ×2 (1.00)
  Ramon Bedoya (0.99) · Eli & Fur (1.00) · bbno$ — two (1.00) · Layton Giordani (0.91)
  Jhayco 5hours remix (0.99) · Sultan + Shepard (0.86) · Armand Van Helden (1.00)
  Green Velvet (0.91) · Massano (1.00) · Charlotte de Witte (0.91) · Anyma (1.00)
```

Zero overlap with the off run. The priors already remove the worst of it but
still seat Black Eyed Peas at #1 and keep Madonna and a Sergio Mendes remix; the
calibrated axis returns a list that is house and techno acts end to end, and
posts the **highest mean embedding cosine of the three** (0.706 vs 0.604) —
i.e. the tracks are more alike as *audio* too, which the genre axis never saw.

### Control 1 — pop — seed: Beyoncé — Love On Top (`706763fd`)

```
axis off    cosine 0.553 · Jennifer Lopez, Bruno Mars, Coolio, deadmau5, Olivia Rodrigo,
                            Rihanna, Taylor Swift ×2, Katy Perry, Notorious B.I.G. …  (all genre 1.00)
axis on, tuned  cosine 0.586 · Whitney Houston, Christina Aguilera, Miami Sound Machine,
                            Backstreet Boys, Taylor Swift, Maroon 5, Madonna, Dr. Dre, Lady Gaga …
```

**1 of 15 titles survives** — the list reshuffles hard. It does **not** leave the
genre: all 15 are pop / R&B / hip hop, and the served window stays 14/15 sharing
a seed genre. This is the expected behaviour on a 26-tag seed whose genre
identity is mush: with the axis off every candidate ties at 1.00 and the order
is decided entirely by the other axes, so *any* ordering signal reshuffles it.
Recorded as a real movement, not dismissed as noise.

### Control 2 — folclore — seed: Los Nocheros, Los Tekis — Vuela una Lágrima (`92a6c949`)

```
axis off        cosine 0.745 · 15/15 share a seed genre · 11 distinct artists
axis on, tuned  cosine 0.732 · 15/15 share a seed genre · 11 distinct artists
```

**8 of 15 titles are identical** and the rest are the same artists' catalogue
(Los Tucu Tucu, Los Chalchaleros, Destino San Javier, Facundo Toro). What the
axis drops is the two Onda Vaga indie-folk entries the lexical rule admitted at
1.00. Barely moves, and moves in the right direction.

## v9 go/no-go

**GO.** The condition #1119 set was "the tech-house seed loses its EDM/Big Room
drift and the two control seeds barely move". The first is unambiguous (zero
overlap, five pop tracks gone, mean audio cosine up 0.10); folclore barely moves;
pop reshuffles but never leaves pop, for a reason the dump itself explains (a
26-tag seed ties every candidate at 1.00 with the axis off). Follow-up #1121
bumps `RADIO_FORMULA_VERSION` to 9, wires the polls and `/songs/:id/similar`,
and turns the toggle into an opt-out.

## Reproducing

Every command in #1119, run inside `nicotind-nicotind-1` with
`-w /app` and `NICOTIND_DATA_DIR=/data/nicotind`. `--refresh` is only needed
when `library_sync_state.genre_centroids_last_day` is not today's date.
