// First http(s) URL found across the given inputs (a PWA share-target hands us
// the shared link in `url`, or embedded in `text`/`title` depending on the OS).
// Returns null when none of the inputs contain a URL.
const URL_RE = /https?:\/\/[^\s<>"']+/i;

export function extractSharedUrl(...inputs: Array<string | null | undefined>): string | null {
  for (const input of inputs) {
    if (!input) continue;
    const trimmed = input.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    const match = trimmed.match(URL_RE);
    if (match) return match[0];
  }
  return null;
}
