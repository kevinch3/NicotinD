// Capacitor injects a global `Capacitor` object into the native Android WebView;
// it is absent in a normal browser. Detecting it here (instead of importing
// @capacitor/core) keeps the web bundle free of native deps — the same built
// `dist/` is shipped to both the browser and the Android shell.
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
}

export function isNativePlatform(): boolean {
  const cap = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  return typeof cap?.isNativePlatform === 'function' ? cap.isNativePlatform() : false;
}
