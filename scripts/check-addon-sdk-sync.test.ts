import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { SHARED_FILES, syncVerdict, type FileState } from './check-addon-sdk-sync.js';

const file = (over: Partial<FileState>): FileState => ({
  path: 'packages/addon-sdk/src/title-match.ts',
  touched: false,
  addon: 'same',
  local: 'same',
  ...over,
});

describe('syncVerdict (#1874)', () => {
  it('passes identical files silently', () => {
    expect(syncVerdict([file({}), file({ touched: true })])).toEqual({ ok: true, lines: [] });
  });

  it('blocks a branch that changed a shared file the addon does not carry yet', () => {
    const v = syncVerdict([file({ touched: true, local: 'new' })]);
    expect(v.ok).toBe(false);
    expect(v.lines[0]).toContain('addon first');
  });

  it('only warns when the addon moved and this branch did not touch the file', () => {
    const v = syncVerdict([file({ addon: 'newer' })]);
    expect(v.ok).toBe(true);
    expect(v.lines[0]).toContain('port its change');
  });

  it('cannot pass a touched file it could not compare, but does not block an untouched one', () => {
    expect(syncVerdict([file({ touched: true, addon: null })]).ok).toBe(false);
    const untouched = syncVerdict([file({ addon: null })]);
    expect(untouched.ok).toBe(true);
    expect(untouched.lines).toHaveLength(1);
  });

  it('names files that exist in this repo', () => {
    for (const p of SHARED_FILES) expect(existsSync(p)).toBe(true);
  });
});
