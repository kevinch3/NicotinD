import { spawn } from 'node:child_process';
import type { IdentifyOutcome, IdentifyResult } from '@nicotind/core';
import { createLogger } from '@nicotind/core';

const log = createLogger('acoustid');

const ACOUSTID_URL = 'https://api.acoustid.org/v2/lookup';
const MIN_INTERVAL_MS = 334; // ~3 req/s, AcoustID's free limit

// NOTE: the `meta` query param must be space-separated (`"recordings releases"`),
// not plus-separated. URLSearchParams encodes spaces as `+`, which the server
// treats as the separator; an explicit `+` becomes `%2B` and the server reads
// it as one unknown token, silently returning `{id, score}` only.

/**
 * Result shape. Field-identical to core's `IdentifyResult` plus two extras
 * (`albumArtist`, `trackNumber`) that only this engine's non-plugin callers
 * (`library-organizer.ts`) use — kept as an alias rather than a redeclaration
 * so the two never drift, and existing imports of `AcoustIdResult` keep
 * compiling unchanged.
 */
export type AcoustIdResult = IdentifyResult & {
  albumArtist?: string;
  trackNumber?: number;
};

/**
 * {@link IdentifyOutcome} narrowed to this engine's richer result type. Stays
 * assignable to the core outcome (AcoustIdResult extends IdentifyResult), so
 * the plugin can hand it straight to the capability without a cast.
 */
export type AcoustIdOutcome =
  | { kind: 'match'; result: AcoustIdResult }
  | { kind: Exclude<IdentifyOutcome['kind'], 'match'>; detail?: string };

type FpcalcOutput = { duration: number; fingerprint: string };

/**
 * Why fpcalc produced no fingerprint (issue #414). `missing` is a deployment
 * gap (the binary isn't there — no file is at fault); `undecodable` means
 * fpcalc ran and rejected *this file*, which is a triage signal in itself, so
 * its stderr tail is carried out rather than swallowed (the same discipline
 * the enrichment pipeline applies to ffmpeg failures).
 */
type FpcalcFailure = { kind: 'missing' | 'undecodable'; detail: string };
type FpcalcResult = { ok: true; value: FpcalcOutput } | { ok: false; error: FpcalcFailure };

/** Last N chars of a stderr blob — enough to diagnose, bounded for storage/UI. */
const STDERR_TAIL_CHARS = 400;
function stderrTail(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length > STDERR_TAIL_CHARS ? `…${trimmed.slice(-STDERR_TAIL_CHARS)}` : trimmed;
}

/** Injectable dependencies — tests fake `spawnFn`/`fetchFn` to avoid real I/O. */
export interface AcoustIdLookupDeps {
  spawnFn?: typeof spawn;
  fetchFn?: typeof fetch;
}

