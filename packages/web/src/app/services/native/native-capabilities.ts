import { getPlatform, isElectron } from '../../lib/platform';

// Injected by the Electron desktop shell's preload script onto `window.nicotind`
// (see docs for Task 8). Kept web-local (not re-exported from @nicotind/core)
// since it describes a browser global, not a shared API type.
export interface NativeBridge {
  platform: 'electron';
  pickDirectory(): Promise<string | null>;
}

function electronBridge(): NativeBridge | undefined {
  return (globalThis as { window?: { nicotind?: NativeBridge } }).window?.nicotind;
}

/**
 * Opens a native directory picker where one exists. Electron routes to the
 * preload bridge; Capacitor has no native picker yet and the plain web has
 * none either — both resolve null so callers fall back to a text input.
 */
export async function pickDirectory(): Promise<string | null> {
  if (isElectron()) {
    return (await electronBridge()?.pickDirectory()) ?? null;
  }
  return null;
}

/** Electron first (desktop), else the existing Capacitor/web platform id. */
export function platformId(): 'electron' | 'ios' | 'android' | 'web' {
  return isElectron() ? 'electron' : getPlatform();
}
