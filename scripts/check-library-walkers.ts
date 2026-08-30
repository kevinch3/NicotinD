/**
 * Fail when a module walks `musicDir` without consulting the shared reserved-path
 * predicate.
 *
 *   bun run check:library-walkers
 *
 * WHY: "this directory is not library content" used to be an *implicit* property
 * — asserted nowhere, enforced by nothing, and independently re-derived by every
 * walker. The slskd addon was configured to download into `/data/music`, the tree
 * `LibraryScanner` walks, so every album landed twice: once organized and
 * transcoded, once as the raw peer folder scanned in place. 27.5 GB of it before
 * anyone noticed (#827).
 *
 * Consolidating onto `library-paths.ts` fixes today. This gate is what stops
 * walker #14 from re-deriving the rule and quietly losing the exclusion again —
 * the same way `check:shared-helpers` stops copy #33 of `expandHome`.
 *
 * Per the project rule that a gate must assert its own denominator
 * (docs/quality-gates.md): this prints how many modules it examined, fails on any
 * candidate it cannot classify, and checks the allowlist in both directions so a
 * stale exemption is an error rather than silent slack.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { Glob } from 'bun';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

/** The module every musicDir walker must consult. */
const CANONICAL = 'library-paths';

/** Anything that enumerates directory entries. */
const WALK_CALL = /\b(readdirSync|readdir|opendirSync|opendir)\s*\(/;

/** A module is a candidate when it walks *and* talks about the music dir. */
const MUSIC_DIR = /\bmusicDir\b/;

/**
 * Modules that walk and mention musicDir but legitimately need no exclusion.
 * Each entry carries the reason — an exemption without one is how a gate turns
 * into decoration. Checked both ways: an entry that no longer matches the
 * candidate set is a failure, not a no-op.
 */
const ALLOWLIST: Record<string, string> = {
  'packages/api/src/services/import-scan.ts':
    'walks an import SOURCE dir, not musicDir; already skips dot entries at every depth',
  'packages/api/src/services/library-import.service.ts':
    'its readdir is an empty-dir check while pruning, not a library walk',
  'packages/api/src/services/library-deletion.ts':
    'walks one album dir handed to it by the caller, never the musicDir root',
  'packages/api/src/services/library-organizer.ts':
    'writes INTO reserved dirs by design; placement is guarded by unsortedRoot',
  'packages/api/src/routes/streaming.ts':
    'folderCover() reads one album dir for cover art; never walks the musicDir root',
  'packages/api/src/scripts/repair-pollution.ts':
    'gets its file list from scanMusicDir(), which applies the predicate',
};

function main(): void {
  const candidates: string[] = [];
  const offenders: string[] = [];

  for (const pattern of ['packages/*/src/**/*.ts', 'scripts/**/*.ts', 'src/**/*.ts']) {
    for (const file of new Glob(pattern).scanSync(repoRoot)) {
      if (file.includes('node_modules') || /\.(test|spec)\.ts$/.test(file)) continue;
      const rel = relative(repoRoot, resolve(repoRoot, file)).replace(/\\/g, '/');
      const src = readFileSync(resolve(repoRoot, file), 'utf-8');
      if (!WALK_CALL.test(src) || !MUSIC_DIR.test(src)) continue;

      candidates.push(rel);
      if (rel in ALLOWLIST) continue;
      if (!src.includes(CANONICAL)) offenders.push(rel);
    }
  }

  const stale = Object.keys(ALLOWLIST).filter((f) => !candidates.includes(f));

  console.log(
    `check:library-walkers: ${candidates.length} modules walk musicDir; ` +
      `${Object.keys(ALLOWLIST).length} allowlisted, ${offenders.length} unguarded.`,
  );

  if (stale.length > 0) {
    console.error(
      `\nAllowlist entries that no longer walk musicDir (remove them):\n` +
        stale.map((f) => `  - ${f}`).join('\n'),
    );
  }

  if (offenders.length > 0) {
    console.error(
      `\nThese walk musicDir without importing '${CANONICAL}':\n` +
        offenders.map((f) => `  - ${f}`).join('\n') +
        `\n\nImport isReservedTopLevel/isHiddenFile from services/library-paths.js and skip\n` +
        `reserved top-level dirs, or add an allowlist entry with a reason.\n` +
        `→ docs/library-path-conventions.md`,
    );
  }

  if (offenders.length > 0 || stale.length > 0) process.exit(1);
}

if (import.meta.main) main();
