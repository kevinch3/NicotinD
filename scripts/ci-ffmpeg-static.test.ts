import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

/**
 * Every CI job's `bun install` ran ffmpeg-static's install script, which downloads a
 * binary from a GitHub release — a transient outage there failed `web-test` (#1087).
 * Only `desktop-package` ever stages that binary. See docs/quality-gates.md.
 */
const repoRoot = join(import.meta.dir, '..');
interface Step {
  run?: string;
}
interface Job {
  env?: Record<string, string>;
  steps?: Step[];
}
const ci = parse(readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8')) as {
  env?: Record<string, string>;
  jobs: Record<string, Job>;
};

const effectiveFfmpegBin = (job: Job): string | undefined =>
  job.env && 'FFMPEG_BIN' in job.env ? job.env.FFMPEG_BIN : ci.env?.FFMPEG_BIN;
const stagesFfmpeg = (job: Job): boolean =>
  (job.steps ?? []).some((s) => /prepare-resources|desktop dist|stage-icons/.test(s.run ?? ''));

describe('CI installs do not download the ffmpeg-static binary (issue #1087)', () => {
  it('sets a workflow-wide FFMPEG_BIN sentinel', () => {
    expect(ci.env?.FFMPEG_BIN).toBe('/bin/false');
  });

  it('has at least one job that stages the binary (the denominator)', () => {
    expect(Object.values(ci.jobs).filter(stagesFfmpeg).length).toBeGreaterThan(0);
  });

  for (const [name, job] of Object.entries(ci.jobs)) {
    if (!stagesFfmpeg(job)) continue;
    it(`${name} stages ffmpeg, so it clears the sentinel and gets the real download`, () => {
      expect(effectiveFfmpegBin(job)).toBe('');
    });
  }

  it('every other job keeps the sentinel', () => {
    const cleared = Object.entries(ci.jobs)
      .filter(([, job]) => !stagesFfmpeg(job) && !effectiveFfmpegBin(job))
      .map(([name]) => name);
    expect(cleared).toEqual([]);
  });

  it("ffmpeg-static's installer really skips the network when FFMPEG_BIN names a file", () => {
    const req = createRequire(join(repoRoot, 'packages/desktop/package.json'));
    const installer = join(dirname(req.resolve('ffmpeg-static/package.json')), 'install.js');
    // An unreachable proxy: if the script tried to download, it would fail.
    const res = spawnSync(process.execPath, [installer], {
      env: { ...process.env, FFMPEG_BIN: '/bin/false', HTTPS_PROXY: 'http://127.0.0.1:9' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(res.stdout + res.stderr).toContain('installed already');
    expect(res.status).toBe(0);
  });
});
