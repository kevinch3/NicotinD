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

/** Side of the focused tile, in px, for a stage whose shorter side is `stageMin`. */
export function focusSide(stageMin: number): number {
  const wanted = Math.min(320, Math.max(190, Math.round(stageMin * 0.6)));
  return Math.min(wanted, stageMin - 32);
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
