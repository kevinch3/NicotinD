/**
 * Fail when a production caller of `transcodeLibraryToOpus` does not keep the
 * originals it replaces.
 *
 *   bun run check:transcode-quarantine
 *
 * WHY: quarantine shipped in #1228 — every replaced original moved under
 * `<dataDir>/quarantine/<run>/` instead of being unlinked — and then **neither
 * production caller used it**. `dataDir` was an optional field on
 * `TranscodeAllOptions`, the Admin maintenance task had no `dataDir` in its
 * deps at all, and `convert-library.ts` computed one for the database path and
 * simply never passed it. So the feature was live, tested, documented, and
 * unreachable: both paths deleted every file they converted.
 *
 * That is the failure mode this gate exists for. It is invisible from the
 * inside — the pass logs success, the counters are right, the tests pass, and
 * the only symptom is that a 13,864-file irreversible conversion has no undo.
 *
 * DENOMINATOR: this counts the call sites it examined and prints it. A gate
 * that silently matched nothing — a rename, a re-export, a wrapper — would
 * report the same clean line as a gate that checked every caller, so finding
 * **zero** call sites is itself a failure.
 */
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { Glob } from 'bun';

const repoRoot = resolve(import.meta.dir, '..');

/** The pass whose callers decide the originals' fate. */
const CALLEE = 'transcodeLibraryToOpus';

/** What a caller must pass so the originals are kept rather than unlinked. */
const KEEPS_ORIGINALS = /\bdataDir\s*:/;

/**
 * Callers that legitimately delete. Each carries its reason — an exemption
 * without one is how a gate turns into decoration. Checked both ways: an entry
 * that no longer calls the pass is a failure, not a no-op.
 */
const ALLOWLIST: Record<string, string> = {};

function main(): void {
  const callers: string[] = [];
  const offenders: string[] = [];

  for (const pattern of ['packages/*/src/**/*.ts', 'scripts/**/*.ts', 'src/**/*.ts']) {
    for (const file of new Glob(pattern).scanSync(repoRoot)) {
      if (file.includes('node_modules') || /\.(test|spec)\.ts$/.test(file)) continue;
      const rel = relative(repoRoot, resolve(repoRoot, file)).replace(/\\/g, '/');
      // This file names the call it looks for, so scanning itself is a false
      // positive by construction.
      if (rel === 'scripts/check-transcode-quarantine.ts') continue;
      const src = readFileSync(resolve(repoRoot, file), 'utf-8');

      // The definition is not a call site, and neither is a bare re-export.
      const call = src.indexOf(`${CALLEE}(`);
      if (call < 0) continue;
      if (new RegExp(`(export\\s+)?async\\s+function\\s+${CALLEE}\\b`).test(src)) continue;

      callers.push(rel);
      if (rel in ALLOWLIST) continue;

      // The options object is the argument that decides this, and it is the
      // last one. Reading to the end of the statement is enough: these calls
      // are `await transcodeLibraryToOpus(db, dir, { ... })` and the field
      // cannot be hiding anywhere else in the expression.
      const end = src.indexOf('});', call);
      const args = src.slice(call, end < 0 ? src.length : end);
      if (!KEEPS_ORIGINALS.test(args)) offenders.push(rel);
    }
  }

  const stale = Object.keys(ALLOWLIST).filter((f) => !callers.includes(f));

  console.log(
    `check:transcode-quarantine: ${callers.length} production call site(s); ` +
      `${Object.keys(ALLOWLIST).length} allowlisted, ${offenders.length} deleting originals.`,
  );

  if (callers.length === 0) {
    console.error(
      `\nFAIL: found no call site of ${CALLEE} at all.\n` +
        '  A gate that matches nothing reports the same clean line as one that\n' +
        '  checked every caller. If the function was renamed or moved, update\n' +
        '  CALLEE here in the same commit.',
    );
    process.exit(1);
  }

  if (stale.length > 0) {
    console.error(
      `\nFAIL: ${stale.length} allowlist entr(ies) no longer call ${CALLEE}:\n` +
        stale.map((f) => `  - ${f}`).join('\n') +
        '\n  Remove them; a stale exemption hides the next real one.',
    );
    process.exit(1);
  }

  if (offenders.length > 0) {
    console.error(
      `\nFAIL: ${offenders.length} caller(s) convert without keeping the originals:\n` +
        offenders.map((f) => `  - ${f}`).join('\n') +
        `\n\n  Pass \`dataDir\` so each replaced original lands under\n` +
        '  `<dataDir>/quarantine/<run>/`. A whole-library re-encode is\n' +
        '  irreversible and unattended: the disk is recoverable, the audio is not.\n' +
        '  If a caller genuinely must delete, add it to ALLOWLIST with the reason.',
    );
    process.exit(1);
  }
}

main();
