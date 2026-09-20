/**
 * Flag parsing for `normalize-library.ts`, in its own module so it can be
 * tested.
 *
 * The script calls `main()` at import, so a test that imported it would run a
 * whole library normalization. That is also why the bug this fixes went
 * unnoticed: nothing could assert the default mode without triggering the thing
 * the default mode does.
 */

/**
 * True when the run must not write.
 *
 * **Dry run unless `--apply`**, matching every other script in this repo. This
 * one took `--dry-run` as the opt-IN, so a bare invocation — the one the
 * options header and `docs/library-audit.md` both show — unlinked library files
 * while reading exactly like its dry-by-default siblings (#1237).
 *
 * `--dry-run` is still accepted so an existing habit or saved command keeps
 * working. It is now redundant rather than load-bearing, which is the safe
 * direction for a flag to change meaning in: every invocation that used to be
 * a dry run still is, and the ones that used to write now ask first.
 */
export function isDryRun(argv: readonly string[]): boolean {
  return !argv.includes('--apply');
}
