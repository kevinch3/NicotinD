import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AboutComponent } from './about.component';
import { APP_BUILD_INFO, APP_VERSION } from '../../../app.config';
import { REPO_URL, resolveBuildInfo } from '../../../lib/build-info';
import { expandAllGroups } from '../../../../testing/expand-groups';
import BASE_CATALOG from '../../../../../public/i18n/en.json';
import ES_CATALOG from '../../../../../public/i18n/es.json';

/** Every key this page renders. Both catalogs must carry all of them. */
const KEYS = [
  'settings.about',
  'about.title',
  'about.groupTitle',
  'about.groupDesc',
  'about.appLabel',
  'about.versionLabel',
  'about.buildLabel',
  'about.buildUnknown',
  'about.releaseNotes',
  'about.licenceTitle',
  'about.licenceBody',
  'about.licenceFullText',
  'about.sourceTitle',
  'about.sourceBody',
  'about.sourceThisBuild',
  'about.sourceRepo',
  'about.noticesTitle',
  'about.noticesPending',
] as const;

function setup(commit: string | null = null) {
  TestBed.configureTestingModule({
    imports: [AboutComponent],
    providers: [
      provideRouter([]),
      { provide: APP_VERSION, useValue: '9.9.9' },
      { provide: APP_BUILD_INFO, useValue: resolveBuildInfo(commit) },
    ],
  });
  const fixture = TestBed.createComponent(AboutComponent);
  fixture.detectChanges();
  // Collapsed by default (the repo-wide settings-cards rule), so the body is
  // not in the DOM until the card is opened. The shared helper is what makes
  // this idempotent across tests — jsdom's localStorage is process-wide, so a
  // blind click would re-collapse the card the previous test left open.
  expandAllGroups(fixture);
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('AboutComponent', () => {
  it('renders the injected version', () => {
    const { el } = setup();
    expect(el.querySelector('[data-testid="about-version"]')?.textContent).toContain('9.9.9');
  });

  it('states the licence', () => {
    const { el } = setup();
    // The raw key renders (no catalog in this harness), so assert the catalog
    // text itself rather than the key — the statement is the compliance bit.
    expect(el.querySelector('[data-testid="about-licence"]')).toBeTruthy();
    expect(BASE_CATALOG['about.licenceBody']).toContain('AGPL-3.0-only');
  });

  it('offers corresponding source for the exact build when the commit is stamped', () => {
    const sha = 'abcdef1234567890abcdef1234567890abcdef12';
    const { el } = setup(sha);
    expect(el.querySelector('[data-testid="about-source-link"]')?.getAttribute('href')).toBe(
      `${REPO_URL}/tree/${sha}`,
    );
    expect(el.querySelector('[data-testid="about-build"]')?.textContent).toContain('abcdef1');
    // The repo root stays reachable alongside the pinned tree.
    expect(el.querySelector('[data-testid="about-repo-link"]')?.getAttribute('href')).toBe(
      REPO_URL,
    );
  });

  it('still offers source from an unstamped build', () => {
    const { el } = setup();
    expect(el.querySelector('[data-testid="about-source-link"]')?.getAttribute('href')).toBe(
      REPO_URL,
    );
    expect(el.querySelector('[data-testid="about-repo-link"]')).toBeNull();
  });

  it('opens the shared changelog modal rather than restating release notes', () => {
    const { fixture, el } = setup();
    expect(el.querySelector('[data-testid="changelog-modal"]')).toBeNull();
    el.querySelector<HTMLButtonElement>('[data-testid="about-changelog"]')!.click();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="changelog-modal"]')).toBeTruthy();
  });

  it('declares the third-party notices gap instead of implying there are none', () => {
    const { el } = setup();
    expect(el.querySelector('[data-testid="about-notices"]')).toBeTruthy();
  });

  it('has every string in both the base and the Spanish catalog', () => {
    for (const key of KEYS) {
      expect(BASE_CATALOG, `missing en key: ${key}`).toHaveProperty([key]);
      expect(ES_CATALOG, `missing es key: ${key}`).toHaveProperty([key]);
    }
  });
});
