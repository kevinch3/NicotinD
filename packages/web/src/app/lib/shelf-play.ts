import type { WritableSignal } from '@angular/core';
import { isTvUi } from './platform';
import type { PlayContext, Track } from '../services/player.service';

/** The slice of `PlayerService` a shelf press touches. */
export interface ShelfPlayer {
  startRadio(track: Track): void;
  playWithContext(
    tracks: Track[],
    startIndex: number,
    contextInfo?: { type: PlayContext['type']; id?: string; name?: string },
  ): void;
  nowPlayingOpen: WritableSignal<boolean>;
}

/**
 * What pressing a song on a home shelf does.
 *
 * On phone and desktop the shelf decides, and both answers are right there: a
 * recommendation shelf seeds radio from the tapped track, while the history
 * shelf plays itself as a queue (`context`) so "recently played" behaves like a
 * list.
 *
 * On a **TV build every press seeds radio** instead. A TV has no queue view, no
 * radio toggle and no keyboard, so a finite queue ends in silence with no way
 * to restart it from the couch (#1127) — and the press routes to the player,
 * which `nowPlayingOpen` does through `TvShellComponent`'s route adapter rather
 * than through a second navigation call in every shelf.
 *
 * The variety position is whatever the listener has stored, which is `balanced`
 * (`DEFAULT_STRATEGY`) unless they changed it on another device — the TV offers
 * no chip to change it, so it never diverges on its own.
 *
 * `tv` is a parameter with a default rather than a call to `isTvUi()` inside,
 * so both branches are testable without touching the DOM.
 */
export function playShelfSong(
  player: ShelfPlayer,
  tracks: Track[],
  index: number,
  context?: { type: PlayContext['type']; id?: string; name?: string },
  tv: boolean = isTvUi(),
): void {
  const seed = tracks[index];
  if (!seed) return;
  if (tv || !context) player.startRadio(seed);
  else player.playWithContext(tracks, index, context);
  if (tv) player.nowPlayingOpen.set(true);
}
