// packages/web/src/app/pages/page-shell.spec.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Drift guard for the page/section idiom system (issue #384): every routed
// page wraps in `page-shell max-w-<tier>` and the grouped pages never regrow
// raw card/heading literals. Criteria: docs/web-ui.md "Page & section idioms".
const read = (rel: string): string => readFileSync(join(__dirname, rel), 'utf8');

const PAGE_TIERS: Array<[string, '6xl' | '3xl' | '2xl']> = [
  ['library/library.component.html', '6xl'],
  ['library/album-detail.component.html', '6xl'],
  ['library/artist-detail.component.html', '6xl'],
  ['library/genre-detail.component.html', '6xl'],
  ['search/search.component.html', '6xl'],
  ['downloads/downloads.component.html', '6xl'],
];

describe('page shell drift guard (issue #384)', () => {
  it.each(PAGE_TIERS)('%s wraps its content in page-shell max-w-%s', (rel, tier) => {
    expect(read(rel)).toContain(`page-shell max-w-${tier}`);
  });
});
