# Mosaic tiles: tap to centre, then play, and zoom — design

Status: **proposed** (2026-11-16). Not implemented. Mock reviewed and liked by the owner:
<https://claude.ai/artifact/Sj9fHLNHuCoD9bLujQzruS> (private; placeholder music, no fisheye).

## Why

A person browsed the mosaic the way they browse Spotify or Tidal: pan around, tap a cover to see
what it is. The tap started a radio and replaced what they were listening to. Tap-to-play is the
mosaic's founding rule ("one surface, one verb", see [web-ui.md](web-ui.md) "Mosaic home"), and the
only way to look first is hidden: press-and-hold, right-click, or the hover ⋯.

In mainstream players a cover in a grid *opens*, and an explicit ▶ *plays*. Mosaic tiles look like
covers and behave like play buttons. A mistaken tap is also the expensive mistake: it destroys the
queue the listener had.

## Goals

- A tap on a tile never changes the music.
- Starting a radio stays fast and obvious: one more tap, on a large button, in a fixed place.
- The picked tile tells you a little more than its face did, without becoming a page.

## Non-goals

- A detail page or a sheet. The tile stays a tile.
- Changing press-and-hold, right-click or the hover ⋯; they keep opening the same menu.
- The TV build and the classic home view.

## Anti-goals

- Explaining the recommendation. The owner asked for a quick tag, "not so explicit".
- A play button on tiles at rest. Considered and rejected by the owner: no tile carries one until
  it is picked.

## Approaches considered

| Approach | Outcome |
| --- | --- |
| Peek card: tap opens an info card over the field, Play inside it | Superseded: too much explanation, a second surface |
| Split tile: corner ▶ plays, rest of the tile opens a card | Chosen first, then rejected after the mock: ▶ is unhittable on small tiles and clutters every face |
| Play at once, show info and an Undo | Rejected: the music still changes on a browsing tap |
| Keep tap-to-play, add a play glyph and a first-run hint | Rejected: gives no way to look without playing |
| **Tap centres and grows the tile; only the centred tile offers Play** | **Chosen** |

## The design

### Tap

- **Tap a tile:** it glides to the centre (the glide `start()` already does through
  `focusElement`) and grows. Nothing plays. Call this tile *focused*.
- **Tap another tile:** that one becomes the focused tile.
- **Tap empty space, press Escape, or drag past the detent:** the focus lets go; the tile returns
  to its packed size.
- **Tap the focused tile's face again:** nothing. Only its Play button plays. (Builder's call
  made here; revisit if testing shows people double-tap.)

### The focused tile

Same face, larger, lifted over the existing veil (`markHeld` / `.is-held` / `.mosaic-veil` is the
starting point). It gains three controls, and no tile at rest has any of them:

| Control | Where | What |
| --- | --- | --- |
| **Play** | bottom-right, 48 px | Starts exactly what a tap starts today for that tile kind |
| **Tag** | top-left, small pill | Two or three words on where the tile comes from |
| **⋯** | top-right | The tile's existing menu (`tileMenu`), unchanged |

A focused song tile's subtitle reads "Artist · Album".

**Tag text** (i18n keys, `en` base):

| Tile | Tag |
| --- | --- |
| song from recently played | Recent |
| song from keep-the-vibe | Keep the vibe |
| song from taste breakers | Something different |
| playlist | Playlist |
| genre | Top genre |
| vibe | Vibe |

A song tile does not record its lane today (`MosaicTile` has `kind: 'song'` for all three), so
`buildMosaicTiles` gains an optional `lane` on the tile. A tile with no known lane shows no tag.

### First tracks, with Shuffle

A focused **playlist, genre or vibe** tile shows the first three tracks it would play, under the
heading "Starts with", and a **Shuffle** button that draws three others. A song tile shows none.

The list is a promise: Play starts with the first track shown.

| Kind | Where the three come from | Shuffle | Play |
| --- | --- | --- | --- |
| genre, vibe | `getFilterRadio(filter, [], 20)`, fetched when the tile is focused (today it is fetched at the tap) | fetch again | `startRadioWithFilter` with the list already fetched |
| playlist | `getPlaylist(id)`, first three | reorder so three others lead | `startRadioWithTracks` in the order shown |

