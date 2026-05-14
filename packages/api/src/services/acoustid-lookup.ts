import { spawn } from 'node:child_process';
import { createLogger } from '@nicotind/core';

const log = createLogger('acoustid');

const ACOUSTID_URL = 'https://api.acoustid.org/v2/lookup';
const MIN_INTERVAL_MS = 334; // ~3 req/s, AcoustID's free limit

// NOTE: the `meta` query param must be space-separated (`"recordings releases"`),
// not plus-separated. URLSearchParams encodes spaces as `+`, which the server
// treats as the separator; an explicit `+` becomes `%2B` and the server reads
// it as one unknown token, silently returning `{id, score}` only.

export interface AcoustIdResult {
  /** AcoustID track UUID. Always present when lookup() returns non-null. */
  acoustId: string;
  /** Best match score (0..1). */
  score: number;
  /** Fields below are only populated when the AcoustID is linked to MB metadata. */
  artist?: string;
  albumArtist?: string;
  album?: string;
  title?: string;
  year?: number;
  trackNumber?: number;
  recordingId?: string;
  releaseId?: string;
}

type FpcalcOutput = { duration: number; fingerprint: string };

let lastCallAt = 0;
async function rateLimit(): Promise<void> {
  const now = Date.now();
  const wait = lastCallAt + MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

let fpcalcMissingLogged = false;

function runFpcalc(filepath: string): Promise<FpcalcOutput | null> {
  return new Promise<FpcalcOutput | null>((resolve) => {
    const proc = spawn('fpcalc', ['-json', filepath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.on('error', (err) => {
      if (!fpcalcMissingLogged) {
        fpcalcMissingLogged = true;
        log.warn({ err: err.message }, 'fpcalc not available — install libchromaprint-tools to enable AcoustID lookup');
      }
      resolve(null);
    });
    proc.on('close', (code) => {
      if (code !== 0) return resolve(null);
      try {
        const parsed = JSON.parse(stdout) as { duration: number; fingerprint: string };
        if (!parsed.fingerprint || !Number.isFinite(parsed.duration)) return resolve(null);
        resolve({ duration: parsed.duration, fingerprint: parsed.fingerprint });
      } catch {
        resolve(null);
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
        mediums?: Array<{ track_count?: number; tracks?: Array<{ position?: number; title?: string }> }>;
      }>;
    }>;
  }>;
}

export class AcoustIdLookup {
  constructor(private apiKey: string) {}

  async lookup(filepath: string): Promise<AcoustIdResult | null> {
    if (!this.apiKey) return null;
    const fp = await runFpcalc(filepath);
    if (!fp) return null;

    await rateLimit();

    // IMPORTANT: meta values must be space-separated, NOT plus-separated.
    // URLSearchParams encodes spaces as "+" (form-urlencoded) — which is what
    // the server splits on. If we put literal "+" between values, URLSearchParams
    // encodes them as "%2B" and the server sees one unknown token, returning
    // just `{id, score}` with no recordings. Cost us a 3000-second backfill.
    const params = new URLSearchParams({
      client: this.apiKey,
      meta: 'recordings releasegroups releases tracks',
      duration: String(Math.round(fp.duration)),
      fingerprint: fp.fingerprint,
    });

    let raw: AcoustIdRaw;
    try {
      const res = await fetch(ACOUSTID_URL, { method: 'POST', body: params });
      if (!res.ok) {
        log.debug({ status: res.status, filepath }, 'AcoustID HTTP error');
        return null;
      }
      raw = (await res.json()) as AcoustIdRaw;
    } catch (err) {
      log.debug({ err, filepath }, 'AcoustID request failed');
      return null;
    }

    if (raw.status !== 'ok' || !raw.results || raw.results.length === 0) return null;

    const best = raw.results.find((r) => (r.score ?? 0) >= 0.7) ?? raw.results[0];
    if (!best) return null;
    // AcoustID matched the fingerprint but has no MB recording linked → still
    // return the AcoustID so the caller can cache it ("we tried, nothing here").
    if (!best.recordings || best.recordings.length === 0) {
      return { acoustId: best.id, score: best.score };
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
      const idx = medium.tracks.findIndex((t) => t.title && title && t.title.toLowerCase() === title.toLowerCase());
      if (idx >= 0) trackNumber = medium.tracks[idx]!.position ?? idx + 1;
    }

    return {
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
    };
  }
}
