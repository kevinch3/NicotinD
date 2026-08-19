import { describe, it, expect } from 'bun:test';
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

/**
 * Issue #550, the same invariant read backwards. Phase 4 moved every downloader
 * into its own addon image, but the core image kept installing yt-dlp, spotdl
 * and a Deno runtime for them — 317 MB serving no caller. The forward direction
 * above cannot catch that: it only asks whether what we spawn is present.
 *
 * The premise is re-derived rather than asserted, so re-introducing an
 * in-process downloader fails here and says which install to restore, instead
 * of leaving a rule that silently outlived its reason.
 */
const DEPARTED_DOWNLOADERS = ['yt-dlp', 'spotdl', 'deno'];
const API_SRC = resolve(ROOT, 'packages/api/src');

/** The Dockerfile with comment lines dropped — what the build actually runs. */
const instructions = dockerfile
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

function spawnPattern(binaries: string[]): RegExp {
  return new RegExp(`spawn\\w*\\(\\s*['"](${binaries.join('|')})['"]`);
}

function scannedSources(): string[] {
  return [...new Glob('**/*.ts').scanSync(API_SRC)].filter((f) => !f.includes('.test.'));
}

function spawnSitesFor(binaries: string[]): string[] {
  const pattern = spawnPattern(binaries);
  return scannedSources().filter((relative) =>
    pattern.test(readFileSync(join(API_SRC, relative), 'utf8')),
  );
}

describe('core image carries no downloader it never runs (#550)', () => {
  it('core spawns none of them — the premise for not installing them', () => {
    // If this fails, core regained an in-process downloader and the image must
    // carry it again: restore the install rather than deleting this test.
    expect(spawnSitesFor(DEPARTED_DOWNLOADERS)).toEqual([]);
  });

  // Both halves of the premise check can pass for the wrong reason: an empty
  // glob, or a regex that matches nothing. ffmpeg is no probe here — it is
  // spawned through ffmpegBinary(), never as a literal.
  it('scans a real source tree', () => {
    expect(scannedSources().length).toBeGreaterThan(100);
  });

  it('would recognise a spawn site if one existed', () => {
    expect("spawn('yt-dlp', args)").toMatch(spawnPattern(DEPARTED_DOWNLOADERS));
    expect('spawnSync("deno", args)').toMatch(spawnPattern(DEPARTED_DOWNLOADERS));
  });

  for (const binary of DEPARTED_DOWNLOADERS) {
    it(`does not install ${binary}`, () => {
      // Instructions only — a comment explaining the absence is not an install.
      expect(instructions).not.toContain(binary);
    });
  }
});