If the fetch returns nothing, the list's place says "No tracks match that vibe yet" and Play is
disabled, replacing today's toast after the fact.

### Zoom

Added by the owner after the mock (2026-11-16): the field zooms in and out, and text sizes stay
within fixed limits while it does.

- **Input:** mouse wheel over the stage, and a two-finger pinch. The stage has no wheel handler
  today, so the wheel is free; one-finger drag keeps panning.
- **Range:** 60% to 220% in the mock. Zoom multiplies every tile's on-screen size around the
  stage centre; it does not change the packing.
- **Text holds its size.** A title is sized in on-screen pixels and never leaves **10–17 px**,
  whatever the zoom. The subtitle follows at its usual ratio.
- **A tile too small for readable text drops it** rather than shrinking it: under 60 px on screen
  the subtitle goes, under 44 px the title goes and the tile is cover only (a vibe keeps its
  emoji).
- **The focused tile ignores zoom.** It and its controls (Play, tag, ⋯) are always the same
  on-screen size; zooming while a tile is focused resizes the field behind it.

How to hold the text cheaply: faces are cached HTML with the font size baked in
(`titleSize = clampPx(s * 0.12, 9, 17)`), and the lens then scales the whole tile. Re-rendering
faces per zoom frame is not affordable. Write one custom property on the stage per zoom change
(the inverse zoom) and let CSS do the clamp per face:
`font-size: clamp(calc(10px * var(--inv)), <natural>, calc(17px * var(--inv)))`.

Note the limits above are *before* the fisheye: the lens already draws rim tiles, text included,
smaller than centre tiles, and that stays as it is.

### What does not change

- The offline downloads tile navigates on the first tap, as today. An offline song tile follows
  the new rule (focus, then Play) and shows no tag.
- The screen-reader tile list keeps one button per tile that plays directly. Its label already
  says "Start radio from …", so it carries no surprise. It gains no second button.
- After Play, the tile is the anchored playing tile exactly as today (#1638).

## Cost

Regulars pay one extra tap per radio. That is the price of the goal, accepted by the owner in
choosing this approach. No setting to restore one-tap play is proposed.

## Open for the builder

1. **Focus versus the sticky playing tile.** Today the playing tile holds the centre. Proposal: a
   new focus takes the centre and releases that hold; the mini-player remains the way back.
2. **Is `getFilterRadio` already random per call?** Shuffle assumes a second call returns a
   different draw. If it is seeded or cached, Shuffle needs its own parameter.
3. **Playlist shuffle scope:** reorder the whole playlist, or only choose a different lead three.
4. **Focused tile that is already playing:** show Play as a pause/playing state, or hide it.
5. **Focused size** on small phones, where the tile plus a three-row list must fit above the
   mini-player. The mock uses 190 px of a 360 px stage.
6. **Zoom and the fisheye.** Whether zoom scales the lens output, or changes the lens itself
   (`CENTER_SCALE`, `TILE_BASE`) so more or fewer tiles sit inside the same rim. The mock has no
   lens and cannot answer this.
7. **Is zoom remembered** per user, per device, or reset on each visit.
8. **Pinch versus the browser.** The stage is `touch-none` today, so a pinch reaches the page's
   own handlers; confirm on the Android WebView and iOS that the system zoom does not also fire.

## What an implementation touches

- `packages/web/src/app/pages/mosaic-home/mosaic-home.component.ts` — the delegated click handler,
  `start()`, `focusElement`, `markHeld`, the face HTML, the fetch moved from Play to focus
- `packages/web/src/app/lib/mosaic-tiles.ts` — `lane` on `MosaicTile`, set in `buildMosaicTiles`
- A pure, unit-tested `tapIntent(tile, target, focusedKey) → 'focus' | 'play' | 'navigate' | 'none'`
  in `packages/web/src/app/lib/`, so the rule above is one function rather than branches in a
  pointer handler
- `packages/web/src/styles.css` — focused-tile size and controls
- `packages/web/public/i18n/*.json` — tags, "Starts with", "Shuffle"
- Every e2e spec that taps a mosaic tile and expects playback
- [web-ui.md](web-ui.md) "Mosaic home", and the "one surface, one verb" entry in
  [index/playback.md](index/playback.md)