let lastCallAt = 0;
async function rateLimit(): Promise<void> {
  const now = Date.now();
  const wait = lastCallAt + MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

let fpcalcMissingLogged = false;

function runFpcalc(
  filepath: string,
  binaryPath: string,
  spawnFn: typeof spawn,
): Promise<FpcalcResult> {
  return new Promise<FpcalcResult>((resolve) => {
    const proc = spawnFn(binaryPath, ['-json', filepath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    // stderr was piped but never read: fpcalc's own explanation of a failure
    // was discarded at the source, so no layer above could ever report it.
    proc.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => {
      if (!fpcalcMissingLogged) {
        fpcalcMissingLogged = true;
        log.warn(
          { err: err.message },
          'fpcalc not available — install libchromaprint-tools to enable AcoustID lookup',
        );
      }
      resolve({ ok: false, error: { kind: 'missing', detail: err.message } });
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        return resolve({
          ok: false,
          error: {
            kind: 'undecodable',
            detail: stderrTail(stderr) || `fpcalc exited with code ${code}`,
          },
        });
      }
      try {
        const parsed = JSON.parse(stdout) as { duration: number; fingerprint: string };
        if (!parsed.fingerprint || !Number.isFinite(parsed.duration)) {
          // Exit 0 with no usable fingerprint is still a property of the file
          // (silence / zero-length audio), not of the AcoustID database.
          return resolve({
            ok: false,
            error: {
              kind: 'undecodable',
              detail: stderrTail(stderr) || 'fpcalc produced no fingerprint',
            },
          });
        }
        resolve({
          ok: true,
          value: { duration: parsed.duration, fingerprint: parsed.fingerprint },
        });
      } catch {
        resolve({
          ok: false,
          error: {
            kind: 'undecodable',
            detail: stderrTail(stderr) || 'fpcalc output was not valid JSON',
          },
        });
      }
    });
  });
}

interface AcoustIdRaw {
  status: string;
  results: Array<{
    id: string;
    score: number;
    recordings?: Array<{
      id: string;
      title?: string;
      artists?: Array<{ name: string }>;
      releases?: Array<{
        id: string;
        title?: string;
        date?: { year?: number };
        artists?: Array<{ name: string }>;
        track_count?: number;
        mediums?: Array<{
          track_count?: number;
          tracks?: Array<{ position?: number; title?: string }>;
        }>;
      }>;
    }>;
  }>;
}

export class AcoustIdLookup {
  private readonly spawnFn: typeof spawn;
  private readonly fetchFn: typeof fetch;

  constructor(
    private apiKey: string,
    private binaryPath: string = 'fpcalc',
    deps: AcoustIdLookupDeps = {},
  ) {
    this.spawnFn = deps.spawnFn ?? spawn;
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  /**
   * Backward-compatible match-or-null wrapper. Callers that only act on a hit
   * (the organizer's auto-tagging) keep this; anything that has to *explain*
   * the outcome to a human uses {@link identify} (issue #414).
   */
  async lookup(filepath: string): Promise<AcoustIdResult | null> {
    const outcome = await this.identify(filepath);
    return outcome.kind === 'match' ? outcome.result : null;
  }

  /**
   * Identify a track, reporting *why* it failed rather than collapsing every
   * path onto null. See `IdentifyFailureKind` for what each outcome asks the
   * curator to do — the distinction is the whole point: "AcoustID doesn't know
   * this recording" and "this file is corrupt" look identical to a caller of
   * {@link lookup}, but only one of them is a reason to discard the download.
   */
  async identify(filepath: string): Promise<AcoustIdOutcome> {
    if (!this.apiKey) {
      return { kind: 'source-error', detail: 'No AcoustID API key configured' };
    }
    const fp = await runFpcalc(filepath, this.binaryPath, this.spawnFn);
    if (!fp.ok) {
      return fp.error.kind === 'missing'
        ? { kind: 'fpcalc-missing', detail: fp.error.detail }
        : { kind: 'undecodable', detail: fp.error.detail };
    }

    await rateLimit();

    // IMPORTANT: meta values must be space-separated, NOT plus-separated.
    // URLSearchParams encodes spaces as "+" (form-urlencoded) — which is what
    // the server splits on. If we put literal "+" between values, URLSearchParams
    // encodes them as "%2B" and the server sees one unknown token, returning
    // just `{id, score}` with no recordings. Cost us a 3000-second backfill.
    const params = new URLSearchParams({
      client: this.apiKey,
      meta: 'recordings releasegroups releases tracks',
      duration: String(Math.round(fp.value.duration)),
      fingerprint: fp.value.fingerprint,
    });

    let raw: AcoustIdRaw;
    try {
      const res = await this.fetchFn(ACOUSTID_URL, { method: 'POST', body: params });
      if (!res.ok) {
        log.debug({ status: res.status, filepath }, 'AcoustID HTTP error');
        // Transient by nature (5xx, rate limit) — a retry may well succeed, so
        // this must never read as "AcoustID doesn't have this recording".
        return { kind: 'source-error', detail: `AcoustID HTTP ${res.status}` };
      }
      raw = (await res.json()) as AcoustIdRaw;
    } catch (err) {
      log.debug({ err, filepath }, 'AcoustID request failed');
      return { kind: 'source-error', detail: err instanceof Error ? err.message : String(err) };
    }

    if (raw.status !== 'ok') {
      return { kind: 'source-error', detail: `AcoustID status "${raw.status}"` };
    }
    // The service answered cleanly with nothing: the genuine no-match.
    if (!raw.results || raw.results.length === 0) return { kind: 'no-match' };

    const best = raw.results.find((r) => (r.score ?? 0) >= 0.7) ?? raw.results[0];
    if (!best) return { kind: 'no-match' };
    // AcoustID matched the fingerprint but has no MB recording linked → still
    // return the AcoustID so the caller can cache it ("we tried, nothing here").
    if (!best.recordings || best.recordings.length === 0) {
      return { kind: 'match', result: { acoustId: best.id, score: best.score } };
    }

    const recording = best.recordings[0]!;
    const title = recording.title;
    const artist = recording.artists?.[0]?.name;

    const release = recording.releases?.[0];
    const album = release?.title;
    const albumArtist = release?.artists?.[0]?.name;
    const year = release?.date?.year;

    let trackNumber: number | undefined;
    const medium = release?.mediums?.[0];
    if (medium?.tracks) {
      const idx = medium.tracks.findIndex(
        (t) => t.title && title && t.title.toLowerCase() === title.toLowerCase(),
      );
      if (idx >= 0) trackNumber = medium.tracks[idx]!.position ?? idx + 1;
    }

    return {
      kind: 'match',
      result: {
        acoustId: best.id,
        score: best.score,
        artist,
        albumArtist,
        album,
        title,
        year,
        trackNumber,
        recordingId: recording.id,
        releaseId: release?.id,
      },
    };
  }
}
