import { describe, it, expect } from 'vitest';
import { classifyHuntDownloadResult, classifyHuntDownloadError } from './hunt-download-outcome';

describe('classifyHuntDownloadResult', () => {
  it('treats a positive queued count as a real download', () => {
    expect(classifyHuntDownloadResult({ queued: 12 })).toBe('queued');
  });

  it('treats an explicit alreadyComplete flag as already-complete', () => {
    expect(classifyHuntDownloadResult({ queued: 0, alreadyComplete: true })).toBe(
      'already-complete',
    );
  });

  it('treats a zero queue (no flag) as already-complete', () => {
    expect(classifyHuntDownloadResult({ queued: 0 })).toBe('already-complete');
  });
});

describe('classifyHuntDownloadError', () => {
  it('maps the 409 already-complete code', () => {
    const err = { error: { error: 'already-complete' } };
    expect(classifyHuntDownloadError(err)).toEqual({
      kind: 'already-complete',
      message: '',
      retriable: false,
    });
  });

  it('maps the 409 already-downloading code', () => {
    const err = { error: { error: 'already-downloading' } };
    expect(classifyHuntDownloadError(err)).toEqual({
      kind: 'already-downloading',
      message: '',
      retriable: false,
    });
  });

  it('falls through to a generic error message for an Error', () => {
    expect(classifyHuntDownloadError(new Error('peer offline'))).toEqual({
      kind: 'error',
      message: 'peer offline',
      retriable: false,
    });
  });

  // Issue #531: the server body's human message ("Selection expired — run the
  // search again", "…they may be offline") used to be flattened to the generic
  // default, which is why the prod incident behind #530 was undiagnosable from
  // the toast alone.
  it('surfaces the server body message for a non-machine-code error', () => {
    expect(classifyHuntDownloadError({ status: 400, error: { error: 'boom' } })).toEqual({
      kind: 'error',
      message: 'boom',
      retriable: false,
    });
    expect(classifyHuntDownloadError(null)).toEqual({
      kind: 'error',
      message: 'Download failed',
      retriable: false,
    });
  });

  it('marks 5xx failures retriable (peer offline is a per-candidate condition)', () => {
    const err = {
      status: 502,
      error: { error: 'Download failed for user "trinsic" — they may be offline' },
    };
    expect(classifyHuntDownloadError(err)).toEqual({
      kind: 'error',
      message: 'Download failed for user "trinsic" — they may be offline',
      retriable: true,
    });
  });

  it('marks a network failure (status 0) retriable', () => {
    expect(classifyHuntDownloadError({ status: 0 })).toMatchObject({
      kind: 'error',
      retriable: true,
    });
  });

  it('keeps 4xx terminal — a stale selection cannot be fixed by another peer', () => {
    const err = { status: 400, error: { error: 'Selection expired — run the search again' } };
    expect(classifyHuntDownloadError(err)).toMatchObject({
      kind: 'error',
      message: 'Selection expired — run the search again',
      retriable: false,
    });
  });
});
