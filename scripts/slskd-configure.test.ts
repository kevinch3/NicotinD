import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const script = resolve(repoRoot, 'scripts/slskd-configure.sh');

let dir: string;
let config: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'slskd-configure-'));
  config = resolve(dir, 'slskd.yml');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Runs the REAL entrypoint config script — not a re-implementation of it. */
function run(minutes?: string) {
  const env: Record<string, string> = { ...process.env, SLSKD_CONFIG_FILE: config };
  if (minutes === undefined) delete env.SLSKD_INCOMPLETE_RETENTION_MINUTES;
  else env.SLSKD_INCOMPLETE_RETENTION_MINUTES = minutes;
  return spawnSync('bash', [script], { env, encoding: 'utf-8' });
}

const read = () => readFileSync(config, 'utf-8');

describe('slskd-configure renders the shares slskd needs', () => {
  test('writes a fresh config when none exists', () => {
    expect(run().status).toBe(0);
    expect(parse(read()).shares.directories).toEqual(['/data/music']);
  });

  test('replaces an empty share list left by slskd', () => {
    writeFileSync(config, 'shares:\n  directories: []\n');
    expect(run().status).toBe(0);
    expect(parse(read()).shares.directories).toEqual(['/data/music']);
  });

  test('appends shares to a config that has none', () => {
    writeFileSync(config, 'soulseek:\n  username: someone\n');
    expect(run().status).toBe(0);
    expect(parse(read()).shares.directories).toEqual(['/data/music']);
  });
});

describe('slskd-configure sets the incomplete-file retention window', () => {
  // #1145: slskd only moves a file out of `incomplete` when the transfer
  // COMPLETES, so every dead transfer leaks a partial onto the Docker data
  // root. `retention.files.incomplete` defaults to null (disabled), which is
  // why 418 MB accumulated there since 2026-05.
  test('defaults to 30 days when the variable is unset', () => {
    expect(run().status).toBe(0);
    expect(parse(read()).retention.files.incomplete).toBe(43200);
  });

  test('honours an explicit window', () => {
    expect(run('10080').status).toBe(0);
    expect(parse(read()).retention.files.incomplete).toBe(10080);
  });

  // slskd's own binding is an [EnvironmentVariable] allowlist and retention
  // carries no attribute, so the YAML file is the only route that works.
  test('produces a config slskd can parse, not just text we appended', () => {
    run();
    const parsed = parse(read());
    expect(parsed.retention.files.incomplete).toBe(43200);
    expect(parsed.shares.directories).toEqual(['/data/music']);
  });
});

describe('slskd-configure never prunes the addon-owned staging dir', () => {
  // `retention.files.complete` prunes directories.downloads — which is
  // /data/music/.downloads, the acquisition addon's staging dir. The addon
  // owns and sweeps those bytes itself (#1052); a second sweeper would race
  // it and delete files it had not released yet.
  test('sets `incomplete` and never `complete`', () => {
    run();
    const files = parse(read()).retention.files;
    expect(Object.keys(files)).toEqual(['incomplete']);
  });

  test('the script never mentions retention.files.complete at all', () => {
    expect(readFileSync(script, 'utf-8')).not.toMatch(/^\s*complete:/m);
  });
});

describe('slskd-configure is safe to re-run', () => {
  // The container restarts on deploy, and slskd runs with
  // --remote-configuration=true, so this file is rewritten behind us.
  test('running twice leaves exactly one retention block', () => {
    run();
    const once = read();
    run();
    expect(read()).toBe(once);
    expect(read().match(/^retention:/gm)).toHaveLength(1);
  });

  test('a changed window replaces the old value rather than stacking', () => {
    run('43200');
    run('10080');
    expect(read().match(/^retention:/gm)).toHaveLength(1);
    expect(parse(read()).retention.files.incomplete).toBe(10080);
  });

  test('preserves the credentials slskd stores in the same file', () => {
    // The real /app/slskd.yml holds the operator's Soulseek login. Anything
    // that rewrites the whole file would log the instance out.
    writeFileSync(config, 'soulseek:\n  username: someone\n  password: a-secret\n');
    run();
    run('10080');
    const parsed = parse(read());
    expect(parsed.soulseek).toEqual({ username: 'someone', password: 'a-secret' });
  });

  test('appends cleanly to a file with no trailing newline', () => {
    writeFileSync(config, 'soulseek:\n  username: someone');
    expect(run().status).toBe(0);
    expect(parse(read()).soulseek.username).toBe('someone');
    expect(parse(read()).retention.files.incomplete).toBe(43200);
  });
});

describe('slskd-configure defers to an operator and refuses a bad window', () => {
  test('leaves an unmanaged retention key alone', () => {
    writeFileSync(config, 'retention:\n  files:\n    incomplete: 60\n');
    const r = run('43200');
    expect(r.status).toBe(0);
    expect(parse(read()).retention.files.incomplete).toBe(60);
    expect(r.stderr).toMatch(/unmanaged/);
  });

  test.each(['0', 'off', ''])('%p disables retention and removes our block', (value) => {
    run('43200');
    expect(read()).toMatch(/^retention:/m);
    expect(run(value).status).toBe(0);
    expect(read()).not.toMatch(/^retention:/m);
    expect(parse(read()).shares.directories).toEqual(['/data/music']);
  });

  // A typo that silently left retention off is exactly how #1145 went
  // unnoticed for four months, and slskd itself validates Range(30, ...).
  test.each(['abc', '29', '-5', '10.5'])('%p fails loudly instead of booting', (value) => {
    const r = run(value);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/SLSKD_INCOMPLETE_RETENTION_MINUTES/);
    expect(read()).not.toMatch(/^retention:/m);
  });
});

describe('the entrypoint runs the config script before starting slskd', () => {
  test('slskd-entrypoint.sh calls it, then execs slskd', () => {
    const entrypoint = readFileSync(resolve(repoRoot, 'scripts/slskd-entrypoint.sh'), 'utf-8');
    const configureAt = entrypoint.indexOf('/slskd-configure.sh');
    const execAt = entrypoint.indexOf('exec ');
    expect(configureAt).toBeGreaterThan(-1);
    expect(execAt).toBeGreaterThan(configureAt);
  });

  test('the script is executable, since compose mounts it as the entrypoint', () => {
    expect(existsSync(script)).toBe(true);
    expect(spawnSync('test', ['-x', script]).status).toBe(0);
  });
});
