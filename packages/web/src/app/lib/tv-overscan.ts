/**
 * TV overscan calibration (per-device, like the language picker: a TV panel
 * property, not a user property). Three D-pad-friendly presets rather than a
 * slider; `standard` matches the Android TV layout guideline the styles.css
 * defaults encode, so applying it is a visual no-op on a fresh install. The
 * values land as inline `--tv-overscan-x/y` on the document root, overriding
 * the stylesheet defaults; `off` is for panels that don't overscan at all.
 */
export type OverscanPreset = 'off' | 'standard' | 'extra';

export const OVERSCAN_STORAGE_KEY = 'nicotind-tv-overscan';

export const OVERSCAN_PRESETS: Record<OverscanPreset, { x: string; y: string }> = {
  off: { x: '0px', y: '0px' },
  standard: { x: '4vw', y: '2.5vh' },
  extra: { x: '6vw', y: '4vh' },
};

const VALID = new Set<string>(Object.keys(OVERSCAN_PRESETS));

export function loadOverscanPreset(
  storage: Pick<Storage, 'getItem'> = localStorage,
): OverscanPreset {
  try {
    const stored = storage.getItem(OVERSCAN_STORAGE_KEY);
    return stored && VALID.has(stored) ? (stored as OverscanPreset) : 'standard';
  } catch {
    return 'standard';
  }
}

export function applyOverscan(
  preset: OverscanPreset,
  el: HTMLElement = document.documentElement,
): void {
  const values = OVERSCAN_PRESETS[preset];
  el.style.setProperty('--tv-overscan-x', values.x);
  el.style.setProperty('--tv-overscan-y', values.y);
}

/** Persist + apply (the Settings control's write path). */
export function setOverscanPreset(
  preset: OverscanPreset,
  el: HTMLElement = document.documentElement,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try {
    storage.setItem(OVERSCAN_STORAGE_KEY, preset);
  } catch {
    /* private mode / quota — apply for this session anyway */
  }
  applyOverscan(preset, el);
}
