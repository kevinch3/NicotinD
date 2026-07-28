import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { comparePins, composePin, dockerfilePin } from './check-bgutil-pin.js';

const DOCKERFILE = `ARG BGUTIL_VERSION=1.3.1
RUN pip3 install --upgrade yt-dlp "bgutil-ytdlp-pot-provider==\${BGUTIL_VERSION}"`;
// Since #238 the companion service is our own image, so the second pin lives in
// packages/pot-provider/Dockerfile rather than a third-party compose tag.
const PROVIDER = `ARG BGUTIL_VERSION=1.3.1
FROM node:25-bookworm-slim AS source`;

describe('bgutil pin extraction (#238)', () => {
  it('reads the Dockerfile ARG default', () => {
    expect(dockerfilePin(DOCKERFILE)).toBe('1.3.1');
  });

  it('reads the provider image ARG default', () => {
    expect(composePin(PROVIDER)).toBe('1.3.1');
  });

  it('returns null rather than a wrong answer when the plumbing is gone', () => {
    // Someone reverting to a hardcoded pin must fail the check, not pass it.
    expect(dockerfilePin('RUN pip3 install bgutil-ytdlp-pot-provider==1.3.1')).toBeNull();
    expect(composePin('RUN curl -fsSL .../archive/refs/tags/1.3.1.tar.gz')).toBeNull();
  });
});

describe('comparePins', () => {
  it('passes when both defaults agree', () => {
    expect(comparePins(DOCKERFILE, PROVIDER).ok).toBe(true);
  });

  it('fails on the drift it exists to catch', () => {
    // Bumping the server without the pip plugin is the real-world mistake: the
    // service starts fine and YouTube downloads quietly stop working.
    const drifted = PROVIDER.replace('1.3.1', '1.4.0');
    const res = comparePins(DOCKERFILE, drifted);
    expect(res.ok).toBe(false);
    expect(res.docker).toBe('1.3.1');
    expect(res.compose).toBe('1.4.0');
  });

  it('fails when either pin is missing, rather than vacuously passing', () => {
    expect(comparePins('FROM debian', PROVIDER).ok).toBe(false);
    expect(comparePins(DOCKERFILE, 'FROM node:25').ok).toBe(false);
  });
});

describe('the real repo files', () => {
  it('are in step right now', () => {
    const root = resolve(import.meta.dir, '..');
    const res = comparePins(
      readFileSync(resolve(root, 'Dockerfile'), 'utf8'),
      readFileSync(resolve(root, 'packages/pot-provider/Dockerfile'), 'utf8'),
    );
    expect(res).toMatchObject({ ok: true });
  });
});
