import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

// #1668 guard: a tab bar is `<app-icon-tabs>`, or it is on a list here with its
// reason. A new hand-rolled `tablist`, `radiogroup` or segmented pill fails.
const APP = join(__dirname, '..', '..');

/** Still hand-rolled; each is a migration step of #1668 and leaves this list with it. */
const PENDING: Record<string, string> = {
  'pages/home/home-view-switch.component.html': 'Shelves | Mosaic switch (step b)',
  'pages/library/artist-detail.component.html': 'artist tabs, also untranslated (step e)',
};

// One the patterns below do not see: the TV browse tabs (10-foot text pills, exempt).

/** Not tab bars, or tab bars the standard does not fit. */
const EXCEPTIONS: Record<string, string> = {
  'components/icon-tabs/icon-tabs.component.html': 'the component itself',
  'components/now-playing/radio-chip/radio-chip.component.html':
    'radio variety: a three-position dial, icons would add noise (#1660)',
  'components/now-playing/np-radio-control/np-radio-control.component.html':
    'the same radio variety dial in the transport',
  'pages/poll/poll-view.component.html': 'a rating scale, not navigation',
  'components/artist-identity-modal/artist-identity-modal.component.html':
    'a vertical list of choices in a modal',
  'components/copy-picker/copy-picker.component.html': 'a list of copies to pick one from',
  'pages/library/library-stats.component.html':
    'the period picker: a value picker with no distinguishable icons',
};

const TAB_LIKE = [
  /\brole="tablist"/,
  /\brole="radiogroup"/,
  // The segmented pill: a rounded surface-2 track with 4px of padding.
  /class="(?=[^"]*\bbg-theme-surface-2\b)(?=[^"]*\brounded-xl\b)(?=[^"]*\bp-1\b)[^"]*"/,
];

function templates(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return templates(p);
    return name.endsWith('.html') ? [p] : [];
  });
}

/** Markup only: an HTML comment that mentions a role is prose. */
const withoutComments = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '');

function tabLikeTemplates(): string[] {
  return templates(APP)
    .filter((p) => {
      const html = withoutComments(readFileSync(p, 'utf8'));
      return TAB_LIKE.some((re) => re.test(html));
    })
    .map((p) => relative(APP, p).split('\\').join('/'))
    .sort();
}

describe('tab bars are <app-icon-tabs> or a recorded exception (#1668)', () => {
  it('every tab-like template is accounted for', () => {
    const known = new Set([...Object.keys(PENDING), ...Object.keys(EXCEPTIONS)]);
    expect(tabLikeTemplates().filter((f) => !known.has(f))).toEqual([]);
  });

  it('no entry outlives its markup', () => {
    const found = new Set(tabLikeTemplates());
    const stale = [...Object.keys(PENDING), ...Object.keys(EXCEPTIONS)].filter(
      (f) => !found.has(f),
    );
    expect(stale).toEqual([]);
  });

  it('sweeps the whole app and still sees the bars it knows', () => {
    expect(templates(APP).length).toBeGreaterThan(100);
    expect(tabLikeTemplates()).toContain('pages/home/home-view-switch.component.html');
  });

  it('the patterns catch what they are for', () => {
    const hit = (html: string) => TAB_LIKE.some((re) => re.test(withoutComments(html)));
    expect(hit('<div role="tablist">')).toBe(true);
    expect(hit('<div class="flex gap-1 p-1 bg-theme-surface-2 rounded-xl w-fit">')).toBe(true);
    expect(hit('<!-- used to declare role="radiogroup" --><div>')).toBe(false);
    expect(hit('<div class="bg-theme-surface-2 rounded-xl p-4">')).toBe(false);
  });

  it('the migrated pages use the component', () => {
    for (const page of [
      'pages/library/library.component.html',
      'pages/get/get.component.html',
      'components/now-playing/now-playing-panel-tabs/now-playing-panel-tabs.component.html',
    ]) {
      expect(readFileSync(join(APP, page), 'utf8'), page).toContain('<app-icon-tabs');
      expect(tabLikeTemplates()).not.toContain(page);
    }
  });
});
