import { describe, expect, it } from 'bun:test';
import { isDryRun } from './normalize-library-args.js';

describe('normalize-library flag parsing', () => {
  it('is a dry run when nothing is passed', () => {
    // The whole point of #1237. This script took `--dry-run` as the opt-IN, so
    // the documented bare invocation unlinked library files while every sibling
    // script with the same shape only printed.
    expect(isDryRun([])).toBe(true);
  });

  it('writes only when --apply is passed', () => {
    expect(isDryRun(['--apply'])).toBe(false);
    expect(isDryRun(['--phase=A', '--apply'])).toBe(false);
  });

  it('still honours the old --dry-run spelling', () => {
    // Redundant now, but a saved command or a habit must not start writing.
    expect(isDryRun(['--dry-run'])).toBe(true);
  });

  it('does not treat a lookalike flag as --apply', () => {
    expect(isDryRun(['--applyx'])).toBe(true);
    expect(isDryRun(['--no-apply'])).toBe(true);
  });
});
