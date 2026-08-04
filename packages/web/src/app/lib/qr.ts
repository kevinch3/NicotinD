/**
 * Shared QR rendering (devices pairing QR + the TV sign-in code). The dynamic
 * import is deliberate and load-bearing: `qrcode` is CommonJS, which esbuild
 * reports as an optimization bailout when statically imported (issue #256),
 * and loading lazily keeps it out of every route chunk until a QR is actually
 * requested. The CJS interop differs per chunk in the esbuild output — the
 * namespace may carry the API directly OR under `default` (observed: the
 * destructured `toDataURL` was `undefined` in the login chunk while fine
 * under vitest's node interop) — so both shapes are handled. Returns null on
 * failure; callers show their "unavailable" state rather than a broken image.
 */
export async function renderQrDataUrl(payload: string, width = 240): Promise<string | null> {
  try {
    const mod = (await import('qrcode')) as
      typeof import('qrcode') | { default: typeof import('qrcode') };
    const qr = 'toDataURL' in mod ? mod : mod.default;
    return await qr.toDataURL(payload, { margin: 1, width });
  } catch {
    return null;
  }
}
