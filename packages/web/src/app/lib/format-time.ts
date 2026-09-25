/**
 * `m:ss` for a transport readout. One copy, because the phone bar, the
 * karaoke overlay and the TV player each grew their own and the TV one was
 * the third (#1404).
 */
export function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
