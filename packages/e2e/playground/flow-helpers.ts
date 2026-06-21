/**
 * Thin IO helpers shared by playground flows — authorized API calls + network
 * search polling with timing. These wrap `page.request`, so they're exercised by
 * the live specs (not bun-unit-tested); the pure logic lives in observe/report/
 * net-monitor.
 */
import type { Page } from '@playwright/test';

export interface UnifiedSearch {
  searchId: string;
  networkAvailable: boolean;
  local: { artists: unknown[]; albums: unknown[]; songs: unknown[] };
  errors?: string[];
}

async function authGet(page: Page, token: string | null, path: string) {
  return page.request.get(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

export async function unifiedSearch(
  page: Page,
  token: string | null,
  q: string,
): Promise<UnifiedSearch> {
  const res = await authGet(page, token, `/api/search?q=${encodeURIComponent(q)}`);
  return (await res.json()) as UnifiedSearch;
}

export interface CatalogResult {
  ok: boolean;
  status: number;
  artists: Array<{ name: string }>;
  albums: Array<{ artistName: string; albumType: string; title: string }>;
}

export async function catalogSearch(
  page: Page,
  token: string | null,
  q: string,
): Promise<CatalogResult> {
  const res = await authGet(page, token, `/api/catalog/search?q=${encodeURIComponent(q)}`);
  const ok = res.ok();
  if (!ok) return { ok, status: res.status(), artists: [], albums: [] };
  const body = (await res.json()) as CatalogResult;
  return { ok, status: res.status(), artists: body.artists ?? [], albums: body.albums ?? [] };
}

export interface MetadataCandidatesResult {
  ok: boolean;
  status: number;
  query: string;
  candidates: Array<{ artist: string; title: string; score: number; year: number | null }>;
}

/** Fetch the metadata-fix candidates for an album (admin; needs Lidarr live). */
export async function metadataCandidates(
  page: Page,
  token: string | null,
  albumId: string,
  q?: string,
): Promise<MetadataCandidatesResult> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : '';
  const res = await authGet(page, token, `/api/library/albums/${albumId}/metadata-candidates${qs}`);
  if (!res.ok()) return { ok: false, status: res.status(), query: q ?? '', candidates: [] };
  const body = (await res.json().catch(() => ({}))) as Partial<MetadataCandidatesResult>;
  return { ok: true, status: res.status(), query: body.query ?? q ?? '', candidates: body.candidates ?? [] };
}

/** First album id in the library, for flows that need any album to act on. */
export async function firstAlbumId(page: Page, token: string | null): Promise<string | null> {
  const ids = await albumIds(page, token);
  return ids[0] ?? null;
}

/** All album ids currently in the library — used to diff what an acquisition added. */
export async function albumIds(page: Page, token: string | null): Promise<string[]> {
  const res = await authGet(page, token, '/api/library/albums');
  if (!res.ok()) return [];
  const albums = (await res.json().catch(() => [])) as Array<{ id: string }>;
  return Array.isArray(albums) ? albums.map((a) => a.id).filter(Boolean) : [];
}

export interface NetworkPoll {
  state: string;
  resultCount: number;
  fileCount: number;
  /** ms from poll start to the first non-empty result page. */
  firstResultMs: number | null;
  /** ms from poll start to `state: complete`. */
  completeMs: number | null;
}

export async function pollNetwork(
  page: Page,
  token: string | null,
  searchId: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<NetworkPoll> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 1000;
  const start = Date.now();
  let firstResultMs: number | null = null;
  let lastCount = 0;
  let lastFiles = 0;

  for (;;) {
    const res = await authGet(page, token, `/api/search/${searchId}/network`);
    const body = (await res.json().catch(() => ({}))) as {
      state?: string;
      results?: Array<{ files?: unknown[] }>;
    };
    const results = body.results ?? [];
    lastCount = results.length;
    lastFiles = results.reduce((n, r) => n + (r.files?.length ?? 0), 0);
    if (firstResultMs === null && (lastCount > 0 || lastFiles > 0)) {
      firstResultMs = Date.now() - start;
    }
    if (body.state === 'complete' || Date.now() - start > timeoutMs) {
      return {
        state: body.state ?? 'timeout',
        resultCount: lastCount,
        fileCount: lastFiles,
        firstResultMs,
        completeMs: body.state === 'complete' ? Date.now() - start : null,
      };
    }
    await page.waitForTimeout(intervalMs);
  }
}
