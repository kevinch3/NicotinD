/**
 * Pure HTTP-response classifier for the playground. The fixture wires a
 * `page.on('response')` listener and feeds each response here; anything worth
 * reporting (cover-art 404s, server errors, slow API calls) comes back as an
 * `Observation`. Kept Playwright-free so it's unit-tested in CI.
 *
 * The cover-art 404 case is a direct ask: thumbnails that 404 are an
 * improvable signal — `library_artwork` backfill or a graceful placeholder.
 * See docs/library-scanner.md (canonical artwork) and the `noArtCache` short-circuit.
 */
import type { Observation } from './observe.js';

export interface ResponseEvent {
  url: string;
  status: number;
  /** Wall-clock time the request took, if the caller measured it. */
  durationMs?: number;
  flow?: string;
}

export interface ClassifyOptions {
  /** API calls slower than this are flagged as a timing observation. */
  slowApiMs?: number;
  flow?: string;
}

const COVER_RE = /\/api\/(cover|art|artwork)\//i;
const STREAM_RE = /\/api\/stream\//i;
const API_RE = /\/api\//i;

export function classifyResponse(ev: ResponseEvent, opts: ClassifyOptions = {}): Observation | null {
  const flow = ev.flow ?? opts.flow ?? 'global';
  const slowApiMs = opts.slowApiMs ?? 3000;
  const path = stripQuery(ev.url);

  // Cover / thumbnail 404 — the explicit "thumbnails that 404" signal.
  if (ev.status === 404 && COVER_RE.test(path)) {
    return {
      flow,
      kind: 'enhancement',
      title: 'Cover art 404',
      detail: path,
      severity: 'low',
      suggestion:
        'Missing artwork served a 404 — backfill library_artwork (scripts/backfill-artwork.ts) or fall back to a deterministic placeholder so the UI never shows a broken image.',
    };
  }

  // Any other unexpected 404 on an API call worth noting (not streams — range
  // probes legitimately 404 sometimes; not the SPA's client-side routes).
  if (ev.status === 404 && API_RE.test(path) && !STREAM_RE.test(path)) {
    return {
      flow,
      kind: 'gap',
      title: `404 on ${apiLabel(path)}`,
      detail: path,
      severity: 'low',
      suggestion: 'An API call the UI made returned 404 — verify the resource id flow.',
    };
  }

  // 503 = a gated/backing service was unavailable (slskd/Lidarr down). Expected
  // in managed/degraded mode and a soft signal on live — record it low, not as a
  // crash, so it never drowns out real findings in "Top signals".
  if (ev.status === 503 && API_RE.test(path)) {
    return {
      flow,
      kind: 'degraded',
      title: `Service unavailable: ${apiLabel(path)}`,
      detail: path,
      severity: 'low',
      suggestion: 'A gated/backing service (slskd/Lidarr) was unavailable for this call.',
    };
  }

  // A genuine server crash (500/502/504) is always worth surfacing.
  if (ev.status >= 500 && API_RE.test(path)) {
    return {
      flow,
      kind: 'error',
      title: `${ev.status} on ${apiLabel(path)}`,
      detail: path,
      severity: 'high',
      suggestion: 'A server error fired during a normal user flow.',
    };
  }

  // Slow API call.
  if (typeof ev.durationMs === 'number' && ev.durationMs >= slowApiMs && API_RE.test(path)) {
    return {
      flow,
      kind: 'timing',
      title: `Slow API call: ${apiLabel(path)}`,
      detail: path,
      value: Math.round(ev.durationMs),
      unit: 'ms',
      severity: ev.durationMs >= slowApiMs * 3 ? 'medium' : 'low',
      suggestion: 'Consider streaming partial results, caching, or a perf pass.',
    };
  }

  return null;
}

function stripQuery(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/** Collapse a path to a stable label (strip host + numeric/hash ids) so repeat
 * 404s on different ids dedupe to one report line. */
export function apiLabel(url: string): string {
  let path = stripQuery(url).replace(/^https?:\/\/[^/]+/, '');
  const api = path.indexOf('/api/');
  if (api >= 0) path = path.slice(api);
  return path
    .split('/')
    .map((seg) => (/^[0-9a-f]{8,}$/i.test(seg) || /^\d+$/.test(seg) ? ':id' : seg))
    .join('/');
}
