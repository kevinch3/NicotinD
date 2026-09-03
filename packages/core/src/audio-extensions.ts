/**
 * The one answer to "is this file library content?".
 *
 * This lived in five places with five different memberships. The scanner
 * indexed `.wma`; `library-disk-audit` did not collect it — so the audit
 * compared a disk walk built from one definition against a DB built from
 * another and reported every `.wma` row as `missing_file`, a finding whose
 * obvious remediation is to delete a row for a file that is present (#845).
 *
 * Every member of `LOSSLESS` (`library-track-select.ts`) must appear here, or
 * the app claims to standardize a format it can never index — `.ape` and `.wv`
 * were exactly that. `lossless-subset.test.ts` asserts it.
 *
 * Adding a container here is the only place it needs adding. Narrower sets are
 * legitimate only when they describe something *other* than library membership
 * — see `ID3_EXTS` / `VORBIS_EXTS`, which describe tag containers a writer
 * understands. Name those for what they gate; never re-declare this one.
 */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp3',
  '.flac',
  '.m4a',
  '.aac',
  '.ogg',
  '.opus',
  '.wav',
  '.wma',
  '.alac',
  '.aiff',
  '.aif',
  '.wave',
  '.ape',
  '.wv',
  '.webm', // yt-dlp bestaudio output; contains opus audio
]);

/** Files whose tags are written through the ID3 path. */
export const ID3_EXTS: ReadonlySet<string> = new Set(['.mp3']);

/** Files whose tags are written through the Vorbis-comment path. */
export const VORBIS_EXTS: ReadonlySet<string> = new Set(['.flac', '.ogg', '.opus']);

/**
 * Whether a filename or path is library content. Case-insensitive; a dotfile
 * with no real extension (`.flac`) is not audio, which matters because
 * `extname('.flac')` is `''` while `extname('._Track.flac')` is `'.flac'`.
 */
export function isAudioFile(nameOrPath: string): boolean {
  return AUDIO_EXTENSIONS.has(extensionOf(nameOrPath));
}

/**
 * Lowercased extension of a path or bare name, including the dot; `''` when
 * there is none.
 *
 * Hand-rolled rather than `node:path`'s `extname` so this module carries no node
 * builtin and the web bundle can import it — the Angular build refuses
 * `node:path` outright, and the upload allowlist needs this same answer in the
 * browser.
 *
 * Matches `extname`'s two load-bearing behaviours: it reads the **basename**, so
 * a dot in a *directory* (`/music/My.Album/track`) is not an extension; and a
 * leading dot is not one either, so `.flac` yields `''` while `._Track.flac`
 * yields `'.flac'` — which is what keeps AppleDouble sidecars out.
 */
export function extensionOf(nameOrPath: string): string {
  const base = nameOrPath.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}
