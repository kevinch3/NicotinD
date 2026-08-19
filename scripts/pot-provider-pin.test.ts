import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Issue #551: the bgutil plugin baked into an image must match the provider
 * server it talks to, or the service starts and YouTube downloads quietly stop
 * working. `check:bgutil-pin` used to enforce that, but it compared core's pip
 * pin — which #550 removed along with the downloader that used it. The pins
 * that can actually break a download live in the ytdlp/spotdl addon repos, and
 * nothing there can read a file in this one.
 *
 * So the canonical version is published *on the artifact*: a label on the
 * provider image, which any addon build can inspect without cloning this repo
 * or guessing at an unreleased source file. This test pins that contract.
 */
const dockerfile = readFileSync(
  resolve(import.meta.dir, '..', 'packages/pot-provider/Dockerfile'),
  'utf8',
);

export const BGUTIL_LABEL = 'org.nicotind.bgutil.version';

describe('pot-provider publishes its bgutil version (#551)', () => {
  it('declares an ARG default that the build can be pinned to', () => {
    expect(dockerfile).toMatch(/^ARG BGUTIL_VERSION=\S+/m);
  });

  it(`labels the final image with ${BGUTIL_LABEL}`, () => {
    expect(dockerfile).toContain(BGUTIL_LABEL);
  });

  it('wires the label to the ARG rather than repeating the literal', () => {
    // A hardcoded label is worse than none: it would keep reporting the old
    // version after a bump, so every consumer's check passes against a lie.
    const label = dockerfile.match(new RegExp(`${BGUTIL_LABEL}="([^"]*)"`))?.[1];
    expect(label).toBe('${BGUTIL_VERSION}');
  });

  it('re-declares the ARG in the stage that uses it', () => {
    // A top-level ARG is out of scope inside a stage; without redeclaring, the
    // label silently interpolates to an empty string.
    const finalStage = dockerfile.slice(dockerfile.lastIndexOf('FROM '));
    expect(finalStage).toMatch(/^ARG BGUTIL_VERSION\s*$/m);
  });
});
