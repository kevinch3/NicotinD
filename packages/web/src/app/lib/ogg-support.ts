/**
 * Whether this client's `<audio>` can play Ogg-Opus, the library's container
 * (#1254). Safari gained Ogg only in iOS 18.4 / macOS 15.4; below that an Ogg
 * stream is silent, not degraded — "nothing happens", with no error a listener
 * can interpret.
 *
 * A capability probe, never a user-agent sniff: it answers what the element
 * will actually play. `'unknown'` when the element answers nothing at all — it
 * also denies mp3, which every real browser plays — so a non-browser (jsdom, a
 * headless test) is never mistaken for an old Safari.
 */
export type OggSupport = 'yes' | 'no' | 'unknown';

export function probeOggOpus(
  make: () => { canPlayType(type: string): string } | null = () =>
    typeof document === 'undefined' ? null : document.createElement('audio'),
): OggSupport {
  const audio = make();
  if (!audio || typeof audio.canPlayType !== 'function') return 'unknown';
  if (audio.canPlayType('audio/ogg; codecs="opus"') !== '') return 'yes';
  return audio.canPlayType('audio/mpeg') !== '' ? 'no' : 'unknown';
}
