/**
 * The static demo's media seam (docs/demo-mode.md). An `<img>` or `<audio>`
 * never passes through the HTTP interceptor, so in the demo build the URL
 * builders themselves (`coverUrl`, `withMediaToken`, `streamUrl`) point at the
 * files the snapshot recorder shipped beside the bundle. The paths are relative
 * on purpose: they resolve against `<base href>`, i.e. under `/NicotinD/demo/`.
 *
 * The recorder (`packages/e2e/demo/record-snapshot.ts`) writes the same names
 * with the same functions, so the two sides cannot disagree.
 */

/** FNV-1a 32-bit, hex — a stable short file name for a remote cover URL. */
export function demoHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export const DEMO_MEDIA_DIR = 'demo-media';

/**
 * The shipped file for an `/api/cover/...` or `/api/stream/...` URL, or null
 * for anything else. Size and rev are dropped: the demo ships one size, and its
 * covers never change.
 */
export function demoMediaPath(apiUrl: string): string | null {
  const [path = '', query = ''] = apiUrl.split('?');
  if (path === '/api/cover/remote') {
    const u = new URLSearchParams(query).get('u');
    return u ? `${DEMO_MEDIA_DIR}/remote/${demoHash(u)}.jpg` : null;
  }
  const cover = /^\/api\/cover\/([^/]+)$/.exec(path);
  if (cover) return `${DEMO_MEDIA_DIR}/covers/${cover[1]}.jpg`;
  const stream = /^\/api\/stream\/([^/]+)$/.exec(path);
  if (stream) return `${DEMO_MEDIA_DIR}/audio/${stream[1]}.${demoAudioExt()}`;
  return null;
}

let audioExt: 'webm' | 'm4a' | null = null;

/** Opus-in-WebM where the element plays it, AAC otherwise (older iOS Safari). */
export function demoAudioExt(): 'webm' | 'm4a' {
  if (audioExt) return audioExt;
  let opus = 'maybe';
  try {
    opus = document.createElement('audio').canPlayType('audio/webm; codecs="opus"');
  } catch {
    // No DOM (unit tests): keep the format every desktop browser plays.
  }
  audioExt = opus ? 'webm' : 'm4a';
  return audioExt;
}
