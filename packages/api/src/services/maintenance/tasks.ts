import type { Database } from 'bun:sqlite';
import { optimizeAllAlbums, type OptimizeLidarr } from '../metadata-optimize.js';
import { transcodeLibraryToOpus } from '../library-transcode.js';

/**
 * Operator-triggered, whole-library maintenance passes.
 *
 * The deliberate mirror of `EnrichmentTask` (`services/enrichment/tasks.ts`):
 * same `id`/`label`/`available()`/`run()` vocabulary, opposite trigger. Those
 * run unattended inside the nightly window over *songs*; these are destructive
 * library-wide passes an admin starts and watches, so they must never join
 * `ENRICHMENT_TASKS` — see docs/metadata-optimize.md for the four reasons.
 */
export type MaintenanceTaskId = 'metadata-optimize' | 'transcode-library' | 'library-sync';

export const MAINTENANCE_TASK_IDS: readonly MaintenanceTaskId[] = [
  'metadata-optimize',
  'transcode-library',
  'library-sync',
];

export interface MaintenanceProgress {
  /** Denominator, fixed at pass start. 0 = unknown (the pass can't count ahead). */
  total: number;
  visited: number;
  /** Human label of the item just visited. */
  label: string;
}

export interface MaintenanceRunContext {
  /** Checked between items; true → stop and report what was done. */
  shouldStop: () => boolean;
  onProgress: (p: MaintenanceProgress) => void;
}

export interface MaintenanceRunResult {
  /** Per-task counters. Rendered generically, so keys are the task's own. */
  detail: Record<string, number>;
  /** True when work may remain (cancelled, or a bound was hit). */
  stopped: boolean;
  errorSample: string | null;
}

export interface MaintenanceTask<P> {
  id: MaintenanceTaskId;
  label: string;
  /** `true` when runnable, else a human reason it can't run right now. */
  available(): true | string;
  /** Parse this task's own query params. Pure — the runner never sees `P`. */
  parseParams(q: URLSearchParams): P;
  /** One-line summary for the audit row + the UI, plus whether it writes. */
  describe(params: P): { summary: string; dryRun: boolean };
  run(ctx: MaintenanceRunContext, params: P): Promise<MaintenanceRunResult>;
}

/**
 * Existential wrapper: the registry is heterogeneous, so `P` is erased at the
 * boundary and each task body stays typed. The cast lives here only.
 */
export interface AnyMaintenanceTask {
  id: MaintenanceTaskId;
  label: string;
  available(): true | string;
  parseParams(q: URLSearchParams): unknown;
  describe(params: unknown): { summary: string; dryRun: boolean };
  run(ctx: MaintenanceRunContext, params: unknown): Promise<MaintenanceRunResult>;
}

function defineTask<P>(t: MaintenanceTask<P>): AnyMaintenanceTask {
  return t as AnyMaintenanceTask;
}

/** `?dryRun=1` / `?dryRun=true`, the parsing the routes have always used. */
function flag(q: URLSearchParams, name: string): boolean {
  const v = q.get(name);
  return v === '1' || v === 'true';
}

function positiveInt(q: URLSearchParams, name: string): number | undefined {
  const n = Number(q.get(name));
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export interface MaintenanceDeps {
  db: Database;
  lidarr: OptimizeLidarr | null;
  musicDir: string;
  coverCacheDir?: string;
  /** Full library scan + curation pass, or null when unavailable. */
  runSync: (() => Promise<void>) | null;
}

export function buildMaintenanceTasks(deps: MaintenanceDeps): AnyMaintenanceTask[] {
  return [
    defineTask<{
      apply: boolean;
      onlyMissingOrPoor: boolean;
      limit?: number;
      afterId?: string | null;
    }>({
      id: 'metadata-optimize',
      label: 'Optimize metadata',
      available: () => (deps.lidarr ? true : 'Lidarr is not configured'),
      parseParams: (q) => ({
        apply: !flag(q, 'dryRun'),
        onlyMissingOrPoor: !flag(q, 'all'),
        limit: positiveInt(q, 'limit'),
        afterId: q.get('after'),
      }),
      describe: (p) => ({
        summary: `${p.apply ? 'apply' : 'dry-run'} ${p.onlyMissingOrPoor ? 'missing-or-poor' : 'all'}`,
        dryRun: !p.apply,
      }),
      run: async (ctx, p) => {
        // `available()` gates this, but the compiler can't see that.
        if (!deps.lidarr) throw new Error('Lidarr is not configured');
        const r = await optimizeAllAlbums(deps.db, deps.lidarr, {
          apply: p.apply,
          onlyMissingOrPoor: p.onlyMissingOrPoor,
          limit: p.limit,
          afterId: p.afterId,
          coverCacheDir: deps.coverCacheDir,
          shouldStop: ctx.shouldStop,
          onProgress: (x) => ctx.onProgress({ total: x.total, visited: x.visited, label: x.label }),
        });
        return {
          stopped: r.stopped,
          errorSample: r.errorSample,
          detail: {
            candidates: r.candidates,
            checked: r.visited,
            lookedUp: r.lookedUp,
            matched: r.matched,
            coversUpdated: r.coversUpdated,
            yearsUpdated: r.yearsUpdated,
            releaseTypesUpdated: r.releaseTypesUpdated,
            failed: r.failed,
          },
        };
      },
    }),

    defineTask<{ apply: boolean; limit?: number }>({
      id: 'transcode-library',
      label: 'Standardize library on Opus',
      available: () => (deps.musicDir ? true : 'Music directory is not configured'),
      parseParams: (q) => ({ apply: !flag(q, 'dryRun'), limit: positiveInt(q, 'limit') }),
      describe: (p) => ({ summary: p.apply ? 'apply' : 'dry-run', dryRun: !p.apply }),
      run: async (ctx, p) => {
        const r = await transcodeLibraryToOpus(deps.db, deps.musicDir, {
          apply: p.apply,
          limit: p.limit,
          shouldStop: ctx.shouldStop,
          onProgress: (x) => ctx.onProgress({ total: x.total, visited: x.visited, label: x.label }),
        });
        return {
          stopped: r.stopped,
          errorSample: r.errorSample,
          detail: {
            candidates: r.candidates,
            converted: r.converted,
            skipped: r.skipped,
            failed: r.failed,
            bytesReclaimed: r.bytesReclaimed,
          },
        };
      },
    }),

    defineTask<Record<string, never>>({
      id: 'library-sync',
      label: 'Rescan library',
      available: () => (deps.runSync ? true : 'Library sync is not available'),
      parseParams: () => ({}),
      describe: () => ({ summary: 'full rescan', dryRun: false }),
      run: async () => {
        if (!deps.runSync) throw new Error('Library sync is not available');
        // The scanner reports no incremental progress (it returns a summary
        // only), so this pass is a running flag: total 0 = unknown.
        await deps.runSync();
        return { detail: {}, stopped: false, errorSample: null };
      },
    }),
  ];
}
