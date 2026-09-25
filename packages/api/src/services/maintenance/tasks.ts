import type { Database } from 'bun:sqlite';
import { optimizeAllAlbums, type OptimizeLidarr } from '../metadata-optimize.js';
import { transcodeLibraryToFormat } from '../library-transcode.js';
import { effectiveLadder, getLibraryFormatSettings } from '../library-format-settings.js';
import { libraryFormat } from '../library-format.js';
import { backfillArtwork, type BackfillLidarr } from '../artwork-backfill.js';
import { embedAlbumArt } from '../opus-art-embed.js';
import { normalizeLibraryLoudness } from '../loudness-normalize.js';
import { finishTranscodeRun, startTranscodeRun } from '../transcode-run-store.js';
import {
  DEFAULT_QUARANTINE_KEEP,
  planQuarantinePrune,
  pruneQuarantine,
} from '../transcode-quarantine.js';
import { type TranscodeLosslessSource } from '../transcode-settings.js';

/**
 * Operator-triggered, whole-library maintenance passes.
 *
 * The deliberate mirror of `EnrichmentTask` (`services/enrichment/tasks.ts`):
 * same `id`/`label`/`available()`/`run()` vocabulary, opposite trigger. Those
 * run unattended inside the nightly window over *songs*; these are destructive
 * library-wide passes an admin starts and watches, so they must never join
 * `ENRICHMENT_TASKS` — see docs/metadata-optimize.md for the four reasons.
 */
export type MaintenanceTaskId =
  | 'metadata-optimize'
  | 'artwork-backfill'
  | 'embed-cover-art'
  | 'normalize-loudness'
  | 'transcode-library'
  | 'prune-quarantine'
  | 'library-sync';

