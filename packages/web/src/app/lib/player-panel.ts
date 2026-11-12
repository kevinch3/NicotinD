/**
 * The Now Playing panel as one snap-point state machine (#1651, design in
 * docs/player-panel.md). Pure: no Angular, no DOM. The component feeds it
 * gesture numbers and events and renders what it returns.
 *
 * Owner decisions (2026-11-09): two snaps, `rest` and `full` (D1 C, D3 A). A
 * panel pull down from `rest` continues into the sheet's dismiss; one from
 * `full` stops at `rest` (D2 A).
 */
import { FLICK_PX_PER_MS, shouldCommit } from './vertical-swipe';

export type PanelSnap = 'rest' | 'full';

export interface PanelState {
  snap: PanelSnap;
  /** A registered tab id. */
  tab: string;
}

/** Live layout, measured once per gesture. */
export interface PanelGeometry {
  /** `lift` at `full`: from the panel's rest top to the safe-area top. */
  fullLiftPx: number;
  /** The cover's max size; the first this-many px of lift shrink it. */
  coverMaxPx: number;
}

/** The mini bar's open threshold, reused so both gestures feel alike. */
export const SNAP_COMMIT_MAX_PX = 96;
export const SNAP_COMMIT_SHARE = 0.35;
/** Today's sheet dismiss distance, kept for the pull below `rest`. */
export const DISMISS_THRESHOLD_PX = 120;

export function snapCommitPx(gapPx: number): number {
  return Math.min(SNAP_COMMIT_MAX_PX, SNAP_COMMIT_SHARE * Math.max(0, gapPx));
}

/**
 * `lift` as the gesture may move it: 0 at `rest`, positive up, capped at
 * `full`. Only a gesture that started at `rest` may go below 0 (a dismiss).
 */
export function clampLift(start: PanelSnap, liftPx: number, g: PanelGeometry): number {
  const floor = start === 'rest' ? -Infinity : 0;
  return Math.min(g.fullLiftPx, Math.max(floor, liftPx));
}

export type SettleResult = { kind: 'snap'; snap: PanelSnap } | { kind: 'dismiss' };

/**
 * Where a released (or cancelled) pull lands. `velocity` is px/ms, positive
 * upward; a cancel passes 0 so an OS interruption never flings. A flick moves
 * at most one snap from where the gesture started.
 */
export function settle(
  start: PanelSnap,
  rawLiftPx: number,
  velocityPxPerMs: number,
  g: PanelGeometry,
): SettleResult {
  const lift = clampLift(start, rawLiftPx, g);
  const commit = snapCommitPx(g.fullLiftPx);
  if (start === 'rest') {
    if (lift < 0) {
      return shouldCommit(-lift, -velocityPxPerMs, { thresholdPx: DISMISS_THRESHOLD_PX })
        ? { kind: 'dismiss' }
        : { kind: 'snap', snap: 'rest' };
    }
    const up = lift >= commit || velocityPxPerMs >= FLICK_PX_PER_MS;
    return { kind: 'snap', snap: up ? 'full' : 'rest' };
  }
  const down = g.fullLiftPx - lift >= commit || velocityPxPerMs <= -FLICK_PX_PER_MS;
  return { kind: 'snap', snap: down ? 'rest' : 'full' };
}

/** The `lift` a snap rests at, where a new gesture starts from. */
export function snapLift(snap: PanelSnap, g: PanelGeometry): number {
  return snap === 'full' ? g.fullLiftPx : 0;
}

/**
 * The `lift` a new pointerdown starts from. During a settle animation that is
 * the *rendered* value, not the target snap's, so catching the panel
 * mid-flight never jumps. Null when nothing is animating.
 */
export function gestureBaseLift(
  target: PanelSnap,
  renderedLiftPx: number | null,
  g: PanelGeometry,
): number {
  return renderedLiftPx === null ? snapLift(target, g) : clampLift(target, renderedLiftPx, g);
}

export interface PanelLayout {
  /** Cover max size, shrinking over the first `coverMaxPx` of lift. */
  coverMaxPx: number;
  /** Upward translate of the panel frame once the cover is gone. */
  panelTranslatePx: number;
  /** Downward offset of the whole sheet during a dismiss pull. */
  sheetOffsetPx: number;
  /** 0 → 1 as the panel covers the stage (header, transport). */
  stageCovered: number;
}

export function panelLayout(liftPx: number, g: PanelGeometry): PanelLayout {
  if (liftPx < 0) {
    return {
      coverMaxPx: g.coverMaxPx,
      panelTranslatePx: 0,
      sheetOffsetPx: -liftPx,
      stageCovered: 0,
    };
  }
  const lift = Math.min(liftPx, g.fullLiftPx);
  if (lift <= g.coverMaxPx) {
    return {
      coverMaxPx: g.coverMaxPx - lift,
      panelTranslatePx: 0,
      sheetOffsetPx: 0,
      stageCovered: 0,
    };
  }
  const span = g.fullLiftPx - g.coverMaxPx;
  return {
    coverMaxPx: 0,
    panelTranslatePx: lift - g.coverMaxPx,
    sheetOffsetPx: 0,
    stageCovered: span > 0 ? (lift - g.coverMaxPx) / span : 1,
  };
}

