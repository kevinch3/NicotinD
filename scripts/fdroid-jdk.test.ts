import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { releaseJdk } from './fdroid-jdk';

describe('releaseJdk', () => {
  it('reads a tag-pinned setup-java step', () => {
    const yml = [
      '      - uses: actions/setup-java@v6',
      '        with:',
      '          distribution: temurin',
      "          java-version: '21'",
      '',
    ].join('\n');
    expect(releaseJdk(yml)).toBe('21');
  });

  // The shape Renovate's pinGitHubActionDigests writes. Before, this read as
  // "JDK unknown" and would have failed check:fdroid on Renovate's own PR.
  it('reads a SHA-pinned step with its version comment and a hyphenated key', () => {
    const yml = [
      '      - uses: actions/setup-java@3d3c42e5aac5ba805825da76410c181273ba90b1 # v6',
      '        with:',
      '          distribution: temurin',
      '          java-package: jdk',
      '          java-version: "21"',
      '',
    ].join('\n');
    expect(releaseJdk(yml)).toBe('21');
  });

  it('reports a different JDK rather than hiding it', () => {
    const yml =
      '      - uses: actions/setup-java@v6.1.0\n        with:\n          java-version: 17\n';
    expect(releaseJdk(yml)).toBe('17');
  });

  it('reads the real deploy.yml', () => {
    const deploy = readFileSync(
      join(import.meta.dir, '..', '.github/workflows/deploy.yml'),
      'utf8',
    );
    expect(releaseJdk(deploy)).toBe('21');
  });
});
