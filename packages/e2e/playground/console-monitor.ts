/**
 * Pure console / page-error classifier for the playground. The fixture wires
 * `page.on('console')`, `page.on('pageerror')` and `page.on('requestfailed')`
 * and feeds each event here; anything worth reporting comes back as an
 * `Observation`. Kept Playwright-free so it's unit-tested in CI (mirrors
 * `net-monitor.ts`).
 *
 * Browser console health is the second feedback signal the harness gathers
 * (alongside network responses): a `console.error` or an uncaught `pageerror`
 * during a normal user flow is a real defect signal even when every HTTP call
 * was 200. We map errors high, warnings low, and drop known cross-origin /
 * devtools noise so the report isn't drowned.
 */
import type { Observation } from './observe.js';

export interface ConsoleEvent {
  /** Playwright ConsoleMessage.type(): 'error' | 'warning' | 'log' | 'info' | … */
  type: string;
  text: string;
  flow?: string;
}

export interface PageErrorEvent {
  message: string;
  flow?: string;
}

export interface RequestFailureEvent {
  url: string;
  /** Playwright request.failure()?.errorText, e.g. 'net::ERR_ABORTED'. */
  errorText?: string;
  flow?: string;
}

/**
 * Noise we deliberately ignore. These are environmental, not app defects:
 *   - devtools / extension chatter and source-map fetch warnings
 *   - the dev-only Angular hydration / zone messages that aren't actionable
 *   - browser autoplay-policy warnings (the player handles the gesture gate)
 *   - favicon / well-known probes
 * Keep this list short and justified — a real error must never be swallowed.
 */
const IGNORE_RE = [
  /\[vite\]|sourcemap|source map/i,
  /Download the .*DevTools|React DevTools/i,
  /autoplay|play\(\) (request|failed) was|NotAllowedError.*play/i,
  /favicon\.ico|\.well-known/i,
  /Lighthouse|chrome-extension:/i,
  // The browser's generic mirror of an HTTP failure — the response classifier
  // (net-monitor) already records the actual status with the right severity, so
  // this console echo would just double-count (and inflate degraded-mode noise).
  /Failed to load resource/i,
];

function ignored(text: string): boolean {
  return IGNORE_RE.some((re) => re.test(text));
}

/** Aborted/cancelled requests are normal (navigations, cancelled searches). */
const BENIGN_REQUEST_RE = /ERR_ABORTED|ERR_CANCELED|ERR_CACHE_MISS/i;
const COVER_RE = /\/api\/(cover|art|artwork)\//i;

export function classifyConsoleMessage(ev: ConsoleEvent): Observation | null {
  const flow = ev.flow ?? 'global';
  const text = ev.text.trim();
  if (!text || ignored(text)) return null;

  if (ev.type === 'error') {
    return {
      flow,
      kind: 'error',
      title: 'Console error',
      detail: truncate(text),
      severity: 'high',
      suggestion: 'A console.error fired during a normal user flow — likely a real defect.',
    };
  }

  if (ev.type === 'warning') {
    return {
      flow,
      kind: 'enhancement',
      title: 'Console warning',
      detail: truncate(text),
      severity: 'low',
      suggestion: 'A console warning surfaced — worth tidying so real signals stand out.',
    };
  }

  return null;
}

export function classifyPageError(ev: PageErrorEvent): Observation | null {
  const flow = ev.flow ?? 'global';
  const message = ev.message.trim();
  if (!message || ignored(message)) return null;
  return {
    flow,
    kind: 'error',
    title: 'Uncaught page error',
    detail: truncate(message),
    severity: 'high',
    suggestion: 'An uncaught exception escaped to the window during the flow — investigate.',
  };
}

export function classifyRequestFailure(ev: RequestFailureEvent): Observation | null {
  const flow = ev.flow ?? 'global';
  const err = ev.errorText ?? '';
  if (BENIGN_REQUEST_RE.test(err)) return null;
  // Cover-art failures are already an explicit, lower-severity signal handled by
  // the response classifier; a hard request failure on one is still just art.
  const isCover = COVER_RE.test(ev.url);
  return {
    flow,
    kind: isCover ? 'enhancement' : 'error',
    title: isCover ? 'Cover art request failed' : 'Request failed',
    detail: `${err || 'failed'} — ${stripQuery(ev.url)}`,
    severity: isCover ? 'low' : 'high',
    suggestion: isCover
      ? 'A cover image request failed at the network layer — backfill or use a placeholder.'
      : 'A request the UI made failed before any HTTP status — check connectivity/CORS.',
  };
}

function stripQuery(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/** Console payloads can be huge (stack traces) — keep the report line readable. */
function truncate(s: string, max = 300): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
