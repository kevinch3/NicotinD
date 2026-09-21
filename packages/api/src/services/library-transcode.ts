import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import {
  isLossless,
  isLosslessFile,
  transcodeToOpus,
  TRANSCODE_CONCURRENCY,
} from './post-download-transcode.js';
import { ffmpegAvailable } from './transcode.js';
import { LibraryScanner, mapPool, songId } from './library-scanner.js';
import { carrySongCuration } from './song-curation-carry.js';
import { refreshAlbumAggregate } from './library-aggregates.js';
import { checkHeadroom, type StatfsFn } from './disk-space.js';
// Lives with the bitrate ladder it estimates against.
export { estimateOpusBytes } from './transcode-bitrate.js';
import { estimateOpusBytes, opusBitrateFor } from './transcode-bitrate.js';
import {
  createQuarantineRun,
  pruneQuarantine,
  DEFAULT_QUARANTINE_KEEP,
} from './transcode-quarantine.js';

const log = createLogger('library-transcode');

/**
 * Free space the pass insists on beyond the largest single candidate.
 *
 * Matches `IMPORT_DISK_MARGIN_BYTES`: the same disk, the same reason, and a
 * number chosen to leave the DB and its WAL room to breathe rather than to
 * model the run.
 */
const TRANSCODE_DISK_MARGIN_BYTES = 500 * 1024 * 1024;

/**
 * Files encoded before the pass stops to migrate their identities.
 *
 * The organizer runs its three-phase split over one directory at a time, so it
 * can encode the whole batch and then migrate it. This pass runs over the whole
 * library — 13,864 files on prod — and doing the same would hold every output
 * on disk before freeing a single original, hours before the first progress
 * event, with no useful `shouldStop` granularity. So the split is applied to a
 * window instead.
 *
 * Four times the pool depth: big enough that a slow file stalls the pool only
 * briefly at the batch boundary, small enough that the extra disk held is one
 * batch of encodes rather than a library of them.
 */
const ENCODE_BATCH = TRANSCODE_CONCURRENCY * 4;

/** Split into fixed-size windows, the last one short. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface LibraryTranscodeResult {
  /** Lossless rows considered. */
  candidates: number;
  converted: number;
  skipped: number;
  failed: number;
  /**
   * On apply, bytes actually freed. On a dry run, the **estimated** difference
   * between each original and the Opus encode that would replace it — never the
   * original's whole size, which would assume the output is empty.
   */
  bytesReclaimed: number;
  /**
   * Dry-run only: candidates whose duration is unknown, so no saving could be
   * estimated for them and none was counted. Non-zero means `bytesReclaimed` is
   * a floor rather than an estimate, and the run is that many files larger than
   * the figure suggests.
   */
  unestimated: number;
  /** First failure message, for surfacing without a log dive. */
  errorSample: string | null;
  /** True when work may remain — cancelled, or the limit filled a full page. */
  stopped: boolean;
  /**
   * Where the replaced originals were kept, when the caller asked for that.
   * Absent on a dry run, on a pass with no candidates, or when no `dataDir`
   * was given — i.e. when the originals were deleted.
   */
  quarantineRun?: string;
}

/** Cumulative progress, emitted after each file. */
export interface TranscodeProgress {
  total: number;
  visited: number;
  /** Relative path of the file just visited. */
  label: string;
  result: LibraryTranscodeResult;
}

export interface TranscodeAllOptions {
  apply: boolean;
  /**
   * One fixed rate for every file, overriding the source-adaptive ladder.
   *
   * The pass defaults to {@link opusBitrateFor}, which reads each file's own
   * bitrate — the library's distribution is bimodal, so a single number is
   * wrong in one direction or the other for most of it. This exists for
   * callers that genuinely want one rate, and for tests that assert on a known
   * one.
   */
  bitRate?: number;
  /** Max files to visit. Omitted/<=0 → unbounded. */
  limit?: number;
  /** Checked before each file; true → stop and return the partial counters. */
  shouldStop?: () => boolean;
  /** Injected for tests; defaults to the real `statfs`. */
  statfs?: StatfsFn;
  /**
   * Data dir. When given, each replaced original is **kept** under
   * `<dataDir>/quarantine/<run>/` instead of being unlinked, and older runs are
   * pruned to `quarantineKeep`. Omit only where losing the source is
   * acceptable; for a whole-library backfill it is not (#1226 is what an
   * irreversible pass costs when something was missed).
   */
  dataDir?: string;
  /** Quarantine runs to keep. Count-based, never time-based. */
  quarantineKeep?: number;
  onProgress?: (p: TranscodeProgress) => void;
}

