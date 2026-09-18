import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * slskd only moves a file out of its `incomplete` directory when the transfer
 * COMPLETES, so every transfer that dies mid-flight leaks a partial there — and
 * that directory sits on the Docker data root, the filesystem that filled to
 * 0 bytes and took Lidarr, the API and the separator down (#1021). 418 MB had
 * accumulated since 2026-05 before `retention.files.incomplete` was set (#1145).
 *
 * The retention window itself cannot be set from the environment: slskd binds
 * env vars from an explicit [EnvironmentVariable] allowlist rather than by `__`
 * nesting, and its retention options carry no such attribute. The variable here
 * is read by scripts/slskd-configure.sh and rendered into slskd.yml, so this
 * test also pins the wiring that makes it reach slskd at all.
 */
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const compose = parse(readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8')) as {
  services: Record<string, { environment?: Record<string, string>; volumes?: string[] }>;
};

const slskd = compose.services.slskd!;
const env = slskd.environment ?? {};
const volumes = slskd.volumes ?? [];

describe('slskd prunes its own incomplete dir', () => {
  it('sets a retention window', () => {
    expect(env.SLSKD_INCOMPLETE_RETENTION_MINUTES).toBeDefined();
  });

  it('sets a window slskd will accept — it validates Range(30, int.MaxValue)', () => {
    const minutes = Number(env.SLSKD_INCOMPLETE_RETENTION_MINUTES);
    expect(Number.isInteger(minutes)).toBe(true);
    expect(minutes).toBeGreaterThanOrEqual(30);
  });

  it('mounts the script that renders the window into slskd.yml', () => {
    // Without this mount the entrypoint aborts and slskd never starts, so a
    // dropped line fails loudly — but it must not be dropped silently here.
    expect(volumes).toContain('./scripts/slskd-configure.sh:/slskd-configure.sh:ro');
  });
});

describe('the incomplete dir is configured through a binding that exists', () => {
  it('names the directory with the variable slskd actually reads', () => {
    expect(env.SLSKD_INCOMPLETE_DIR).toBe('/app/incomplete');
  });

  it('does not reintroduce the `__`-nested spelling, which slskd ignores', () => {
    // `SLSKD_DIRECTORIES__INCOMPLETE` sat here for months doing nothing; it
    // matched only because `<app-dir>/incomplete` is already the default, so
    // the config looked effective while being inert (#1145).
    expect(Object.keys(env).filter((k) => k.includes('__'))).toEqual([]);
  });
});

describe('core never prunes the addon-owned staging dir', () => {
  it('leaves retention.files.complete unset everywhere', () => {
    // `retention.files.complete` prunes directories.downloads — which is
    // /data/music/.downloads, the acquisition addon's staging dir. The addon
    // owns and sweeps those bytes itself (#1052, addon#10/#19); a second
    // sweeper would race it and delete files it had not released yet.
    // Anchored on a word boundary on purpose: an unanchored `COMPLETE` also
    // matches the INCOMPLETE variable two lines above, which is how the first
    // version of this test failed against a correct compose file.
    expect(Object.keys(env).filter((k) => /(^|_)COMPLETE(_|$)/.test(k))).toEqual([]);
  });

  it('keeps the pruned dir off the shared music volume', () => {
    // If the incomplete dir ever moves under /data/music it becomes the
    // scanner's and the addon's problem too, and the share-filters would have
    // to cover it.
    expect(env.SLSKD_INCOMPLETE_DIR!.startsWith('/data/music')).toBe(false);
  });
});
