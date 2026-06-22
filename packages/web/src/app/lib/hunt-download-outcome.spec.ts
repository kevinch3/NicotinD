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
    expect(classifyHuntDownloadError(err)).toEqual({ kind: 'already-complete', message: '' });
  });

  it('maps the 409 already-downloading code', () => {
    const err = { error: { error: 'already-downloading' } };
    expect(classifyHuntDownloadError(err)).toEqual({ kind: 'already-downloading', message: '' });
  });

  it('falls through to a generic error message for an Error', () => {
    expect(classifyHuntDownloadError(new Error('peer offline'))).toEqual({
      kind: 'error',
      message: 'peer offline',
    });
  });

  it('falls through to the default message for an unknown shape', () => {
    expect(classifyHuntDownloadError({ error: { error: 'boom' } })).toEqual({
      kind: 'error',
      message: 'Download failed',
    });
    expect(classifyHuntDownloadError(null)).toEqual({ kind: 'error', message: 'Download failed' });
  });
});
