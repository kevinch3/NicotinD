// packages/web/src/app/pages/page-shell.spec.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Drift guard for the page/section idiom system (issue #384): every routed
// page wraps in `page-shell max-w-<tier>` and the grouped pages never regrow
// raw card/heading literals. Criteria: docs/web-ui.md "Page & section idioms".
const read = (rel: string): string => readFileSync(join(__dirname, rel), 'utf8');

// The settings-family pages share Admin's 3xl tier (issue #420) — a 2xl/3xl split made the
// content column jump when navigating Settings ↔ Admin ↔ Extensions.
const PAGE_TIERS: Array<[string, '6xl' | '3xl']> = [
  ['library/library.component.html', '6xl'],
  ['library/album-detail.component.html', '6xl'],
  ['library/artist-detail.component.html', '6xl'],
  ['library/genre-detail.component.html', '6xl'],
  ['search/search.component.html', '6xl'],
  ['downloads/downloads.component.html', '6xl'],
  ['settings/settings.component.html', '3xl'],
  ['settings/devices/devices.component.html', '3xl'],
  ['settings/agent-tokens/agent-tokens.component.html', '3xl'],
  ['plugins/plugins.component.html', '3xl'],
  ['admin/admin.component.html', '3xl'],
  ['radio-landing/radio-landing.component.html', '3xl'],
  ['library/playlist-detail.component.html', '3xl'],
  ['share/share-view.component.html', '3xl'],
];

const IDIOM_PAGES = [
  'settings/settings.component.html',
  'settings/devices/devices.component.html',
  'settings/agent-tokens/agent-tokens.component.html',
  'plugins/plugins.component.html',
  'admin/admin.component.html',
];

describe('page shell drift guard (issue #384)', () => {
  // These assertions are canaries for the idiomatic spelling, not exhaustive checks over every
  // class-ordering a template could legally use — `toContain`/`toMatch` here are class-order-
  // sensitive, so a semantically-equivalent reorder of the same classes could slip past.
  it.each(PAGE_TIERS)('%s wraps its content in page-shell max-w-%s', (rel, tier) => {
    expect(read(rel)).toContain(`page-shell max-w-${tier}`);
  });

  it.each(IDIOM_PAGES)('%s has no raw bare-surface card literal', (rel) => {
    // bg-theme-surface/50 and bg-theme-surface-2 are fine; a bare
    // `rounded-xl border border-theme bg-theme-surface` card is the legacy idiom.
    expect(read(rel)).not.toMatch(/rounded-xl border border-theme bg-theme-surface(?![/-])/);
  });

  it.each(IDIOM_PAGES)('%s uses section-title, not the raw uppercase heading literal', (rel) => {
    expect(read(rel)).not.toMatch(
      /text-sm font-semibold (?:text-theme-secondary )?uppercase tracking-wider/,
    );
  });
});

// Browse/detail-tier identity headings adopted page-title too (issue #385) —
// four already carried its exact literal classes; Downloads' text-lg h1 and
// genre-detail's h2 were promoted so the app has one h1 typography. Section
// headings *within* a page (text-lg h2s, section-title) are a different tier
// and deliberately not listed.
const PAGE_TITLE_PAGES = [
  'library/album-detail.component.html',
  'library/artist-detail.component.html',
  'library/genre-detail.component.html',
  'library/playlist-detail.component.html',
  'share/share-view.component.html',
  'downloads/downloads.component.html',
];

describe('page title drift guard (issue #385)', () => {
  it.each(PAGE_TITLE_PAGES)('%s renders its main heading with page-title', (rel) => {
    expect(read(rel)).toMatch(/<h1 class="page-title[" ]/);
  });

  it.each(PAGE_TITLE_PAGES)('%s has no raw page-title-sized heading literal left', (rel) => {
    expect(read(rel)).not.toContain('text-2xl font-bold text-theme-primary');
  });
});

// Every list view that fetches used to render the same copy-pasted spinner —
// `border-2 border-theme border-t-zinc-300 rounded-full animate-spin` — centred
// in `py-20` dead space beside the grid it stood in for. They are now
// `<app-skeleton>`; this guard stops copy #13.
//
// Scoped to *list* loaders on purpose. A spinner still means "an action you
// started is in progress", and those are deliberately untouched:
//   - search.component.html — the per-card `resolvingAlbum()` overlay
//   - album-hunt-modal      — searching + "Queuing downloads…" progress
//   - artist-image-menu     — upload in flight
//   - downloads / admin     — scan-in-progress icons next to a live count
//   - track-row, player-*, now-playing-*, folder-browser, layout — buffering
//     and pull-to-refresh, which encode state in their motion
// See docs/web-ui.md "List loading skeletons" for the full split rule.
const NO_LIST_SPINNER = [
  'library/library.component.html',
  'library/album-detail.component.html',
  'library/artist-detail.component.html',
  'library/genre-detail.component.html',
  'library/playlist-detail.component.html',
  'library/library-songs.component.html',
  'library/library-find.component.html',
  'share/share-view.component.html',
];

describe('list loaders are skeletons, not spinners', () => {
  it.each(NO_LIST_SPINNER)('%s has no copy-pasted list spinner left', (rel) => {
    expect(read(rel)).not.toMatch(/border-t-zinc-300[^"]*animate-spin/);
  });

  it.each(NO_LIST_SPINNER)('%s renders a skeleton for its loading state', (rel) => {
    expect(read(rel)).toContain('<app-skeleton');
  });
});
