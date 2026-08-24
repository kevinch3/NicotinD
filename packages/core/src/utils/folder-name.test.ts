import { describe, expect, it } from 'bun:test';
import { isGenericFolderName } from './folder-name.js';

describe('isGenericFolderName', () => {
  it('treats container/technical folder names as generic', () => {
    for (const name of ['music', 'Downloads', 'CD1', '01']) {
      expect(isGenericFolderName(name)).toBe(true);
    }
  });

  // #674: peers sharing out of their own slskd downloads dir expose
  // `complete`/`incomplete` as path segments; taken as an artist hint they
  // block the addon's real metadata forever (COALESCE never overwrites).
  it("treats slskd's own download dirs as generic", () => {
    expect(isGenericFolderName('complete')).toBe(true);
    expect(isGenericFolderName('Incomplete')).toBe(true);
  });

  it('keeps real release/artist names', () => {
    expect(isGenericFolderName('BODAS 2024 (DJ ROBERT)')).toBe(false);
    expect(isGenericFolderName('Raffaella Carra')).toBe(false);
  });
});
