import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import { isLossless, isLosslessFile, transcodeToOpus } from './post-download-transcode.js';
import { ffmpegAvailable } from './transcode.js';
import { LibraryScanner, songId } from './library-scanner.js';
import { carrySongCuration } from './song-curation-carry.js';
import { refreshAlbumAggregate } from './library-aggregates.js';
import { checkHeadroom, type StatfsFn } from './disk-space.js';
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
  /** Required: a backfill must not invent a bitrate the download path disagrees with. */
  bitRate: number;
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
  starred: string | null;
  hidden: number;
}

/**
 * Bytes a `bitRate`-kbps Opus encode of `seconds` audio will occupy.
 *
 * kbps is decimal kilobits per second, so one second is `bitRate * 1000 / 8`
 * bytes — i.e. `bitRate * 125`.
 *
 * Returns `null` when the duration is unknown (`0`, the column's default when
 * the scanner could not read one). A dry run then counts **no** reclaim for
 * that file rather than guessing: under-reporting a saving is recoverable,
 * over-reporting one is what this function exists to stop.
 */
export function estimateOpusBytes(seconds: number | null, bitRate: number): number | null {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * bitRate * 125);
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
      `SELECT id, album_id, path, suffix, size, duration, starred, hidden FROM library_songs`,
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
  const bitRate = opts.bitRate;

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
    const keepingOriginals = Boolean(opts.dataDir);
    const need = keepingOriginals
      ? rows.reduce((n, r) => n + (estimateOpusBytes(r.duration, bitRate) ?? r.size ?? 0), 0)
      : rows.reduce((n, r) => Math.max(n, r.size ?? 0), 0);
    const head = checkHeadroom(musicDir, need, {
      margin: TRANSCODE_DISK_MARGIN_BYTES,
      statfs: opts.statfs,
    });
    if (!head.sufficient) {
      throw new Error(
        `Not enough free space in ${musicDir}: ${head.free} bytes free, ` +
          `${head.required} needed (largest candidate + margin).`,
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
  for (const row of rows) {
    if (opts.shouldStop?.()) {
      result.stopped = true;
      break;
    }
    visited += 1;
    const abs = join(musicDir, row.path);
    const emit = () => opts.onProgress?.({ total: rows.length, visited, label: row.path, result });
    if (!existsSync(abs)) {
      log.warn({ path: row.path }, 'lossless row points at a missing file — skipping');
      result.skipped += 1;
      emit();
      continue;
    }
    if (!opts.apply) {
      result.converted += 1; // dry-run: report what would be converted
      // The DIFFERENCE, matching the apply path below. This used to add the
      // whole original size, i.e. it assumed the Opus file would be zero bytes
      // — so the figure the operator sizes the run against was always too high
      // by the size of every resulting file, and the CLI's "reclaimed≈" read as
      // rounding rather than as a bug.
      const estimated = estimateOpusBytes(row.duration, bitRate);
      if (estimated !== null) {
        result.bytesReclaimed += Math.max(0, (row.size ?? 0) - estimated);
      } else {
        result.unestimated += 1;
      }
      emit();
      continue;
    }

    let newAbs: string;
    let oldSize = 0;
    try {
      oldSize = statSync(abs).size;
      newAbs = await transcodeToOpus(
        abs,
        bitRate,
        quarantineRun ? { runDir: quarantineRun, musicDir } : undefined,
      );
    } catch (err) {
      log.warn({ err, path: row.path }, 'library transcode failed — original kept');
      result.failed += 1;
      result.errorSample ??= err instanceof Error ? err.message : String(err);
      emit();
      continue;
    }

    try {
      const newRel = newAbs
        .slice(musicDir.length)
        .replace(/^[/\\]+/, '')
        .replace(/\\/g, '/');
      const newId = songId(newRel);
      const newSize = existsSync(newAbs) ? statSync(newAbs).size : 0;

      // Scan the new file in FIRST, then drop the stale row and carry curation
      // in one transaction.
      //
      // The delete used to run before the scan and outside the transaction, so
      // a scan that threw left the old row gone and the new one never inserted
      // — the song simply vanished until the next full rescan, with nothing to
      // say so. Ordering it this way means either both rows exist briefly or
      // neither changes, and the album aggregate is refreshed explicitly rather
      // than relying on the scan seeing a library the delete had already
      // adjusted.
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
      result.bytesReclaimed += Math.max(0, oldSize - newSize);
    } catch (err) {
      // The re-encode succeeded but the identity migration threw. Count it and
      // carry on: before #622 this rejected the pass and lost every counter.
      log.warn({ err, path: row.path }, 'library transcode migration failed; continuing');
      result.failed += 1;
      result.errorSample ??= err instanceof Error ? err.message : String(err);
    }
    emit();
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
