import { signal } from '@angular/core';
import {
  getCapacitorPlugin,
  isCoarsePointer,
  isElectron,
  isNativePlatform,
  isTvUi,
} from './platform';

/**
 * The app's one haptics module (#1659). Call sites name a semantic event, never
 * a style or an intensity; `HAPTIC_MAP` turns each event into a native and a web
 * primitive, so retuning a feel is a one-line edit here. See docs/mobile-app.md
 * "Haptics" for the table's rationale and what each platform does with it.
 */
export type HapticEvent = 'tap' | 'select' | 'hold' | 'commit' | 'success' | 'warning' | 'error';

export type NativeHaptic =
  | { kind: 'impact'; style: 'LIGHT' | 'MEDIUM' | 'HEAVY' }
  | { kind: 'notification'; type: 'SUCCESS' | 'WARNING' | 'ERROR' }
  | { kind: 'selection' };

/** `native` is a `@capacitor/haptics` call; `web` a `navigator.vibrate` pattern (ms). */
export const HAPTIC_MAP: Record<HapticEvent, { native: NativeHaptic; web: number | number[] }> = {
  tap: { native: { kind: 'impact', style: 'LIGHT' }, web: 10 },
  select: { native: { kind: 'selection' }, web: 5 },
  hold: { native: { kind: 'impact', style: 'MEDIUM' }, web: 25 },
  commit: { native: { kind: 'impact', style: 'LIGHT' }, web: 15 },
  success: { native: { kind: 'notification', type: 'SUCCESS' }, web: [10, 60, 10] },
  warning: { native: { kind: 'notification', type: 'WARNING' }, web: [25, 80, 25] },
  error: { native: { kind: 'notification', type: 'ERROR' }, web: [40, 60, 40, 60, 40] },
};

export const HAPTIC_LEVELS = ['off', 'reduced', 'full'] as const;
export type HapticLevel = (typeof HAPTIC_LEVELS)[number];
/** Owner decision on #1659: Reduced unless the person raises it. */
export const DEFAULT_HAPTIC_LEVEL: HapticLevel = 'reduced';
/** What Reduced keeps: the moments a finger cannot otherwise feel landing. */
export const REDUCED_EVENTS: ReadonlySet<HapticEvent> = new Set(['hold', 'commit', 'error']);
/** Per device, like the language: it is about this hand and this phone. */
export const HAPTIC_LEVEL_KEY = 'nicotind-haptics';
/** The same event again inside this window is the same moment, not a second one. */
export const HAPTIC_COALESCE_MS = 40;

function isHapticLevel(v: unknown): v is HapticLevel {
  return (HAPTIC_LEVELS as readonly unknown[]).includes(v);
}

function readLevel(): HapticLevel {
  try {
    const v = localStorage.getItem(HAPTIC_LEVEL_KEY);
    return isHapticLevel(v) ? v : DEFAULT_HAPTIC_LEVEL;
  } catch {
    return DEFAULT_HAPTIC_LEVEL;
  }
}

const level = signal<HapticLevel>(readLevel());
export const hapticLevel = level.asReadonly();

export function setHapticLevel(next: HapticLevel): void {
  level.set(next);
  try {
    localStorage.setItem(HAPTIC_LEVEL_KEY, next);
  } catch {
    /* storage unavailable — the choice lasts for this session */
  }
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The one gate. `prefers-reduced-motion` caps Full at Reduced. */
export function hapticEnabled(event: HapticEvent, current: HapticLevel = level()): boolean {
  if (current === 'off') return false;
  const effective = current === 'full' && prefersReducedMotion() ? 'reduced' : current;
  return effective === 'full' || REDUCED_EVENTS.has(event);
}

function canVibrate(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

/** Whether this device can feel anything: the native shells, or a touch browser
 *  with `navigator.vibrate` (Android Chrome/PWA; iOS Safari has none). Never TV
 *  (no touch) or Electron. */
export function hapticsAvailable(): boolean {
  if (typeof document !== 'undefined' && isTvUi()) return false;
  if (isElectron()) return false;
  if (isNativePlatform()) return true;
  return isCoarsePointer() && canVibrate();
}

interface HapticsPlugin {
  impact(options: { style: 'LIGHT' | 'MEDIUM' | 'HEAVY' }): Promise<void>;
  notification(options: { type: 'SUCCESS' | 'WARNING' | 'ERROR' }): Promise<void>;
  selectionStart(): Promise<void>;
  selectionChanged(): Promise<void>;
  selectionEnd(): Promise<void>;
}

function fireNative(spec: NativeHaptic): Promise<void> | undefined {
  // `@capacitor/haptics`, reached through the Capacitor global so no
  // `@capacitor/*` import lands in the web bundle. The plugin ships in packages/mobile.
  const plugin = getCapacitorPlugin<HapticsPlugin>('Haptics');
  if (!plugin) return undefined;
  switch (spec.kind) {
    case 'impact':
      return plugin.impact({ style: spec.style });
    case 'notification':
      return plugin.notification({ type: spec.type });
    case 'selection':
      // Both platforms tick `selectionChanged` only inside a start/end pair.
      return plugin
        .selectionStart()
        .then(() => plugin.selectionChanged())
        .then(() => plugin.selectionEnd());
  }
}

const lastFired = new Map<HapticEvent, number>();

/** Fire-and-forget: never blocks, never throws, a missing plugin stays silent. */
export function haptic(event: HapticEvent): void {
  try {
    if (!hapticEnabled(event) || !hapticsAvailable()) return;
    const now = Date.now();
    const last = lastFired.get(event);
    if (last !== undefined && now - last < HAPTIC_COALESCE_MS) return;
    lastFired.set(event, now);
    const spec = HAPTIC_MAP[event];
    if (isNativePlatform()) fireNative(spec.native)?.catch(() => undefined);
    else navigator.vibrate(spec.web);
  } catch {
    /* a haptic is never worth an error */
  }
}

/** The #1297 seam, kept as an alias: a committed gesture. */
export function hapticTick(): void {
  haptic('commit');
}