interface SongRow {
  id: string;
  album_id: string | null;
  path: string;
  suffix: string | null;
  size: number | null;
  /** Seconds. `0` means the scanner could not read one — see `estimateOpusBytes`. */
  duration: number | null;
  /** Source kbps. `0` means probe failure, which the ladder reads as unknown. */
  bit_rate: number | null;
  starred: string | null;
  hidden: number;
}

/**
 * Convert the **existing** library's lossless files (FLAC/WAV/…) to Opus in
 * place, mirroring the post-download standardization. Already-lossy files are
 * left untouched.
 *
 * Re-encoding changes a file's extension → its relative path → its derived
 * `songId` and `acquisitions` key. Album-keyed data (artwork, release-meta,
 * classification) is keyed on the tag-derived `albumId` and survives; song-keyed
 * data does not, so per file we **migrate identity**: `scanPaths` inserts the
 * new opus row, then one transaction drops the stale lossless row, carries
 * `starred`/`hidden` onto the new one, hands the rest to `carrySongCuration`
 * and recomputes the album aggregate.
 *
 * The scan runs before the delete, and the delete inside the transaction,
 * because the reverse lost songs: a scan that threw left the old row deleted
 * and the new one never inserted, with nothing to report it.
 */
export async function transcodeLibraryToOpus(
  db: Database,
  musicDir: string,
  opts: TranscodeAllOptions,
): Promise<LibraryTranscodeResult> {
  const result: LibraryTranscodeResult = {
    candidates: 0,
    converted: 0,
    skipped: 0,
    failed: 0,
    bytesReclaimed: 0,
    unestimated: 0,
    errorSample: null,
    stopped: false,
  };
  if (opts.apply && !ffmpegAvailable()) {
    throw new Error('ffmpeg is required to transcode the library but was not found on PATH');
  }

  const allRows = db
    .query<SongRow, []>(
      `SELECT id, album_id, path, suffix, size, duration, bit_rate, starred, hidden
         FROM library_songs`,
    )
    .all();
  const limit = opts.limit != null && opts.limit > 0 ? opts.limit : -1;
  const rows: SongRow[] = [];
  for (const r of allRows) {
    if (limit > 0 && rows.length >= limit) break;
    if (isLossless(r.suffix) || isLossless(r.path.split('.').pop() ?? '')) {
      rows.push(r);
      continue;
    }
    // .m4a-family rows need a codec probe: ALAC (lossless, browser-undecodable)
    // shares the extension with lossy AAC. Probe only files that exist.
    const ext = (r.path.split('.').pop() ?? '').toLowerCase();
    if (['m4a', 'm4b', 'mp4'].includes(ext)) {
      const abs = join(musicDir, r.path);
      if (existsSync(abs) && (await isLosslessFile(abs))) rows.push(r);
    }
  }
  result.candidates = rows.length;

  const scanner = new LibraryScanner(musicDir, db);
  // Per file, not per pass: a 320 kbps source and a 128 kbps source want
  // different rates, and the library holds thousands of each.
  const rateFor = (r: SongRow): number =>
    opts.bitRate ?? opusBitrateFor(r.bit_rate, isLossless(r.suffix ?? ''));

  // Headroom preflight. The pass writes each Opus file beside its source before
  // removing the original, so peak usage is one encode above steady state — but
  // the pass is long, unattended, and shares a disk that has already filled to
  // zero once and taken the API down with it (#1021). A margin is cheap.
  //
  // Fails OPEN by construction: an unprobeable filesystem returns `free: null`
  // and `sufficient: true`. Unknown is not full, and a preflight that refuses to
  // run on a mount it cannot stat is worse than no preflight.
  if (opts.apply && rows.length > 0) {
    // Keeping the originals inverts the arithmetic. Normally each output
    // replaces its source, so peak usage is one encode above steady state and
    // the run ends smaller. With quarantine on, nothing is freed — every
    // output is added while every original is still held — so the requirement
    // is the whole projected output, not one file's worth.
    //
    // (A same-filesystem quarantine move is a rename and costs nothing extra
    // for the original itself; a cross-filesystem one briefly costs a copy.
    // Either way the outputs are new bytes that no deletion offsets.)
    //
    // Without quarantine the peak scales with the POOL, not the batch: each
    // encode unlinks its own source as soon as the output verifies, so the
    // extra bytes in flight are one encode per worker rather than a whole
    // batch. Taking the largest candidate that many times over is a bound, not
    // an estimate, which is the right side to err on here.
    const keepingOriginals = Boolean(opts.dataDir);
    const need = keepingOriginals
      ? rows.reduce((n, r) => n + (estimateOpusBytes(r.duration, rateFor(r)) ?? r.size ?? 0), 0)
      : rows.reduce((n, r) => Math.max(n, r.size ?? 0), 0) * TRANSCODE_CONCURRENCY;
    const head = checkHeadroom(musicDir, need, {
      margin: TRANSCODE_DISK_MARGIN_BYTES,
      statfs: opts.statfs,
    });
    if (!head.sufficient) {
      throw new Error(
        `Not enough free space in ${musicDir}: ${head.free} bytes free, ` +
          `${head.required} needed (` +
          (keepingOriginals ? 'whole projected output, originals kept' : 'one encode per worker') +
          ` + margin).`,
      );
    }
    if (head.free === null) {
      log.warn({ musicDir }, 'could not probe free space — proceeding without a headroom check');
    }
  }

  // One run dir for the whole pass, created only when there is something to
  // convert — an empty pass should not leave an empty backup behind.
  let quarantineRun: string | null = null;
  if (opts.apply && opts.dataDir && rows.length > 0) {
    quarantineRun = createQuarantineRun(opts.dataDir);
    log.info({ quarantineRun, candidates: rows.length }, 'originals will be kept, not deleted');
  }

  let visited = 0;
  // Counted HERE rather than when a row is picked up, because the pooled phase
  // starts a whole batch before any of it finishes: incrementing at pick-up
  // time reports the batch as done the moment it begins. Every row emits
  // exactly once — skipped, dry-run, failed or converted — so this stays one
  // per file and monotonic.
  //
  // `result` is mutated for the whole pass, so a live reference handed to a
  // caller shows whatever the counters happen to be when it looks. Snapshot.
  const emit = (label: string) => {
    visited += 1;
    opts.onProgress?.({ total: rows.length, visited, label, result: { ...result } });
  };

  for (const batch of chunk(rows, ENCODE_BATCH)) {
    // Checked per BATCH, not per row. Stopping between the encode and the
    // migration would leave an .opus file on disk that no library row points
    // at — and, with quarantine on, its original already moved away. Every
    // encode this pass starts is therefore always migrated.
    if (opts.shouldStop?.()) {
      result.stopped = true;
      break;
    }

    // --- phase 1, serial: decide what this batch actually encodes -----------
    const encodable: SongRow[] = [];
    for (const row of batch) {
      const abs = join(musicDir, row.path);
      if (!existsSync(abs)) {
        log.warn({ path: row.path }, 'lossless row points at a missing file — skipping');
        result.skipped += 1;
        emit(row.path);
        continue;
      }
      if (!opts.apply) {
        result.converted += 1; // dry-run: report what would be converted
        // The DIFFERENCE, matching the apply path below. This used to add the
        // whole original size, i.e. it assumed the Opus file would be zero
        // bytes — so the figure the operator sizes the run against was always
        // too high by the size of every resulting file, and the CLI's
        // "reclaimed≈" read as rounding rather than as a bug.
        const estimated = estimateOpusBytes(row.duration, rateFor(row));
        if (estimated !== null) {
          result.bytesReclaimed += Math.max(0, (row.size ?? 0) - estimated);
        } else {
          result.unestimated += 1;
        }
        emit(row.path);
        continue;
      }
      encodable.push(row);
    }
    if (encodable.length === 0) continue;

    // --- phase 2, pooled: the encodes, which own nothing shared -------------
    // Each writes its own hidden temp path and touches no DB. `mapPool` uses
    // `Promise.all`, which rejects on the first throw and loses every sibling
    // result, so this catches internally and returns an outcome instead.
    const encoded = await mapPool(encodable, TRANSCODE_CONCURRENCY, async (row) => {
      const abs = join(musicDir, row.path);
      try {
        const oldSize = statSync(abs).size;
        const newAbs = await transcodeToOpus(
          abs,
          rateFor(row),
          quarantineRun ? { runDir: quarantineRun, musicDir } : undefined,
        );
        return { row, ok: true as const, newAbs, oldSize };
      } catch (err) {
        return { row, ok: false as const, err };
      }
    });

    // --- phase 3, serial: the identity migration, which owns the library ----
    // `scanPaths` reads whole-DB state outside a transaction and recomputes
    // album aggregates from it, so two concurrent calls lose song counts for
    // any album with two files converted at once. Widening the transaction
    // would not fix it: the read set is the whole library. Serial is the fix.
    for (const outcome of encoded) {
      const row = outcome.row;
      if (!outcome.ok) {
        log.warn({ err: outcome.err, path: row.path }, 'library transcode failed — original kept');
        result.failed += 1;
        result.errorSample ??=
          outcome.err instanceof Error ? outcome.err.message : String(outcome.err);
        emit(row.path);
        continue;
      }
      try {
        const newRel = outcome.newAbs
          .slice(musicDir.length)
          .replace(/^[/\\]+/, '')
          .replace(/\\/g, '/');
        const newId = songId(newRel);
        const newSize = existsSync(outcome.newAbs) ? statSync(outcome.newAbs).size : 0;

        // Scan the new file in FIRST, then drop the stale row and carry
        // curation in one transaction.
        //
        // The delete used to run before the scan and outside the transaction,
        // so a scan that threw left the old row gone and the new one never
        // inserted — the song simply vanished until the next full rescan, with
        // nothing to say so. Ordering it this way means either both rows exist
        // briefly or neither changes, and the album aggregate is refreshed
        // explicitly rather than relying on the scan seeing a library the
        // delete had already adjusted.
        await scanner.scanPaths([newRel]);

        db.transaction(() => {
          db.run('DELETE FROM library_songs WHERE id = ?', [row.id]);
          // Carry curation forward onto the new song id.
          db.run('UPDATE library_songs SET starred = ?, hidden = ? WHERE id = ?', [
            row.starred,
            row.hidden,
            newId,
          ]);
          carrySongCuration(db, {
            fromId: row.id,
            toId: newId,
            fromPath: row.path,
            toPath: newRel,
          });
          // The scan counted both rows; recount now the stale one is gone.
          if (row.album_id) refreshAlbumAggregate(db, row.album_id);
        })();

        result.converted += 1;
        result.bytesReclaimed += Math.max(0, outcome.oldSize - newSize);
      } catch (err) {
        // The re-encode succeeded but the identity migration threw. Count it
        // and carry on: before #622 this rejected the pass and lost every
        // counter.
        log.warn({ err, path: row.path }, 'library transcode migration failed; continuing');
        result.failed += 1;
        result.errorSample ??= err instanceof Error ? err.message : String(err);
      }
      emit(row.path);
    }
  }
  if (limit > 0 && rows.length === limit) result.stopped = true;

  // Prune AFTER the pass, never before: the run that just finished is the one
  // most worth keeping, and pruning first could drop it to make room for
  // itself. Failure here costs disk, not correctness, so it never fails the
  // pass.
  if (quarantineRun && opts.dataDir) {
    result.quarantineRun = quarantineRun;
    try {
      pruneQuarantine(opts.dataDir, opts.quarantineKeep ?? DEFAULT_QUARANTINE_KEEP);
    } catch (err) {
      log.warn({ err }, 'quarantine prune failed; originals are still kept');
    }
  }

  log.info({ ...result, apply: opts.apply }, 'library transcode pass complete');
  return result;
}
