import { describe, expect, it } from 'bun:test';
import { problemsFor } from './check-library-formats.js';
import {
  LIBRARY_FORMATS,
  type FormatStrategy,
} from '../packages/api/src/services/library-format.js';

/** A minimal valid strategy, overridable per case. */
function strategy(over: Partial<FormatStrategy> = {}): FormatStrategy {
  return {
    id: 'opus',
    ext: 'opus',
    encodeArgs: (k) => ['-c:a', 'libopus', '-b:a', `${k}k`, '-f', 'ogg'],
    bitrateFor: () => 128,
    maxEmbeddedPictureBytes: 512 * 1024,
    embedArt: () => true,
    writeGain: () => true,
    postEncodeTags: null,
    ...over,
  } as FormatStrategy;
}

describe('check:library-formats', () => {
  it('passes every format actually in the registry', () => {
    // The denominator, and the thing that makes the rest of this file mean
    // something: the gate must agree with reality, not only with fixtures.
    const entries = Object.entries(LIBRARY_FORMATS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [id, s] of entries) expect(problemsFor(id, s)).toEqual([]);
  });

  it('rejects the adts trap — scannable but permanently untaggable', () => {
    // The case this gate exists for. `FORMAT_ARGS.aac` emits `-f adts` with
    // extension `.aac`, which IS in AUDIO_EXTENSIONS (the scanner indexes it)
    // but in neither ID3_EXTS nor VORBIS_EXTS, so writeAudioTags returns false
    // for every write, forever, silently. Adopting the streaming entry as a
    // library target is the obvious refactor and would have shipped this.
    const problems = problemsFor(
      'aac',
      strategy({ id: 'aac', ext: 'aac' } as Partial<FormatStrategy>),
    );
    expect(problems.some((p) => /untaggable/.test(p.problem))).toBe(true);
  });

  it('rejects an extension the scanner would never index', () => {
    const problems = problemsFor(
      'weird',
      strategy({ id: 'weird', ext: 'xyz' } as Partial<FormatStrategy>),
    );
    expect(problems.some((p) => /AUDIO_EXTENSIONS/.test(p.problem))).toBe(true);
  });

  it('rejects a format with no calibrated ladder', () => {
    // Rungs are codec-relative (Opus 96k ≈ mp3 160k), so borrowing another
    // format's ladder encodes at the wrong rate on every file rather than
    // failing — which is why absence has to be an error, not a fallback.
    const problems = problemsFor(
      'flac',
      strategy({ id: 'flac', ext: 'flac' } as Partial<FormatStrategy>),
    );
    expect(problems.some((p) => /ladder/.test(p.problem))).toBe(true);
  });

  it('rejects encodeArgs that select no codec or muxer', () => {
    const noCodec = problemsFor('opus', strategy({ encodeArgs: () => ['-f', 'ogg'] }));
    expect(noCodec.some((p) => /-c:a/.test(p.problem))).toBe(true);
    const noMuxer = problemsFor('opus', strategy({ encodeArgs: () => ['-c:a', 'libopus'] }));
    expect(noMuxer.some((p) => /-f/.test(p.problem))).toBe(true);
  });

  it('requires postEncodeTags to be declared — a writer or null, never absent (#1289)', () => {
    expect(problemsFor('opus', strategy({ postEncodeTags: () => true }))).toEqual([]);
    const absent = strategy();
    delete (absent as Partial<FormatStrategy>).postEncodeTags;
    expect(problemsFor('opus', absent).some((p) => /postEncodeTags/.test(p.problem))).toBe(true);
  });

  it('accepts writeGain: null as a real answer, not a missing one', () => {
    // mp3 and AAC genuinely have no in-header gain field. The type marks the
    // capability absent so call sites must handle it; the gate must not then
    // treat that declaration as a defect.
    expect(problemsFor('opus', strategy({ writeGain: null }))).toEqual([]);
  });

  it('accepts a null art cap, and rejects a nonsensical one', () => {
    // null = "no reader ceiling we could measure" (mp3 reads 6.5 MB back
    // byte-exact). Zero or negative is neither a cap nor an absence.
    expect(problemsFor('opus', strategy({ maxEmbeddedPictureBytes: null }))).toEqual([]);
    const bad = problemsFor('opus', strategy({ maxEmbeddedPictureBytes: 0 }));
    expect(bad.some((p) => /positive byte count/.test(p.problem))).toBe(true);
  });

  it('rejects a registry key that disagrees with its own id', () => {
    const problems = problemsFor('mp3', strategy({ id: 'opus', ext: 'opus' }));
    expect(problems.some((p) => /does not match/.test(p.problem))).toBe(true);
  });
});
