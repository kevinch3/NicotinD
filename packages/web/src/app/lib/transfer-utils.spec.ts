import { detectNewCompletion } from './transfer-utils';
import type { TransferEntry } from './transfer-types';

const entry = (state: TransferEntry['state'], percent = 0): TransferEntry => ({ state, percent });

describe('detectNewCompletion', () => {
  it('returns false when both maps are empty', () => {
    expect(detectNewCompletion(new Map(), new Map())).toBe(false);
  });

  it('returns false when nothing is completed', () => {
    const prev = new Map([['u:a.mp3', entry('InProgress', 50)]]);
    const next = new Map([['u:a.mp3', entry('InProgress', 80)]]);
    expect(detectNewCompletion(prev, next)).toBe(false);
  });

  it('returns true when a transfer newly reaches Completed, Succeeded', () => {
    const prev = new Map([['u:a.mp3', entry('InProgress', 99)]]);
    const next = new Map([['u:a.mp3', entry('Completed, Succeeded')]]);
    expect(detectNewCompletion(prev, next)).toBe(true);
  });

  it('returns false when a transfer was already Completed, Succeeded in prev', () => {
    const prev = new Map([['u:a.mp3', entry('Completed, Succeeded')]]);
    const next = new Map([['u:a.mp3', entry('Completed, Succeeded')]]);
    expect(detectNewCompletion(prev, next)).toBe(false);
  });

  it('returns true when a brand-new completed transfer appears (not in prev at all)', () => {
    const prev = new Map<string, TransferEntry>();
    const next = new Map([['u:b.mp3', entry('Completed, Succeeded')]]);
    expect(detectNewCompletion(prev, next)).toBe(true);
  });

  it('returns false for Completed, Errored — only Succeeded triggers libraryDirty', () => {
    const prev = new Map([['u:a.mp3', entry('InProgress', 60)]]);
    const next = new Map([['u:a.mp3', entry('Completed, Errored')]]);
    expect(detectNewCompletion(prev, next)).toBe(false);
  });

  it('returns false for Completed, Cancelled', () => {
    const prev = new Map([['u:a.mp3', entry('InProgress', 10)]]);
    const next = new Map([['u:a.mp3', entry('Completed, Cancelled')]]);
    expect(detectNewCompletion(prev, next)).toBe(false);
  });

  it('returns true if any one of multiple transfers newly completes', () => {
    const prev = new Map([
      ['u:a.mp3', entry('InProgress', 50)],
      ['u:b.mp3', entry('InProgress', 50)],
    ]);
    const next = new Map([
      ['u:a.mp3', entry('InProgress', 80)],
      ['u:b.mp3', entry('Completed, Succeeded')],
    ]);
    expect(detectNewCompletion(prev, next)).toBe(true);
  });

  it('returns false when all completions were already completed in prev', () => {
    const prev = new Map([
      ['u:a.mp3', entry('Completed, Succeeded')],
      ['u:b.mp3', entry('Completed, Succeeded')],
    ]);
    const next = new Map([
      ['u:a.mp3', entry('Completed, Succeeded')],
      ['u:b.mp3', entry('Completed, Succeeded')],
    ]);
    expect(detectNewCompletion(prev, next)).toBe(false);
  });
});
