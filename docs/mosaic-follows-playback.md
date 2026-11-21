# The mosaic follows playback

When the mosaic starts a radio, the tile that started it wears a ring. Each time the song changes,
the next song takes over a tile a **knight's move** away, the ring jumps to it, and the camera
follows if you were watching. Code: `lib/mosaic-follow.ts` (pure) and the walk in
`MosaicHomeComponent` (`beginWalk`, `onTrackChange`, `returnToPlaying`, `placeChip`).

## Why a tile has to change

A radio draws from the whole library, and the field shows a sample of it. Most next songs have no
tile, so "move the selection to the next song's tile" would usually have nowhere to go. Instead the
next song **lands** on a tile: that copy's face is swapped for the song's (`trackTile`, the same face
markup as any song tile) and the copy it left goes back to its own tile. Nothing is shown in advance.
A trail of upcoming tiles was prototyped and dropped for now: the field read better without it.

## The step

`knightStep` moves two steps one way and one the other, in one of the eight knight directions picked
at random, and lands on whichever tile copy is nearest that point (`nearestSpot`), so it works on the
packer's mixed tile sizes. A step is the median tile side plus `GAP` (`medianStep`): the median, so
one large tile does not throw the next song across the field. A move that lands on the playing copy,
or on a copy this radio already played on, gives way to the next direction round; only when all
eight are spent does it revisit. The walk crosses torus copies freely; the face override is keyed on
the exact copy (`id`, `i`, `j`), so the other copies of that slot keep their own content.

## When the camera follows

It follows **only while the playing tile is on screen** (`spotOnScreen`: drawn this frame and not
fading at the rim) **and no tile is brought forward**. Otherwise the field stays where the listener
took it and the anchor is dropped, so the sticky lock (#1638) cannot spring the field back to a tile
that no longer plays. While the playing tile is off screen a **Now playing** chip sits on the stage's
edge, its arrow pointing at the tile; tapping it brings the playing face to the copy nearest the
camera and glides there, rather than crossing the plane (and fetching every discovery cell on the
way).

**The playing face is pinned from the start (#2054).** A discovery cell fills a slot with its own
random song, so a copy's face depends on which cell it is in, and an evicted cell refetches new
songs. The walk therefore never leans on the slot: `beginWalk` pins the tile Play started as the
playing copy's face, and each step pins the new song's. The tapped copy keeps the content key it was
drawn with, so starting playback does not redraw it; a start from the accessible list, whose nearest
copy may hold another song, takes the tile's own key and is redrawn (`tileAt` decides which).

The seed song is never mistaken for a next song: the player sets `currentTrack` synchronously, so
`beginWalk` reads the seed's id right after the start call. A track change the mosaic did not start
(no walk in progress) leaves the field alone.

**The walk resumes from the player.** The walk lives on the component, so leaving home drops it, and
a repack (a return to home, a resize) cannot keep it anyway: its spot names a slot of the old
packing. Instead every repack ends in `resumeWalk`: when the player has a current track, it takes
the centre tile (`trackTile`), wears the ring and holds the lock, and the next song walks on from
there. Coming back from the Library therefore shows what is playing without another tap.

## Cost

No request. The walk reacts only to `PlayerService.currentTrack` changing, so it does not depend on
how far ahead the queue is held. The ring is an outline inside the tile's shadow inset, so the tile
keeps `contain: strict`.
