import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * The slskd release compose runs, and what it changed for us. 0.26 added
 * download retries that resume the partial file (on by default: 3 attempts,
 * 5–60 s, transient failures only) and turned on a disk logger. The retries
 * are wanted; the disk logger would write a second copy of `docker logs` into
 * /app — the Docker data root that filled to 0 bytes once (#1021).
 * → docs/library-path-conventions.md "slskd version"
 */
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const compose = parse(readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8')) as {
  services: Record<string, { image?: string; environment?: Record<string, string> }>;
};
const slskd = compose.services.slskd!;

describe('slskd version', () => {
  it('runs 0.26.2, pinned by digest as well as tag', () => {
    expect(slskd.image).toMatch(/^slskd\/slskd:0\.26\.2@sha256:[0-9a-f]{64}$/);
  });

  it('keeps the disk logger off, as it was before 0.26.1 turned it on', () => {
    expect(slskd.environment?.SLSKD_NO_DISK_LOGGER).toBe('true');
  });
});
