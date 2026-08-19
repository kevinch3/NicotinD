/**
 * LibraryImportService tests against real fs (temp dirs) with a fake organizer
 * seam: the fake consumes staged files the way LibraryOrganizer does (move to
 * the library / unlink a dup-skip / leave a failure in place) so the
 * disk-truth deletion + rollback rules are exercised for real.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { applySchema } from '../db.js';
import type { CompletedDownloadFile } from './path-inference.js';
import type { OrganizeResult } from './library-organizer.js';
import { setProcessingSettings } from './processing-settings.js';
import { armReviewHold, getReviewDecision } from './download-review-store.js';
import { albumIdFor } from './library-scanner.js';
import {
  ImportAlreadyRunningError,
  ImportEmptySourceError,
  ImportInsufficientSpaceError,
  ImportSourceInvalidError,
  LibraryImportService,
  importStagingDir,
} from './library-import.service.js';
import { createImportJob, getImportJob, updateImportJob } from './import-job-store.js';
import { deflateRawSync, crc32 } from 'node:zlib';

let db: Database;
let root: string;
let sourceDir: string;
let musicDir: string;
let dataDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  root = mkdtempSync(join(tmpdir(), 'library-import-'));
  sourceDir = join(root, 'source');
  musicDir = join(root, 'music');
  dataDir = join(root, 'data');
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(musicDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(rel: string, content = `audio:${rel}`): string {
  const abs = join(sourceDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

type FileBehavior = 'move' | 'skip' | 'unsorted' | 'fail';

/**
 * Fake organizeBatch honouring the real contract: staged inputs are consumed
 * (moved/unlinked) except failures, and `file.relativePath` is mutated in
 * place for files that landed.
 */
