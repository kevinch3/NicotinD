import { getCapacitorPlugin, getPlatform, isElectron, isNativePlatform } from '../../lib/platform';

// Injected by the Electron desktop shell's preload script onto `window.nicotind`
// (see docs for Task 8). Kept web-local (not re-exported from @nicotind/core)
// since it describes a browser global, not a shared API type.
export interface NativeBridge {
  platform: 'electron';
  pickDirectory(): Promise<string | null>;
  /**
   * Persists a music directory desktop-side (the backend only holds
   * `musicDir` in memory, so the Electron shell is the durable owner) and,
   * with `opts.restart: true`, restarts the sidecar so the backend re-boots
   * scanning the new dir. Optional so older preload builds / non-Electron
   * bridges don't need to implement it. Resolves `{ ok: false, error }`
   * rather than rejecting when the restart fails (e.g. the backend can't
   * boot against the new dir), so callers can surface it to the user.
   */
  setMusicDir?(
    path: string,
    opts?: { restart?: boolean },
  ): Promise<{ ok: boolean; error?: string }>;
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

/**
 * Persists a new music directory via the Electron bridge; a no-op resolve
 * everywhere else (Capacitor/web have no desktop-owned sidecar to restart).
 * Always resolves (never rejects) with `{ ok, error? }` so a failed sidecar
 * restart is reportable to the caller instead of throwing.
 */
export async function setMusicDir(
  path: string,
  opts?: { restart?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  if (isElectron()) {
    return (await electronBridge()?.setMusicDir?.(path, opts)) ?? { ok: true };
  }
  return { ok: true };
}

/** Electron first (desktop), else the existing Capacitor/web platform id. */
export function platformId(): 'electron' | 'ios' | 'android' | 'web' {
  return isElectron() ? 'electron' : getPlatform();
}

// @capacitor/barcode-scanner's native plugin (reached through the Capacitor
// global like every native plugin here, so @capacitor/* stays out of the web
// bundle). `hint` selects the barcode format; 0 = QR_CODE.
interface BarcodeScannerPlugin {
  scanBarcode(options: { hint: number }): Promise<{ ScanResult?: string }>;
}

/** True when the running shell can open a camera QR scanner (Capacitor with the
 * barcode plugin installed). Electron and plain web have no scanner. */
export function canScanBarcode(): boolean {
  return isNativePlatform() && getCapacitorPlugin('CapacitorBarcodeScanner') !== null;
}

/**
 * Opens the native full-screen QR scanner and resolves the scanned string, or
 * null when unavailable, cancelled, or camera permission was denied — callers
 * treat null as "nothing happened", never as an error.
 */
export async function scanBarcode(): Promise<string | null> {
  const plugin = isNativePlatform()
    ? getCapacitorPlugin<BarcodeScannerPlugin>('CapacitorBarcodeScanner')
    : null;
  if (!plugin) return null;
  try {
    const result = await plugin.scanBarcode({ hint: 0 });
    return result?.ScanResult || null;
  } catch {
    return null;
  }
}