export const MAINTENANCE_TASK_IDS: readonly MaintenanceTaskId[] = [
  'metadata-optimize',
  'artwork-backfill',
  'embed-cover-art',
  'normalize-loudness',
  'transcode-library',
  'prune-quarantine',
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
  lidarr: (OptimizeLidarr & BackfillLidarr) | null;
  musicDir: string;
  /**
   * Data dir, so `transcode-library` can KEEP the originals it replaces.
   * Required, not optional: it was absent here while `transcodeLibraryToFormat`
   * took `dataDir` optionally, so the Admin button silently deleted every
   * original it converted — the one thing quarantine (#1228) exists to stop.
   */
  dataDir: string;
  /**
   * Where the transcode quarantine lives, when it must not be `dataDir`.
   *
   * `dataDir` is routinely on a different — and smaller — filesystem than the
   * library. On kpc it is the host root with 71 GiB free, against 78 GiB of
   * originals, so the default would fill `/`.
   */
  quarantineDir?: string;
  coverCacheDir?: string;
  /** Resolved `downloads.transcodeLossless`, so the Admin task and the download
   *  path encode at the same bitrate. Pass a reader rather than a value: the
   *  setting is admin-editable at runtime (`downloads-settings.ts`), and the
   *  runner outlives any single edit. */
  transcodeLossless: TranscodeLosslessSource;
  /** Full library scan + curation pass, or null when unavailable. */
  runSync: (() => Promise<void>) | null;
  /**
   * Whether `normalize-loudness` is offered at all.
   *
   * **Default off.** RFC 7845 says decoders apply `output_gain`, but Safari
   * only gained Ogg support in iOS 18.4 and nobody has confirmed the gain
   * takes effect there on a real device. Normalizing a library that one of its
   * clients then ignores is a half-normalized library, which is worse than an
   * unnormalized one — so the task stays unavailable, with that reason on
   * screen, until someone flips `NICOTIND_OPUS_HEADER_GAIN`.
   */
  opusHeaderGain: boolean;
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
            tracksNumbered: r.tracksNumbered,
            releaseTypesUpdated: r.releaseTypesUpdated,
            failed: r.failed,
          },
        };
      },
    }),

    // Album/artist artwork was reachable only through scripts/backfill-artwork.ts,
    // so on a real library 2,561 of 4,923 albums sat with no canonical cover and
    // no in-app way to fix it (issue #694). Same trigger shape as the optimizer:
    // operator-started, watchable, cancellable — never an ENRICHMENT_TASK, for the
    // reasons in docs/metadata-optimize.md.
    defineTask<{ apply: boolean; lookupMissing: boolean; albumLookupMinTracks?: number }>({
      id: 'artwork-backfill',
      label: 'Backfill album & artist artwork',
      available: () => (deps.lidarr ? true : 'Lidarr is not configured'),
      parseParams: (q) => ({
        apply: !flag(q, 'dryRun'),
        lookupMissing: flag(q, 'lookupMissing'),
        albumLookupMinTracks: positiveInt(q, 'albumLookupMinTracks'),
      }),
      describe: (p) => ({
        summary: `${p.apply ? 'apply' : 'dry-run'}${p.lookupMissing ? ' +lookup-missing' : ''}`,
        dryRun: !p.apply,
      }),
      run: async (ctx, p) => {
        if (!deps.lidarr) throw new Error('Lidarr is not configured');
        const r = await backfillArtwork(deps.db, deps.lidarr, {
          apply: p.apply,
          coverCacheDir: deps.coverCacheDir,
          lookupMissing: p.lookupMissing,
          albumLookupMinTracks: p.albumLookupMinTracks,
          shouldStop: ctx.shouldStop,
          onProgress: (x) => ctx.onProgress(x),
        });
        return {
          stopped: r.stopped,
          errorSample: null,
          detail: {
            artistsMatched: r.artistsMatched,
            artistsUnresolved: r.artistsUnresolved,
            albumsMatched: r.albumsMatched,
            albumsUnresolved: r.albumsUnresolved,
            albumsLookedUp: r.albumsLookedUp,
            albumLookupMatched: r.albumLookupMatched,
          },
        };
      },
    }),

    defineTask<{ apply: boolean; limit?: number; afterId?: string }>({
      id: 'normalize-loudness',
      label: 'Normalize loudness (header gain)',
      available: () => {
        if (!deps.musicDir) return 'Music directory is not configured';
        // Say WHY the button is off when the chosen format cannot do this,
        // rather than offering a pass that would visit nothing. A selector that
        // silently disables another capability is the trap #1256 names: the
        // loss has no symptom, so it has to be stated where it is noticed.
        const format = getLibraryFormatSettings(deps.db).format;
        const strategy = libraryFormat(format);
        if (strategy.writeGain === null) {
          return (
            `The library format is ${format}, which has no in-header gain field — ` +
            'normalizing it would mean re-encoding the audio. Only Opus can be normalized losslessly.'
          );
        }
        return deps.opusHeaderGain
          ? true
          : 'Off by default — set NICOTIND_OPUS_HEADER_GAIN once the Opus header gain is ' +
              'confirmed to take effect on iOS 18.4+';
      },
      parseParams: (q) => ({
        apply: !flag(q, 'dryRun'),
        limit: positiveInt(q, 'limit'),
        afterId: q.get('after') ?? undefined,
      }),
      describe: (p) => ({ summary: p.apply ? 'apply' : 'dry-run', dryRun: !p.apply }),
      run: async (ctx, p) => {
        const target = getLibraryFormatSettings(deps.db).targetLufs;
        const r = await normalizeLibraryLoudness(deps.db, deps.musicDir, {
          apply: p.apply,
          limit: p.limit,
          afterId: p.afterId,
          format: getLibraryFormatSettings(deps.db).format,
          // Read per run, like the format: the operator can retune it between
          // passes, and a re-run moves every file to the new target (#1255).
          targetLufs: target,
          shouldStop: ctx.shouldStop,
          onProgress: (x) => ctx.onProgress({ total: x.total, visited: x.visited, label: x.label }),
        });
        return {
          stopped: r.stopped,
          errorSample: r.errorSample,
          detail: {
            // Which target this run moved files to — the setting can change between runs.
            targetLufs: target,
            candidates: r.candidates,
            normalized: r.normalized,
            alreadyCorrect: r.alreadyCorrect,
            // A non-zero count here means the loudness analysis has fallen
            // behind, not that those files are fine.
            noMeasurement: r.noMeasurement,
            failed: r.failed,
          },
        };
      },
    }),

    defineTask<{ apply: boolean; limit?: number; afterId?: string; localOnly: boolean }>({
      id: 'embed-cover-art',
      label: 'Embed cover art into Opus files',
      available: () => (deps.musicDir ? true : 'Music directory is not configured'),
      parseParams: (q) => ({
        apply: !flag(q, 'dryRun'),
        limit: positiveInt(q, 'limit'),
        afterId: q.get('after') ?? undefined,
        localOnly: flag(q, 'localOnly'),
      }),
      describe: (p) => ({
        summary: `${p.apply ? 'apply' : 'dry-run'}${p.localOnly ? ', folder art only' : ''}`,
        dryRun: !p.apply,
      }),
      run: async (ctx, p) => {
        const r = await embedAlbumArt(deps.db, deps.musicDir, {
          apply: p.apply,
          limit: p.limit,
          afterId: p.afterId,
          localOnly: p.localOnly,
          shouldStop: ctx.shouldStop,
          onProgress: (x) => ctx.onProgress({ total: x.total, visited: x.visited, label: x.label }),
        });
        return {
          stopped: r.stopped,
          errorSample: r.errorSample,
          detail: {
            albums: r.albums,
            albumsEmbedded: r.albumsEmbedded,
            tracksEmbedded: r.tracksEmbedded,
            // Three different "nothing happened" reasons, kept apart because
            // they need three different fixes: acquire art, fix the folder
            // layout, or reach the host.
            noSource: r.noSource,
            sharedBucket: r.sharedBucket,
            fetchFailed: r.fetchFailed,
            failed: r.failed,
          },
        };
      },
    }),

    defineTask<{ apply: boolean; limit?: number; scope: 'lossless' | 'all' }>({
      id: 'transcode-library',
      label: 'Standardize library on Opus',
      available: () => (deps.musicDir ? true : 'Music directory is not configured'),
      parseParams: (q) => ({
        apply: !flag(q, 'dryRun'),
        limit: positiveInt(q, 'limit'),
        // `?scope=all` converts every non-Opus file, which is a second lossy
        // generation on most of the library. It has to be asked for by name:
        // a bare click stays on the lossless-only scope.
        scope: q.get('scope') === 'all' ? 'all' : 'lossless',
      }),
      describe: (p) => ({
        summary: `${p.apply ? 'apply' : 'dry-run'}, ${p.scope === 'all' ? 'every non-Opus file' : 'lossless only'}`,
        dryRun: !p.apply,
      }),
      run: async (ctx, p) => {
        // Opened BEFORE the first file is touched. A terminal-only record
        // cannot say "this pass was interrupted", because an interrupted pass
        // never reaches the code that would write it.
        // No fixed rate: the pass reads each file's own bitrate through the
        // ladder, because the library's distribution is bimodal and one number
        // is wrong for most of it either way. `0` on the run row means exactly
        // that — adaptive, not "zero kbps".
        const runId = startTranscodeRun(deps.db, {
          apply: p.apply,
          bitRate: 0,
          startedBy: 'maintenance',
        });
        // Read per run, not captured at construction: the operator can change
        // the target and its ladder between runs (#1256, #1255).
        const settings = getLibraryFormatSettings(deps.db);
        try {
          const r = await transcodeLibraryToFormat(deps.db, deps.musicDir, {
            apply: p.apply,
            limit: p.limit,
            scope: p.scope,
            format: settings.format,
            ladder: effectiveLadder(settings, settings.format),
            // Keep every original under `<dataDir>/quarantine/<run>/`. A
            // whole-library re-encode is irreversible and unattended; the disk
            // cost is recoverable, a wrong conversion is not.
            dataDir: deps.dataDir,
            quarantineDir: deps.quarantineDir,
            shouldStop: ctx.shouldStop,
            onProgress: (x) =>
              ctx.onProgress({ total: x.total, visited: x.visited, label: x.label }),
          });
          finishTranscodeRun(deps.db, runId, {
            state: 'done',
            quarantineRun: r.quarantineRun ?? null,
            candidates: r.candidates,
            converted: r.converted,
            skipped: r.skipped,
            failed: r.failed,
            bytesReclaimed: r.bytesReclaimed,
            error: r.errorSample,
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
              // Surfaced so a dry-run figure is never read as exact when part
              // of the set could not be estimated.
              unestimated: r.unestimated,
              quarantineRunsHeld: r.quarantineRunsHeld ?? 0,
            },
          };
        } catch (err) {
          // A throw here means the pass died before returning counters — a
          // preflight refusal, most likely. Record that rather than leaving a
          // row the boot sweep would later call "interrupted", which would be
          // a different and wrong story.
          finishTranscodeRun(deps.db, runId, {
            state: 'failed',
            candidates: 0,
            converted: 0,
            skipped: 0,
            failed: 0,
            bytesReclaimed: 0,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
    }),

    defineTask<{ apply: boolean; keep: number }>({
      id: 'prune-quarantine',
      label: 'Delete old transcode quarantine runs',
      available: () =>
        deps.dataDir || deps.quarantineDir ? true : 'Data directory is not configured',
      // Deleting originals is the one irreversible thing here, so unlike the
      // other tasks a bare POST is a dry run: it takes `?apply=1` (#1260).
      parseParams: (q) => ({
        apply: flag(q, 'apply'),
        keep: positiveInt(q, 'keep') ?? DEFAULT_QUARANTINE_KEEP,
      }),
      describe: (p) => ({
        summary: `${p.apply ? 'apply' : 'dry-run'}, keep newest ${p.keep}`,
        dryRun: !p.apply,
      }),
      run: async (ctx, p) => {
        const dir = deps.quarantineDir ?? deps.dataDir;
        const { held, doomed } = planQuarantinePrune(dir, p.keep);
        // The run names are the answer to "what will this delete", so they go
        // through `lastItems` before anything is removed.
        doomed.forEach((name, i) =>
          ctx.onProgress({ total: doomed.length, visited: i + 1, label: name }),
        );
        const pruned = p.apply ? pruneQuarantine(dir, p.keep) : 0;
        return {
          stopped: false,
          errorSample: p.apply && pruned < doomed.length ? 'some runs could not be removed' : null,
          detail: { runsHeld: held.length, runsToPrune: doomed.length, runsPruned: pruned },
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
