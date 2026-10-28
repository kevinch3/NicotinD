import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A tag is mutable: whoever controls the repository can repoint `oven/bun:1.3.14` at
 * different bytes. Every third-party image is therefore pinned by digest and Renovate
 * (`docker:pinDigests`) moves the digest through a reviewed PR. The first-party
 * `ghcr.io/kevinch3/*` images are the project's own release channel (`:release`,
 * `${NICOTIND_VERSION}`): pinning them would freeze every install, so they are the
 * one explicit exemption (docs/dependency-management.md "Image digests").
 */
const root = join(import.meta.dir, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const FIRST_PARTY = 'ghcr.io/kevinch3/';
const DIGEST = /@sha256:[0-9a-f]{64}/;

const froms = ['Dockerfile', 'packages/analysis/Dockerfile'].flatMap((f) =>
  [...read(f).matchAll(/^FROM\s+(\S+)/gm)]
    .map((m) => m[1])
    .filter((ref) => !ref.startsWith(FIRST_PARTY))
    .map((ref) => ({ where: f, ref })),
);

const composeImages = [...read('docker-compose.yml').matchAll(/^\s*image:\s*(\S+)/gm)]
  .map((m) => m[1])
  .filter((ref) => !ref.startsWith(FIRST_PARTY))
  .map((ref) => ({ where: 'docker-compose.yml', ref }));

describe('image digests', () => {
  it('finds the images it is meant to police', () => {
    expect(froms.length).toBeGreaterThanOrEqual(3);
    expect(composeImages.length).toBeGreaterThanOrEqual(2);
  });

  it('pins every third-party image by digest', () => {
    const unpinned = [...froms, ...composeImages].filter((i) => !DIGEST.test(i.ref));
    expect(unpinned.map((i) => `${i.where}: ${i.ref}`)).toEqual([]);
  });

  it('has Renovate keep the digests current', () => {
    expect(JSON.parse(read('renovate.json')).extends).toContain('docker:pinDigests');
  });
});
