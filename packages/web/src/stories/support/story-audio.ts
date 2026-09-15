/**
 * The one transport `http-fixtures.ts` cannot reach: the `<audio>` element's own
 * resource load.
 *
 * An `HttpInterceptorFn` only sees `HttpClient`, so the player's
 * `ServerConfigService.streamUrl()` (`/api/stream/:id`) is fetched by the element
 * itself — from the Storybook server, which answers 404. That drives the
 * dead-stream recovery path (`recoverFromDeadStream`: three reloads, then a pause
 * and an error toast) instead of the playing state the story exists to show. These
 * URLs are the element-level equivalent of the fixture interceptor: a story still
 * reaches no network.
 *
 * Neither is a fake of the player. The component runs its real load, real events
 * and real recovery logic against them; only the bytes are ours.
 */
import { DEMO_TRACK_SECONDS } from './fixtures';

/**
 * 8 kHz, 8-bit, mono. Measured rather than assumed: Chromium's WAV decoder
 * rejects 1 kHz outright ("no supported source was found"), and 8-bit mono keeps
 * the buffer at 8 KB per second — a full-length track is ~1.7 MB, built once, on
 * first use only.
 */
const SAMPLE_RATE = 8000;
/** Unsigned 8-bit PCM zero. */
const SILENT_BYTE = 0x80;

function silentWavBlob(seconds: number): Blob {
  const frames = Math.round(seconds * SAMPLE_RATE);
  const bytes = new Uint8Array(44 + frames);
  const header = new DataView(bytes.buffer);
  const tag = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) header.setUint8(offset + i, text.charCodeAt(i));
  };
  tag(0, 'RIFF');
  header.setUint32(4, 36 + frames, true);
  tag(8, 'WAVEfmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, SAMPLE_RATE, true);
  header.setUint32(28, SAMPLE_RATE, true); // byte rate == sample rate at 8-bit mono
  header.setUint16(32, 1, true); // block align
  header.setUint16(34, 8, true); // bits per sample
  tag(36, 'data');
  header.setUint32(40, frames, true);
  bytes.fill(SILENT_BYTE, 44);
  return new Blob([bytes], { type: 'audio/wav' });
}

let silent: string | null = null;

/**
 * Decodable silence exactly as long as the fixture track.
 *
 * The length is the load-bearing part. The player refuses a browser-reported
 * duration far from the API-known one (`browserDurationIsAcceptable`) and treats
 * an `ended` well short of it as a truncated stream (`isFalseEnded`), so a
 * one-second stub would put every playing story into false-ended recovery a
 * second after it mounted — spinner, three reloads, then paused.
 */
export function silentStreamUrl(): string {
  silent ??= URL.createObjectURL(silentWavBlob(DEMO_TRACK_SECONDS));
  return silent;
}

let stalled: { source: MediaSource; url: string } | null = null;

/**
 * A stream that never delivers a byte: a `MediaSource` with nothing appended.
 * The element attaches, fires `waiting` and sits at `HAVE_NOTHING` — no `error`,
 * no `canplay`, and `play()` never settles.
 *
 * This is the only honest way to hold the buffering spinner. Seeding
 * `buffering` alone cannot: the component clears it the moment the element
 * reports it can play, so a buffering story pointed at real bytes shows the
 * spinner for a few hundred milliseconds and then documents the playing state
 * twice. Left open for 20 s the story reproduces the real stall watchdog
 * (`STREAM_STALL_TIMEOUT_MS`), which is the honest end of a dead stream.
 *
 * The `MediaSource` must stay referenced: the object URL dies with it.
 */
export function stalledStreamUrl(): string {
  if (!stalled) {
    const source = new MediaSource();
    stalled = { source, url: URL.createObjectURL(source) };
  }
  return stalled.url;
}
