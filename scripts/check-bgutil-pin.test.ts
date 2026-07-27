import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { comparePins, composePin, dockerfilePin } from './check-bgutil-pin.js';

const DOCKERFILE = `ARG BGUTIL_VERSION=1.3.1
RUN pip3 install --upgrade yt-dlp "bgutil-ytdlp-pot-provider==\${BGUTIL_VERSION}"`;
const COMPOSE = `  bgutil-provider:
    image: brainicism/bgutil-ytdlp-pot-provider:\${BGUTIL_VERSION:-1.3.1}`;

describe('bgutil pin extraction (#238)', () => {
  it('reads the Dockerfile ARG default', () => {
    expect(dockerfilePin(DOCKERFILE)).toBe('1.3.1');
  });

  it('reads the compose image-tag fallback', () => {
    expect(composePin(COMPOSE)).toBe('1.3.1');
  });

  it('returns null rather than a wrong answer when the plumbing is gone', () => {
    // Someone reverting to a hardcoded pin must fail the check, not pass it.
    expect(dockerfilePin('RUN pip3 install bgutil-ytdlp-pot-provider==1.3.1')).toBeNull();
    expect(composePin('    image: brainicism/bgutil-ytdlp-pot-provider:1.3.1')).toBeNull();
  });
});

describe('comparePins', () => {
  it('passes when both defaults agree', () => {
    expect(comparePins(DOCKERFILE, COMPOSE).ok).toBe(true);
  });

  it('fails on the drift it exists to catch', () => {
    // Bumping the image without the pip plugin is the real-world mistake: the
    // service starts fine and YouTube downloads quietly stop working.
    const drifted = COMPOSE.replace('1.3.1', '1.4.0');
    const res = comparePins(DOCKERFILE, drifted);
    expect(res.ok).toBe(false);
    expect(res.docker).toBe('1.3.1');
    expect(res.compose).toBe('1.4.0');
  });

  it('fails when either pin is missing, rather than vacuously passing', () => {
    expect(comparePins('FROM debian', COMPOSE).ok).toBe(false);
    expect(comparePins(DOCKERFILE, 'services: {}').ok).toBe(false);
  });
});

describe('the real repo files', () => {
  it('are in step right now', () => {
    const root = resolve(import.meta.dir, '..');
    const res = comparePins(
      readFileSync(resolve(root, 'Dockerfile'), 'utf8'),
      readFileSync(resolve(root, 'docker-compose.yml'), 'utf8'),
    );
    expect(res).toMatchObject({ ok: true });
  });
});
