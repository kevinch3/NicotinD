import { describe, expect, it } from 'bun:test';
import { pickDirectoryResult } from './dialog-result.js';

describe('pickDirectoryResult', () => {
  it('returns null when canceled', () => {
    expect(pickDirectoryResult({ canceled: true, filePaths: ['/music'] })).toBeNull();
  });

  it('returns null when no path was selected', () => {
    expect(pickDirectoryResult({ canceled: false, filePaths: [] })).toBeNull();
  });

  it('returns the first selected path', () => {
    expect(pickDirectoryResult({ canceled: false, filePaths: ['/music', '/other'] })).toBe(
      '/music',
    );
  });
});