export type PullOrigin = 'panel' | 'stage';
export type PullMode = 'panel' | 'dismiss' | 'release';

/**
 * Who owns a pull, decided once at slop (docs/player-panel.md §2.4). `lg` is
 * the side column, where today's rows hold: up releases, down dismisses.
 */
export function resolvePullMode(input: {
  origin: PullOrigin;
  direction: 'up' | 'down';
  snap: PanelSnap;
  /** scrollTop of the nested scroller under the finger, 0 when none. */
  nestedScrollTop: number;
  lg: boolean;
}): PullMode {
  const { origin, direction, snap, nestedScrollTop, lg } = input;
  if (lg) return direction === 'up' ? 'release' : 'dismiss';
  if (origin === 'panel') {
    if (direction === 'down') return nestedScrollTop > 0 ? 'release' : 'panel';
    // At full height the list scrolls natively.
    return snap === 'full' ? 'release' : 'panel';
  }
  // The stage is covered at `full`, so a stage pull can only start at `rest`.
  return direction === 'up' ? 'panel' : 'dismiss';
}

export type PanelEvent =
  | { type: 'tap-tab'; tab: string }
  | { type: 'notch-activate' }
  | { type: 'key-up' }
  | { type: 'key-down' }
  | { type: 'back' };

export interface TransitionResult {
  state: PanelState;
  /** False when the event is the sheet's to handle (Back at `rest` closes it). */
  consumed: boolean;
}

/** Discrete events (D4: an inactive tab switches; the active tab toggles). */
export function transition(state: PanelState, event: PanelEvent): TransitionResult {
  const toggle = (): PanelState => ({ ...state, snap: state.snap === 'full' ? 'rest' : 'full' });
  switch (event.type) {
    case 'tap-tab':
      return {
        state: event.tab === state.tab ? toggle() : { ...state, tab: event.tab },
        consumed: true,
      };
    case 'notch-activate':
      return { state: toggle(), consumed: true };
    case 'key-up':
      return { state: { ...state, snap: 'full' }, consumed: true };
    case 'key-down':
      return { state: { ...state, snap: 'rest' }, consumed: true };
    case 'back':
      return state.snap === 'full'
        ? { state: { ...state, snap: 'rest' }, consumed: true }
        : { state, consumed: false };
  }
}

/** The snap a width can show: `full` beside the side column only for tabs that allow it. */
export function effectiveSnap(
  state: PanelState,
  opts: { lg: boolean; fullAtLg: boolean },
): PanelSnap {
  return opts.lg && !opts.fullAtLg ? 'rest' : state.snap;
}

export const PANEL_STORAGE_KEY = 'nicotind:np-panel';
export const LEGACY_ACTIVE_PANEL_KEY = 'nicotind:np-active-panel';
export const LEGACY_QUEUE_EXTRA_KEY = 'nicotind:np-queue-extra';

export interface PanelStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Read the persisted panel state (docs/player-panel.md §8). A legacy read
 * writes the new key **before** removing the old ones, so a failed write
 * leaves the old state readable. Storage errors are swallowed.
 */
export function restorePanelState(storage: PanelStorage, tabs: readonly string[]): PanelState {
  const first = tabs[0] ?? 'queue';
  const known = (tab: unknown): string =>
    typeof tab === 'string' && tabs.includes(tab) ? tab : first;

  const raw = safe(() => storage.getItem(PANEL_STORAGE_KEY), null);
  if (raw !== null) {
    const parsed = safe((): unknown => JSON.parse(raw), null);
    if (parsed && typeof parsed === 'object' && (parsed as { v?: unknown }).v === 1) {
      const { tab, snap } = parsed as { tab?: unknown; snap?: unknown };
      return { tab: known(tab), snap: snap === 'full' ? 'full' : 'rest' };
    }
  }

  const legacyPanel = safe(() => storage.getItem(LEGACY_ACTIVE_PANEL_KEY), null);
  const legacyExtra = safe(() => storage.getItem(LEGACY_QUEUE_EXTRA_KEY), null);
  // Any old cover-shrink size maps to `rest`: `full` covers the transport,
  // which the old layout never did, and it is one tap away.
  const state: PanelState = {
    tab: known(legacyPanel === 'lyrics' ? 'lyrics' : 'queue'),
    snap: 'rest',
  };
  if (legacyPanel !== null || legacyExtra !== null) {
    const written = safe(() => {
      storage.setItem(PANEL_STORAGE_KEY, serializePanelState(state));
      return true;
    }, false);
    if (written) {
      safe(() => storage.removeItem(LEGACY_ACTIVE_PANEL_KEY), undefined);
      safe(() => storage.removeItem(LEGACY_QUEUE_EXTRA_KEY), undefined);
    }
  }
  return state;
}

export function serializePanelState(state: PanelState): string {
  return JSON.stringify({ v: 1, tab: state.tab, snap: state.snap });
}

/** Persist a settled snap; never called mid-gesture. */
export function persistPanelState(storage: PanelStorage, state: PanelState): void {
  safe(() => storage.setItem(PANEL_STORAGE_KEY, serializePanelState(state)), undefined);
}
