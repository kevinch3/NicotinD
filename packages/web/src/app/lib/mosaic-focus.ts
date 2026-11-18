import type { Track } from '../services/player.service';
import type { MosaicTile } from './mosaic-tiles';

/**
 * The rules of the focused mosaic tile, pure and DOM-free. A tap brings a tile
 * forward; only the tile brought forward can start anything.
 * See docs/mosaic-tile-focus-design.md.
 */

export type TapIntent = 'focus' | 'navigate' | 'blur' | 'none';

/**
 * What a tap on the stage means.
 *
 * @param tile       the tile under the pointer, or null for empty space
 * @param focusedKey the key of the tile already brought forward, if any
 * @param movedPx    how far the pointer travelled during the press
 * @param slopPx     travel above which the press was a pan
 */
export function tapIntent(
  tile: MosaicTile | null,
  focusedKey: string | null,
  movedPx: number,
  slopPx: number,
): TapIntent {
  if (movedPx > slopPx) return 'none';
  if (!tile) return focusedKey === null ? 'none' : 'blur';
  if (tile.action.type === 'route') return 'navigate';
  return 'focus';
}

/** How much larger than the tile it came from a focused tile is, at least. */
export const FOCUS_LIFT = 1.08;
/** Height kept free under a focused face that lists tracks. */
export const PREVIEW_ROOM_PX = 150;

export interface FocusStage {
  w: number;
  h: number;
}

/**
 * Side of the focused tile, in px. Coming forward never makes a tile smaller:
 * the side is the usual one (60% of the stage's shorter side, 190 to 320) or
 * the tile's own drawn side at the centre plus a lift, whichever is larger,
 * as far as the stage has room for it.
 *
 * @param drawnSide    the tile's on-screen side once it sits at the lens centre
 * @param reserveBelow height the track list under the face needs
 */
export function focusSide(stage: FocusStage, drawnSide = 0, reserveBelow = 0): number {
  const stageMin = Math.min(stage.w, stage.h);
  const usual = Math.min(320, Math.max(190, Math.round(stageMin * 0.6)));
  // A stage not laid out yet has no edge to keep clear of.
  if (stageMin <= 32) return usual;
  const room = Math.min(stage.w - 32, stage.h - 32 - 2 * reserveBelow);
  const grown = Math.min(Math.round(drawnSide * FOCUS_LIFT), room);
  return Math.min(Math.max(usual, grown), stageMin - 32);
}

/**
 * The scale a dismissed focused tile settles back to: the tile it came from,
 * floored so a small tile's focus fades out instead of collapsing.
 */
export function focusRestScale(side: number, drawnSide: number): number {
  if (side <= 0) return 1;
  return Math.min(1, Math.max(0.6, drawnSide / side));
}

/** The i18n key of the focused tile's tag, or null when it has nothing to say. */
export function focusTagKey(tile: MosaicTile): string | null {
  if (tile.action.type === 'offline' || tile.action.type === 'route') return null;
  switch (tile.kind) {
    case 'song':
      return tile.lane ? `mosaic.tag.${tile.lane}` : null;
    case 'playlist':
    case 'genre':
    case 'vibe':
      return `mosaic.tag.${tile.kind}`;
    default:
      return null;
  }
}

/** How many tracks a focused playlist, genre or vibe shows. */
export const PREVIEW_COUNT = 3;

/** The list with its first `n` moved to the back, so the next `n` lead. */
export function rotateLead<T>(list: readonly T[], n = PREVIEW_COUNT): T[] {
  if (list.length <= n) return [...list];
  return [...list.slice(n), ...list.slice(0, n)];
}

export interface FocusPreview {
  status: 'none' | 'loading' | 'ready' | 'empty';
  tracks: Track[];
}

export const NO_PREVIEW: FocusPreview = { status: 'none', tracks: [] };