function fakeOrganize(behavior: (file: CompletedDownloadFile) => FileBehavior = () => 'move') {
  const calls: CompletedDownloadFile[][] = [];
  const organize = async (files: CompletedDownloadFile[]): Promise<OrganizeResult> => {
    calls.push(files.map((f) => ({ ...f })));
    const result: OrganizeResult = {
      moved: 0,
      skipped: 0,
      unsorted: 0,
      failed: 0,
      dedupedBasenames: [],
      deletedRelPaths: [],
      affectedAlbumDirs: [],
    };
    for (const f of files) {
      const b = behavior(f);
      if (b === 'move') {
        const rel = `Artist/Album/${basename(f.filename)}`;
        const dest = join(musicDir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        renameSync(f.filename, dest);
        f.relativePath = rel;
        result.moved += 1;
      } else if (b === 'skip') {
        rmSync(f.filename);
        f.relativePath = null;
        result.skipped += 1;
      } else if (b === 'unsorted') {
        rmSync(f.filename);
        f.relativePath = null;
        result.unsorted += 1;
      } else {
        result.failed += 1;
      }
    }
    return result;
  };
  return { organize, calls };
}

interface ServiceOverrides {
  organize?: (files: CompletedDownloadFile[]) => Promise<OrganizeResult>;
  scan?: (relPaths: string[]) => Promise<void>;
  acquisitionEnabled?: () => boolean;
  statfs?: (path: string) => { bsize: number; blocks: number; bavail: number };
}

function makeService(overrides: ServiceOverrides = {}) {
  const scanned: string[][] = [];
  const service = new LibraryImportService({
    db,
    dataDir,
    musicDir,
    organizeBatch: overrides.organize ?? fakeOrganize().organize,
    scanIncremental:
      overrides.scan ??
      (async (relPaths) => {
        scanned.push(relPaths);
      }),
    acquisitionEnabled: overrides.acquisitionEnabled ?? (() => true),
    statfs: overrides.statfs ?? (() => ({ bsize: 4096, blocks: 1e9, bavail: 1e9 })),
  });
  return { service, scanned };
}

async function waitForTerminal(service: LibraryImportService, id: string) {
  for (let i = 0; i < 200; i++) {
    const job = service.getJob(id)!;
    if (job.state !== 'queued' && job.state !== 'running') return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('import never finished');
}

describe('submit validation', () => {
  it('rejects invalid sources with typed errors', () => {
    const { service } = makeService();
    expect(() => service.submit(join(root, 'nope'))).toThrow(ImportSourceInvalidError);
    expect(() => service.submit(musicDir)).toThrow(ImportSourceInvalidError);
    expect(() => service.submit(sourceDir)).toThrow(ImportEmptySourceError);
  });

  it('refuses when the destination filesystem is too small (copy mode)', () => {
    seed('Album/one.mp3');
    const { service } = makeService({ statfs: () => ({ bsize: 1, blocks: 10, bavail: 10 }) });
    expect(() => service.submit(sourceDir)).toThrow(ImportInsufficientSpaceError);
  });

  it('allows only one import at a time', () => {
    seed('Album/one.mp3');
    // Construct first: the constructor's boot pass orphans pre-existing rows.
    const { service } = makeService();
    createImportJob(db, {
      id: 'other',
      sourcePath: '/elsewhere',
      removeOriginals: false,
      filesTotal: 1,
      bytesTotal: 1,
      startedBy: null,
    });
    expect(() => service.submit(sourceDir)).toThrow(ImportAlreadyRunningError);
  });
});

describe('copy import (default)', () => {
  it('imports end-to-end, leaves originals byte-identical, records provenance', async () => {
    const one = seed('Artist/Album/01 one.mp3');
    const two = seed('Artist/Album/02 two.mp3');
    const fake = fakeOrganize();
    const { service, scanned } = makeService({ organize: fake.organize });
    const id = service.submit(sourceDir, { startedBy: 'admin-1' });
    const job = await waitForTerminal(service, id);

    expect(job.state).toBe('done');
    expect(job.error).toBeNull();
    expect(job.summary).toEqual({
      imported: 2,
      skippedDuplicate: 0,
      unsorted: 0,
      failed: 0,
      removedOriginals: 0,
    });
    // Originals untouched.
    expect(readFileSync(one, 'utf8')).toBe('audio:Artist/Album/01 one.mp3');
    expect(existsSync(two)).toBe(true);
    // Library got the files; scan saw them.
    expect(existsSync(join(musicDir, 'Artist/Album/01 one.mp3'))).toBe(true);
    expect(scanned.flat().sort()).toEqual(['Artist/Album/01 one.mp3', 'Artist/Album/02 two.mp3']);
    // Provenance points at the ORIGINAL path, method 'import'.
    const prov = db
      .query<{ method: string; source_ref: string }, [string]>(
        `SELECT method, source_ref FROM acquisitions WHERE relative_path = ?`,
      )
      .get('Artist/Album/01 one.mp3');
    expect(prov).toEqual({ method: 'import', source_ref: one });
    // Destination album derived; mirror row carries it for Open in Library.
    expect(job.destinationAlbums).toEqual([
      { albumArtist: 'Artist', albumTitle: 'Album', albumId: albumIdFor('Artist', 'Album') },
    ]);
    const mirror = db
      .query<{ state: string; stage: string; artist_name: string }, [string]>(
        `SELECT state, stage, artist_name FROM acquisition_jobs WHERE id = ?`,
      )
      .get(id);
    expect(mirror).toEqual({ state: 'done', stage: 'done', artist_name: 'Artist' });
    // Staging fully cleaned.
    expect(existsSync(importStagingDir(dataDir, id))).toBe(false);
  });

  it('tallies duplicates and reports zero-imported as done-with-warning', async () => {
    seed('Album/dup.mp3');
    const fake = fakeOrganize(() => 'skip');
    const { service } = makeService({ organize: fake.organize });
    const id = service.submit(sourceDir);
    const job = await waitForTerminal(service, id);
    expect(job.state).toBe('done');
    expect(job.summary?.skippedDuplicate).toBe(1);
    expect(job.summary?.imported).toBe(0);
    expect(job.error).toContain('no tracks were added');
  });
});

describe('move mode', () => {
  it('removes consumed originals, keeps failed ones, prunes empty source dirs', async () => {
    const ok = seed('Artist/Good/one.mp3');
    const dup = seed('Artist/Good/two.mp3');
    const bad = seed('Artist/Bad/broken.mp3');
    const fake = fakeOrganize((f) =>
      basename(f.filename) === 'broken.mp3'
        ? 'fail'
        : basename(f.filename) === 'two.mp3'
          ? 'skip'
          : 'move',
    );
    const { service } = makeService({ organize: fake.organize });
    const id = service.submit(sourceDir, { removeOriginals: true });
    const job = await waitForTerminal(service, id);

    expect(job.state).toBe('done');
    // Consumed (moved or dup-skipped) originals are gone; the failed one is back.
    expect(existsSync(ok)).toBe(false);
    expect(existsSync(dup)).toBe(false);
    expect(existsSync(bad)).toBe(true);
    expect(job.summary?.removedOriginals).toBe(2);
    expect(job.summary?.failed).toBe(1);
    // The emptied album dir is pruned; the source root itself survives.
    expect(existsSync(join(sourceDir, 'Artist/Good'))).toBe(false);
    expect(existsSync(sourceDir)).toBe(true);
  });

  it('rolls staged files back to the source when the whole chunk fails', async () => {
    const one = seed('Album/one.mp3');
    const { service } = makeService({
      organize: async () => {
        throw new Error('organizer exploded');
      },
    });
    const id = service.submit(sourceDir, { removeOriginals: true });
    const job = await waitForTerminal(service, id);
    expect(job.state).toBe('failed');
    expect(existsSync(one)).toBe(true);
    expect(service.getJobDirs(id).map((d) => d.state)).toEqual(['failed']);
    expect(existsSync(importStagingDir(dataDir, id))).toBe(false);
  });
});

describe('cancel + retry', () => {
  it('cancel between chunks stops the run and leaves later dirs pending', async () => {
    // >200 files per dir would be unwieldy; instead force per-dir chunks by
    // seeding two dirs and cancelling from inside the first organize call.
    // The first chunk runs before submit() returns, so the wrapper recovers
    // the job id from the organizer contract's `import:<id>` username.
    for (let i = 0; i < 150; i++) seed(`A/${i}.mp3`);
    for (let i = 0; i < 150; i++) seed(`B/${i}.mp3`);
    let svc: LibraryImportService | null = null;
    const fake = fakeOrganize();
    const { service } = makeService({
      organize: async (files) => {
        svc!.cancel(files[0]!.username.replace(/^import:/, ''));
        return fake.organize(files);
      },
    });
    svc = service;
    const jobId = service.submit(sourceDir);
    const job = await waitForTerminal(service, jobId);
    expect(job.state).toBe('cancelled');
    const dirs = service.getJobDirs(jobId);
    expect(dirs.find((d) => d.sourceDir === 'A')?.state).toBe('done');
    expect(dirs.find((d) => d.sourceDir === 'B')?.state).toBe('pending');
  });

  it('retry re-runs only non-done dirs', async () => {
    for (let i = 0; i < 150; i++) seed(`A/${i}.mp3`);
    for (let i = 0; i < 150; i++) seed(`B/${i}.mp3`);
    const fake = fakeOrganize();
    let bBroken = true;
    const { service } = makeService({
      organize: async (files) => {
        // First run: chunk B throws so its dirs mark failed; retry heals it.
        if (bBroken && files.some((f) => f.directory === 'B')) throw new Error('peer B broke');
        return fake.organize(files);
      },
    });
    const id = service.submit(sourceDir);
    let job = await waitForTerminal(service, id);
    expect(job.state).toBe('done');
    expect(job.error).toContain('failed to import');
    expect(service.getJobDirs(id).find((d) => d.sourceDir === 'B')?.state).toBe('failed');

    // Second attempt: everything works. Only B may be re-organized.
    bBroken = false;
    const retried = service.retry(id);
    expect(retried).toBe(id);
    job = await waitForTerminal(service, id);
    expect(job.state).toBe('done');
    expect(service.getJobDirs(id).every((d) => d.state === 'done')).toBe(true);
    // The retry organized ONLY dir B — A's done marker skipped it.
    const retryCalls = fake.calls.slice(1);
    expect(retryCalls).toHaveLength(1);
    expect(retryCalls[0]!.every((f) => f.directory === 'B')).toBe(true);
  });
});

describe('review-hold pre-approval', () => {
  it('pre-approves destination albums while the hold is armed and acquisition is on', async () => {
    setProcessingSettings(db, { holdForReview: true });
    armReviewHold(db);
    const { service } = makeService();
    seed('Album/one.mp3');
    const id = service.submit(sourceDir, { startedBy: 'admin-1' });
    await waitForTerminal(service, id);
    const decision = getReviewDecision(db, albumIdFor('Artist', 'Album'));
    expect(decision?.state).toBe('approved');
    expect(decision?.reviewedBy).toBe('import:admin-1');
  });

  it('writes no decision when acquisition is off (hold is inert, issue #416)', async () => {
    setProcessingSettings(db, { holdForReview: true });
    armReviewHold(db);
    const { service } = makeService({ acquisitionEnabled: () => false });
    seed('Album/one.mp3');
    const id = service.submit(sourceDir);
    await waitForTerminal(service, id);
    expect(getReviewDecision(db, albumIdFor('Artist', 'Album'))).toBeNull();
  });
});

describe('boot recovery', () => {
  it('fails orphaned jobs and restores their move-mode staged files', () => {
    createImportJob(db, {
      id: 'orphan',
      sourcePath: sourceDir,
      removeOriginals: true,
      filesTotal: 1,
      bytesTotal: 10,
      startedBy: null,
    });
    updateImportJob(db, 'orphan', { state: 'running' });
    // A file stranded mid-move in staging (its original is gone from source).
    const staged = join(importStagingDir(dataDir, 'orphan'), 'Album/one.mp3');
    mkdirSync(dirname(staged), { recursive: true });
    writeFileSync(staged, 'stranded');

    makeService();

    const job = getImportJob(db, 'orphan')!;
    expect(job.state).toBe('failed');
    expect(job.error).toContain('Retry');
    expect(readFileSync(join(sourceDir, 'Album/one.mp3'), 'utf8')).toBe('stranded');
    expect(existsSync(importStagingDir(dataDir, 'orphan'))).toBe(false);
  });
});

/* ── Archive sources (docs/import.md "Archives as import sources") ──────── */

/** Minimal ZIP writer; the reader's own suite covers the exotic shapes. */
function zipFixture(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const body = deflateRawSync(e.data);
    const nameBuf = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(e.data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, body);
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(e.data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function seedZip(name = 'Album.zip'): string {
  const path = join(root, name);
  writeFileSync(
    path,
    zipFixture([
      { name: 'Album/01 - One.mp3', data: Buffer.from('audio:one') },
      { name: 'Album/02 - Two.mp3', data: Buffer.from('audio:two') },
    ]),
  );
  return path;
}

describe('archive import', () => {
  it('extracts straight into staging and hands the organizer only staged paths', async () => {
    const fake = fakeOrganize();
    const { service } = makeService({ organize: fake.organize });
    const zip = seedZip();
    const id = service.submit(zip);
    const job = await waitForTerminal(service, id);

    expect(job.state).toBe('done');
    expect(job.summary?.imported).toBe(2);
    const staged = fake.calls.flat().map((f) => f.filename);
    expect(staged).toHaveLength(2);
    for (const path of staged) {
      expect(path.startsWith(importStagingDir(dataDir, id))).toBe(true);
    }
    // The extracted bytes are the archive's, not a copy of some other file.
    expect(readFileSync(join(musicDir, 'Artist/Album/01 - One.mp3'), 'utf8')).toBe('audio:one');
  });

  it('groups by the directory inside the archive, so albums stay together', async () => {
    const fake = fakeOrganize();
    const { service } = makeService({ organize: fake.organize });
    const id = service.submit(seedZip());
    await waitForTerminal(service, id);
    expect(fake.calls[0]!.map((f) => f.directory)).toEqual(['Album', 'Album']);
  });

  /** The entry has no independent existence on disk, so the ref names both. */
  it('records provenance as <archive>!<entry>', async () => {
    const { service } = makeService();
    const zip = seedZip();
    const id = service.submit(zip);
    await waitForTerminal(service, id);
    const refs = db
      .query<{ source_ref: string }, []>(`SELECT source_ref FROM acquisitions`)
      .all()
      .map((r) => r.source_ref);
    expect(refs).toContain(`${zip}!Album/01 - One.mp3`);
  });

  it('names the Downloads card by the archive stem, not "Album.zip"', async () => {
    const { service } = makeService();
    const id = service.submit(seedZip('Bootleg Rips 2019.zip'));
    // Asserted at submit, before the run finishes: a single-album import later
    // clears the placeholder so the card can upgrade to the real album, and
    // asserting only "does not contain .zip" at the end would be satisfied by
    // the null that clearing produces — i.e. it would pass with the whole
    // display-title derivation deleted.
    const atSubmit = db
      .query<{ display_title: string | null }, [string]>(
        `SELECT display_title FROM acquisition_jobs WHERE id = ?`,
      )
      .get(id)!;
    expect(atSubmit.display_title).toBe('Bootleg Rips 2019');
    await waitForTerminal(service, id);
  });

  /**
   * Copy-vs-move has no meaning per file here: extraction always materializes
   * new bytes, so the full uncompressed size must be free even in move mode.
   *
   * The free space is set to the margin plus a little — enough for a same-device
   * folder move (which reserves only the margin) and NOT enough once the
   * source's bytes are added. So this fails if, and only if, the
   * archive-forces-cross-device rule is present; a `bavail: 1` fixture would
   * have thrown either way and proven nothing.
   */
  it('reserves the full uncompressed size even in move mode', () => {
    const headroom = 500 * 1024 * 1024 + 8; // IMPORT_DISK_MARGIN_BYTES + 8 bytes
    const statfs = () => ({ bsize: 1, blocks: headroom, bavail: headroom });

    // Control: a same-device folder move under the same free space is allowed,
    // because it only renames bytes around.
    seed('Album/01.mp3', 'audio:one');
    seed('Album/02.mp3', 'audio:two');
    expect(() =>
      makeService({ statfs }).service.submit(sourceDir, { removeOriginals: true }),
    ).not.toThrow();

    // The archive, whose 18 uncompressed bytes exceed the 8 spare, is refused.
    expect(() =>
      makeService({ statfs }).service.submit(seedZip(), { removeOriginals: true }),
    ).toThrow(ImportInsufficientSpaceError);
  });

  it('deletes the archive itself in move mode, only after everything landed', async () => {
    const { service } = makeService();
    const zip = seedZip();
    const id = service.submit(zip, { removeOriginals: true });
    const job = await waitForTerminal(service, id);
    expect(job.state).toBe('done');
    expect(existsSync(zip)).toBe(false);
    expect(job.summary?.removedOriginals).toBe(1);
  });

  it('keeps the archive when anything was left unconsumed', async () => {
    const { service } = makeService({ organize: fakeOrganize(() => 'fail').organize });
    const zip = seedZip();
    const id = service.submit(zip, { removeOriginals: true });
    await waitForTerminal(service, id);
    expect(existsSync(zip)).toBe(true);
  });

  /**
   * `rollbackStaging` renames staged files to `join(sourceRoot, rel)`; with an
   * archive that root is a FILE, so an unguarded rollback would write paths
   * derived from it. It must be inert.
   */
  it('never writes next to the archive when a chunk fails in move mode', async () => {
    const { service } = makeService({
      organize: async () => {
        throw new Error('organize blew up');
      },
    });
    const zip = seedZip();
    const id = service.submit(zip, { removeOriginals: true });
    await waitForTerminal(service, id);
    expect(existsSync(`${zip}/Album`)).toBe(false);
    expect(existsSync(zip)).toBe(true);
  });

  /**
   * The guard is at the path-minting site, so a hostile entry cannot even
   * produce a staging path — never mind be opened.
   */
  it('refuses a traversing entry rather than staging it outside the job dir', async () => {
    const path = join(root, 'evil.zip');
    writeFileSync(path, zipFixture([{ name: '../../../etc/evil.mp3', data: Buffer.from('pwn') }]));
    const { service } = makeService();
    // The scan drops it before it can ever be staged, so the job has nothing
    // to import at all — which is the correct outcome, not a partial success.
    expect(() => service.submit(path)).toThrow(ImportEmptySourceError);
    expect(existsSync(join(root, 'etc', 'evil.mp3'))).toBe(false);
  });

  it('previews an archive with its uncompressed byte total and archive kind', () => {
    const { service } = makeService();
    const preview = service.preview(seedZip());
    expect(preview.sourceKind).toBe('archive');
    expect(preview.files).toBe(2);
    expect(preview.bytes).toBe('audio:one'.length + 'audio:two'.length);
  });

  it('refuses a file that is not a supported archive', () => {
    const notAnArchive = join(root, 'notes.txt');
    writeFileSync(notAnArchive, 'hello');
    const { service } = makeService();
    expect(() => service.submit(notAnArchive)).toThrow(ImportSourceInvalidError);
  });

  it('refuses a .zip that is not really a zip, with a typed code', () => {
    const fake = join(root, 'broken.zip');
    writeFileSync(fake, 'definitely not a zip archive');
    const { service } = makeService();
    try {
      service.submit(fake);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('ARCHIVE_UNREADABLE');
    }
  });
});
