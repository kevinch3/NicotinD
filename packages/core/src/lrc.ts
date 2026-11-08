/**
 * Pure helpers for synced (LRC) lyrics — parsing, line timing, and the offset
 * that corrects a source whose timings belong to a different master of the same
 * performance.
 *
 * Shared rather than web-local (it began life in `packages/web/src/app/lib/`)
 * because the API needs the same parse: the health report decides whether an
 * LRC overruns its own file, and the MCP read tool reports where a row's
 * timings actually sit. Two parsers would have drifted on exactly the sign
 * convention below, which is the one thing here that cannot be guessed.
 *
 * **The convention, fixed once:** a stored offset is ADDED to every timestamp,
 * so positive means "show the lines later". The LRC spec's own `[offset:]` tag
 * is the opposite — `+` makes lyrics appear *sooner* — so it is subtracted at
 * parse time. Everything downstream resolves its signs against this paragraph.
 */

export interface LyricLine {
  /** Timestamp in milliseconds from the start of the track. */
  timeMs: number;
  text: string;
}

export interface ParsedLrc {
  /** Time-sorted lines, with the file's own `[offset:]` tag already applied. */
  lines: LyricLine[];
  /** The `[offset:±N]` tag as written, in ms. 0 when absent or malformed. */
  fileOffsetMs: number;
}

// [mm:ss.xx] / [mm:ss.xxx] / [mm:ss] — one or more may prefix a single line.
const TIMESTAMP = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
// [offset:+250] — an ID tag on its own line. Anchored so it cannot match text.
const FILE_OFFSET = /^\s*\[offset:\s*([+-]?\d{1,7})\s*\]\s*$/im;

/**
 * Parse raw LRC text into time-sorted lines, with the file's `[offset:]` tag
 * already applied. Lines may carry multiple timestamps (repeated chorus) —
 * each becomes its own entry. ID tags like `[ar:...]` / `[ti:...]` are ignored,
 * and lines with no timestamp are dropped. Returns [] for empty input.
 */
export function parseLrc(raw: string | null | undefined): LyricLine[] {
  return parseLrcDetailed(raw).lines;
}

/** `parseLrc` plus the file offset it applied, for callers that must report it. */
export function parseLrcDetailed(raw: string | null | undefined): ParsedLrc {
  if (!raw) return { lines: [], fileOffsetMs: 0 };
  const fileOffsetMs = Number(FILE_OFFSET.exec(raw)?.[1] ?? 0);
  const out: LyricLine[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    TIMESTAMP.lastIndex = 0;
    const stamps: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = TIMESTAMP.exec(rawLine)) !== null) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      // A 2-digit fraction is centiseconds, a 3-digit one is milliseconds.
      const frac = m[3] ?? '';
      const ms = frac.length === 3 ? Number(frac) : Number(frac.padEnd(2, '0')) * 10;
      stamps.push(min * 60_000 + sec * 1000 + (Number.isFinite(ms) ? ms : 0));
    }
    if (stamps.length === 0) continue;
    const text = rawLine.replace(TIMESTAMP, '').trim();
    // Subtract, not add: the spec's `+` means the lyrics arrive sooner.
    for (const timeMs of stamps) out.push({ timeMs: timeMs - fileOffsetMs, text });
  }
  return { lines: out.sort((a, b) => a.timeMs - b.timeMs), fileOffsetMs };
}

/**
 * Shift every line by `offsetMs` — positive shows them later. A rigid
 * translation: order, count and text are untouched, and a resulting negative
 * time is kept rather than clamped, so the shift stays reversible.
 *
 * This is why a sync correction never rewrites the fetched text. The stored
 * offset is one integer applied at render time, so the source's words survive
 * intact and the correction can be undone by setting it back to 0.
 */
export function applyLyricsOffset(lines: LyricLine[], offsetMs: number): LyricLine[] {
  if (!offsetMs) return lines.map((l) => ({ ...l }));
  return lines.map((l) => ({ timeMs: l.timeMs + offsetMs, text: l.text }));
}

// A line timestamp `[mm:ss.xx]` or an enhanced-LRC word timestamp `<mm:ss.xx>`.
const ANY_STAMP =
  /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]|<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
const OFFSET_LINE = /^\s*\[offset:\s*[+-]?\d{1,7}\s*\]\s*$/i;

function formatStamp(ms: number, fracDigits: 0 | 2 | 3): string {
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const head = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  if (fracDigits === 3) return `${head}.${String(rest).padStart(3, '0')}`;
  if (fracDigits === 0 && rest === 0) return head;
  return `${head}.${String(Math.floor(rest / 10)).padStart(2, '0')}`;
}

/**
 * Rewrite `raw` so its timestamps already carry `offsetMs` (positive = later)
 * **and** the file's own `[offset:]` tag, which is removed — the result needs
 * no offset at all to play as the listener heard it. For handing a corrected
 * LRC to something that has no field for a separate offset (#1676's export).
 *
 * Everything else is kept byte for byte: ID tags, untimed lines, line endings,
 * text. Word timestamps (`<mm:ss.xx>`) move with their lines. A stamp shifted
 * before 0 is clamped to 0, since an LRC cannot say "before the track starts";
 * each keeps its own precision (3 digits stays ms, otherwise centiseconds).
 * With nothing to apply the input is returned unchanged.
 */
export function bakeLyricsOffset(raw: string, offsetMs: number): string {
  const fileOffsetMs = Number(FILE_OFFSET.exec(raw)?.[1] ?? 0);
  const shift = Math.round(offsetMs) - fileOffsetMs;
  if (shift === 0 && !FILE_OFFSET.test(raw)) return raw;
  const shiftStamp = (min: string, sec: string, frac: string | undefined): string => {
    const f = frac ?? '';
    const ms = f.length === 3 ? Number(f) : Number(f.padEnd(2, '0')) * 10;
    const at = Math.max(0, Number(min) * 60_000 + Number(sec) * 1000 + ms + shift);
    return formatStamp(at, f.length === 3 ? 3 : f.length === 0 ? 0 : 2);
  };
  return raw
    .split(/(?<=\n)/)
    .filter((line) => !OFFSET_LINE.test(line.replace(/\r?\n$/, '')))
    .map((line) =>
      line.replace(ANY_STAMP, (_m, lm, ls, lf, wm, ws, wf) =>
        lm !== undefined ? `[${shiftStamp(lm, ls, lf)}]` : `<${shiftStamp(wm, ws, wf)}>`,
      ),
    )
    .join('');
}

/**
 * How far past the end of a `durationSec`-long file the last line of `synced`
 * lands once `offsetMs` is applied, in seconds. Negative when the LRC finishes
 * inside the track (the normal case); `-Infinity` when it has no timed lines.
 * An overrun beyond `LYRICS_DURATION_TOLERANCE_SEC` cannot belong to that file —
 * the library-health detector and the re-fetch guard read this one predicate.
 */
export function lrcOverrunSec(
  synced: string | null | undefined,
  offsetMs: number | null | undefined,
  durationSec: number,
): number {
  const lines = applyLyricsOffset(parseLrc(synced), offsetMs ?? 0);
  const last = lines[lines.length - 1];
  if (!last) return Number.NEGATIVE_INFINITY;
  return last.timeMs / 1000 - durationSec;
}

/**
 * Index of the line that should be highlighted at `currentMs`: the last line
 * whose timestamp is at or before the current position. Returns -1 before the
 * first line. `lines` must be time-sorted (as `parseLrc` returns them).
 */
export function findActiveLine(lines: LyricLine[], currentMs: number): number {
  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.timeMs <= currentMs) active = i;
    else break;
  }
  return active;
}
