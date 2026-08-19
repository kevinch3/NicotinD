import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Issue #548: the API spawns external binaries by bare name, and nothing in the
 * type system or the test suite connects "we spawn `fpcalc`" to "the image
 * installs libchromaprint-tools". AcoustID identify shipped for months against
 * an image that never had the binary, failing with the very `fpcalc-missing`
 * outcome whose remediation text ("install libchromaprint-tools") a container
 * operator cannot act on.
 *
 * Each entry below derives its premise from the source that spawns the binary,
 * so changing the default binary name fails here rather than silently
 * invalidating the mapping.
 */
const ROOT = resolve(import.meta.dir, '..');
const dockerfile = readFileSync(resolve(ROOT, 'Dockerfile'), 'utf8');

/** Debian packages the image installs via its apt-get line. */
function aptPackages(source: string): string[] {
  const line = source.match(/apt-get install ([^\n]*?)&&/s)?.[1];
  if (!line) return [];
  return line
    .split(/\s+/)
    .filter((token) => token.length > 0 && !token.startsWith('-') && token !== '\\');
}

const RUNTIME_BINARIES = [
  {
    binary: 'fpcalc',
    package: 'libchromaprint-tools',
    // The default is what a deployment that never sets `binaryPath` runs.
    spawnedBy: 'packages/api/src/services/acoustid-lookup.ts',
    defaultPattern: /binaryPath: string = 'fpcalc'/,
  },
  {
    binary: 'ffmpeg',
    package: 'ffmpeg',
    spawnedBy: 'packages/api/src/services/ffmpeg-path.ts',
    defaultPattern: /: 'ffmpeg'/,
  },
];

describe('Dockerfile installs every binary the server spawns (#548)', () => {
  const installed = aptPackages(dockerfile);

  it('parses the apt-get install list', () => {
    // A parser that silently returns [] would make every assertion below vacuous.
    expect(installed.length).toBeGreaterThan(0);
    expect(installed).toContain('ca-certificates');
  });

  for (const { binary, package: pkg } of RUNTIME_BINARIES) {
    it(`installs ${pkg}, which provides ${binary}`, () => {
      expect(installed).toContain(pkg);
    });
  }

  for (const { binary, spawnedBy, defaultPattern } of RUNTIME_BINARIES) {
    it(`${spawnedBy} still defaults to spawning bare '${binary}'`, () => {
      const source = readFileSync(resolve(ROOT, spawnedBy), 'utf8');
      expect(source).toMatch(defaultPattern);
    });
  }
});
