import { describe, expect, it, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscodeOutputRejectedError } from './transcode.js';
import {
  clearTranscodeFailures,
  isDeterministicTranscodeFailure,
  isKnownUntranscodable,
  rememberTranscodeFailure,
  transcodeFailureCount,
  transcodeFailureKey,
} from './transcode-failures.js';

const dir = mkdtempSync(join(tmpdir(), 'transcode-failures-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeFile(name: string, content = 'x'): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

const rejected = new TranscodeOutputRejectedError('too short');

describe('transcode failure negative cache (issue #317)', () => {
  beforeEach(() => clearTranscodeFailures());

  it('does not report an unseen file as untranscodable', () => {
    expect(isKnownUntranscodable(makeFile('a.mp3'))).toBe(false);
  });

  it('remembers a deterministic rejection so the next play skips the transcode', () => {
    const p = makeFile('b.mp3');
    rememberTranscodeFailure(p, rejected);
    expect(isKnownUntranscodable(p)).toBe(true);
  });

  it('never caches a transient failure — a bare Error must stay retryable', () => {
    const p = makeFile('c.mp3');
    rememberTranscodeFailure(p, new Error('ffmpeg exited 137: killed'));
    expect(isKnownUntranscodable(p)).toBe(false);
    expect(transcodeFailureCount()).toBe(0);
  });

  it('classifies the two error shapes', () => {
    expect(isDeterministicTranscodeFailure(rejected)).toBe(true);
    expect(isDeterministicTranscodeFailure(new Error('ENOSPC'))).toBe(false);
    expect(isDeterministicTranscodeFailure(undefined)).toBe(false);
  });

  it('scopes the verdict to one file — a sibling is unaffected', () => {
    const bad = makeFile('bad.mp3');
    const good = makeFile('good.mp3');
    rememberTranscodeFailure(bad, rejected);
    expect(isKnownUntranscodable(good)).toBe(false);
  });

  // The point of the size+mtime key: someone will eventually replace the
  // damaged file, and that repaired copy must transcode without manual eviction.
  it('invalidates when the file is replaced with different content (size change)', () => {
    const p = makeFile('repaired.mp3', 'short');
    rememberTranscodeFailure(p, rejected);
    expect(isKnownUntranscodable(p)).toBe(true);

    writeFileSync(p, 'a much longer repaired file body');
    expect(isKnownUntranscodable(p)).toBe(false);
  });

  it('invalidates when only the mtime changes (same-size replacement)', () => {
    const p = makeFile('touched.mp3', 'abcd');
    rememberTranscodeFailure(p, rejected);
    expect(isKnownUntranscodable(p)).toBe(true);

    const later = new Date(Date.now() + 60_000);
    utimesSync(p, later, later);
    expect(isKnownUntranscodable(p)).toBe(false);
  });

  it('refuses to cache a verdict for a file it cannot stat (no invalidation handle)', () => {
    const missing = join(dir, 'does-not-exist.mp3');
    expect(transcodeFailureKey(missing)).toBeNull();
    rememberTranscodeFailure(missing, rejected);
    expect(transcodeFailureCount()).toBe(0);
    expect(isKnownUntranscodable(missing)).toBe(false);
  });

  it('stays bounded, evicting oldest-first rather than growing forever', () => {
    const first = makeFile('first.mp3');
    rememberTranscodeFailure(first, rejected);
    for (let i = 0; i < 600; i++) {
      rememberTranscodeFailure(makeFile(`bulk-${i}.mp3`, `${i}`), rejected);
    }
    expect(transcodeFailureCount()).toBeLessThanOrEqual(500);
    // The very first entry was pushed out; a re-play just re-learns it.
    expect(isKnownUntranscodable(first)).toBe(false);
  });
});
