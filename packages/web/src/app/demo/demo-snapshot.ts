/**
 * The static demo's fake server: a pure lookup over responses recorded from
 * the REAL API (`packages/e2e/demo/record-snapshot.ts`), so the shapes cannot
 * drift the way hand-written fixtures do. docs/demo-mode.md has the design.
 *
 * - A **phase** is the server's state after a set of held-back albums were
 *   acquired: `''` is the starting library, `'A|B'` the library with both. Each
 *   phase is a full recording of the GETs the SPA makes.
 * - A **get** is the timeline recorded while one album was acquired: every
 *   response from the moment the Get fired until the album landed, stamped
 *   with its offset. Replaying it is what makes the download visibly progress.
 */
import { fold } from '@nicotind/core';

export interface DemoEntry {
  status: number;
  body: unknown;
}

export interface DemoTimelineEntry extends DemoEntry {
  /** ms after the trigger fired. */
  t: number;
  key: string;
}

export interface DemoGet {
  /** `artist\u0000title`, the album this acquires. */
  album: string;
  title: string;
  trigger: { method: string; path: string; status: number; body: unknown };
  durationMs: number;
  timeline: DemoTimelineEntry[];
}

export interface DemoSnapshot {
  version: 1;
  phases: Record<string, Record<string, DemoEntry>>;
  gets: DemoGet[];
}

/** Query params that vary per request and never select a different answer. */
const VOLATILE = new Set(['token', 'ngsw-bypass', '_', 'since', 'ts', 't', 'cursor']);

/** `GET /api/x?a=1&b=2` — method, path, and the sorted non-volatile query. */
export function requestKey(method: string, url: string): string {
  const u = new URL(url, 'http://demo.invalid');
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !VOLATILE.has(k))
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  const query = new URLSearchParams(params).toString();
  return `${method.toUpperCase()} ${u.pathname}${query ? `?${query}` : ''}`;
}

export function phaseId(acquired: Iterable<string>): string {
  return [...new Set(acquired)].sort().join('|');
}

const tokens = (s: string) =>
  fold(s)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const SEARCH_PARAMS = ['q', 'query', 'term', 'search', 'name'];

/**
 * For a GET whose exact query was never recorded: a recorded answer for the
 * same path. A search-like query picks the recorded query sharing the most
 * words with it (the recorder also stores a no-match query, which wins when
 * nothing overlaps); anything else takes the first recording of the path.
 */
export function nearestRecorded(
  entries: Record<string, DemoEntry>,
  key: string,
): DemoEntry | undefined {
  const [head, query = ''] = key.split('?');
  const wanted = new URLSearchParams(query);
  const term = SEARCH_PARAMS.map((p) => wanted.get(p)).find((v) => v != null);
  const same = Object.keys(entries).filter((k) => k.split('?')[0] === head);
  if (same.length === 0) return undefined;
  if (term == null) return entries[same[0]!];
  const want = new Set(tokens(term));
  let best: { k: string; score: number } | null = null;
  for (const k of same) {
    const q = new URLSearchParams(k.split('?')[1] ?? '');
    const recorded = SEARCH_PARAMS.map((p) => q.get(p)).find((v) => v != null) ?? '';
    const score = tokens(recorded).filter((t) => want.has(t)).length;
    if (!best || score > best.score) best = { k, score };
  }
  if (best && best.score === 0) {
    const empty = same.find((k) => k.includes('zzqx'));
    if (empty) return entries[empty];
  }
  return best ? entries[best.k] : undefined;
}

/** Writes the demo refuses, with the error code the UI maps to a notice. */
const UNSUPPORTED =
  /^\/api\/(admin|users|plugins|setup|system|addons|mcp|share|invites?|auth\/(password|users|tokens))(\/|$)/;

export const DEMO_UNSUPPORTED: DemoEntry = {
  status: 403,
  body: { error: 'Not available in the demo', code: 'DEMO_UNSUPPORTED' },
};

/** What survives a reload: the acquired albums and a Get still in flight. */
export interface DemoState {
  acquired: string[];
  active: { album: string; startedAt: number } | null;
}

export class DemoServer {
  private acquired = new Set<string>();
  private active: { get: DemoGet; startedAt: number } | null = null;

  constructor(
    private readonly snapshot: DemoSnapshot,
    private readonly now: () => number = () => Date.now(),
    initial: Partial<DemoState> = {},
  ) {
    for (const a of initial.acquired ?? []) this.acquired.add(a);
    const get = initial.active && snapshot.gets.find((g) => g.album === initial.active!.album);
    if (get) this.active = { get, startedAt: initial.active!.startedAt };
  }

  /** Albums acquired so far. */
  acquiredAlbums(): string[] {
    this.settle();
    return [...this.acquired];
  }

  /** The state to persist (the caller keeps it across reloads). */
  state(): DemoState {
    this.settle();
    return {
      acquired: [...this.acquired],
      active: this.active && { album: this.active.get.album, startedAt: this.active.startedAt },
    };
  }

  handle(method: string, url: string, body: unknown): DemoEntry {
    this.settle();
    const key = requestKey(method, url);
    const path = key.split(' ')[1]!.split('?')[0]!;

    if (method !== 'GET') {
      const get = this.triggeredGet(method, path, body);
      if (get) {
        this.active = { get, startedAt: this.now() };
        return { status: get.trigger.status, body: get.trigger.body };
      }
    }

    if (this.active) {
      const elapsed = this.now() - this.active.startedAt;
      let hit: DemoTimelineEntry | undefined;
      for (const e of this.active.get.timeline) if (e.key === key && e.t <= elapsed) hit = e;
      if (hit) return { status: hit.status, body: hit.body };
    }

    const phase = this.snapshot.phases[phaseId(this.acquired)] ?? this.snapshot.phases[''] ?? {};
    const base = this.snapshot.phases[''] ?? {};
    const exact = phase[key] ?? base[key];
    if (exact) return exact;

    if (method === 'GET') {
      return (
        nearestRecorded(phase, key) ??
        nearestRecorded(base, key) ?? { status: 404, body: { error: 'Not in the demo' } }
      );
    }
    if (method === 'DELETE' || UNSUPPORTED.test(path)) return DEMO_UNSUPPORTED;
    // Fire-and-forget writes (scrobbles, queue sync, preferences) succeed and
    // change nothing — the demo is a tour, not a server.
    return { status: 200, body: {} };
  }

  private triggeredGet(method: string, path: string, body: unknown): DemoGet | undefined {
    const candidates = this.snapshot.gets.filter(
      (g) =>
        g.trigger.method === method &&
        g.trigger.path === path &&
        !this.acquired.has(g.album) &&
        this.active?.get.album !== g.album,
    );
    if (candidates.length <= 1) return candidates[0];
    const text = fold(JSON.stringify(body ?? ''));
    return candidates.find((g) => text.includes(fold(g.title))) ?? candidates[0];
  }

  /** A Get whose timeline has played out lands its album. */
  private settle(): void {
    if (!this.active) return;
    if (this.now() - this.active.startedAt < this.active.get.durationMs) return;
    this.acquired.add(this.active.get.album);
    this.active = null;
  }
}
