import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * A GitHub release-CDN outage (2026-11-08, hours of 504s) failed every PR on tool
 * downloads, not on code, and stopped `ci` before its tests ran (#1746). See
 * docs/quality-gates.md "A release-CDN outage must not block a merge".
 */
const repoRoot = join(import.meta.dir, '..');
const helper = join(repoRoot, '.github/scripts/ci-tool-fetch.sh');

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
}
const ci = parse(readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, { steps?: Step[] }>;
};

describe('ci_tool_fetch', () => {
  let dir: string;
  let sha: string;
  const fetch = (file: string, url: string, hash: string) =>
    spawnSync('bash', ['-c', `source "${helper}" && ci_tool_fetch "$@"`, '_', file, url, hash], {
      cwd: dir,
      env: { ...process.env, HOME: join(dir, 'home'), CI_TOOL_FETCH_RETRIES: '0' },
      encoding: 'utf8',
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ci-tool-fetch-'));
    writeFileSync(join(dir, 'src.tgz'), 'tool-bytes');
    sha = createHash('sha256').update('tool-bytes').digest('hex');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('downloads on a miss and verifies the pinned checksum', () => {
    const r = fetch('t.tgz', `file://${join(dir, 'src.tgz')}`, sha);
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, 't.tgz'), 'utf8')).toBe('tool-bytes');
  });

  it('serves a verified cached copy with no network at all', () => {
    expect(fetch('t.tgz', `file://${join(dir, 'src.tgz')}`, sha).status).toBe(0);
    rmSync(join(dir, 'src.tgz'));
    rmSync(join(dir, 't.tgz'));
    const r = fetch('t.tgz', 'file:///nonexistent/never.tgz', sha);
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, 't.tgz'), 'utf8')).toBe('tool-bytes');
  });

  it('fails closed when the cache is wrong and the download fails', () => {
    expect(fetch('t.tgz', `file://${join(dir, 'src.tgz')}`, sha).status).toBe(0);
    const r = fetch('t.tgz', 'file:///nonexistent/never.tgz', '0'.repeat(64));
    expect(r.status).not.toBe(0);
  });

  it('fails closed when a download does not match the pinned checksum', () => {
    const r = fetch('t.tgz', `file://${join(dir, 'src.tgz')}`, '0'.repeat(64));
    expect(r.status).not.toBe(0);
  });
});

describe('ci.yml tool downloads (#1746)', () => {
  const steps = ci.jobs['ci']!.steps!;
  const idx = (pred: (s: Step) => boolean) => steps.findIndex(pred);

  it('runs both tool downloads after the test steps, through the cached fetch', () => {
    const lastTest = Math.max(...steps.map((s, i) => (/^Test\b/.test(s.name ?? '') ? i : -1)));
    expect(lastTest).toBeGreaterThan(0);
    for (const name of ['Lint GitHub Actions workflows', 'Secret scan']) {
      const i = idx((s) => s.name === name);
      expect(i, `${name} runs after the tests`).toBeGreaterThan(lastTest);
      expect(steps[i]!.run).toContain('ci_tool_fetch');
      expect(steps[i]!.run).not.toMatch(/^\s*curl /m);
    }
    expect(idx((s) => s.name === 'Cache CI tool binaries')).toBeGreaterThan(lastTest);
  });

  it('desktop-package hands a cached ffmpeg back through FFMPEG_BIN and recovers a miss', () => {
    const pkg = ci.jobs['desktop-package']!.steps!;
    const cache = pkg.find((s) => s.name === 'Cache the ffmpeg-static binary');
    expect(cache?.with?.path).toBe('~/.cache/nicotind-ffmpeg');
    expect(pkg.find((s) => s.name === 'Use the cached ffmpeg binary')?.run).toContain(
      'FFMPEG_BIN=',
    );
    const ensure = pkg.findIndex((s) => (s.name ?? '').startsWith('Ensure the ffmpeg binary'));
    const stage = pkg.findIndex((s) => /prepare-resources/.test(s.run ?? ''));
    expect(ensure).toBeGreaterThan(-1);
    expect(ensure).toBeLessThan(stage);
  });

  it('desktop-smoke caches the Electron download', () => {
    const smoke = ci.jobs['desktop-smoke']!.steps!;
    expect(smoke.find((s) => s.name === 'Cache the Electron download')?.with?.path).toBe(
      '~/.cache/electron',
    );
  });
});
