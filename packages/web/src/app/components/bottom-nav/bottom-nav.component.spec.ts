import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Component, signal } from '@angular/core';
import { BottomNavComponent } from './bottom-nav.component';
import { AuthService } from '../../services/auth.service';
import { SetupService } from '../../services/setup.service';
import { TransferService } from '../../services/transfer.service';
import { DownloadReviewService } from '../../services/download-review.service';
import { AcquireService } from '../../services/acquire.service';
import BASE_CATALOG from '../../../../public/i18n/en.json';

@Component({ standalone: true, template: '' })
class _Stub {}

function setup(
  opts: {
    offline?: boolean;
    active?: number;
    acquireJobs?: number;
    canAcquire?: boolean;
    pending?: number;
  } = {},
) {
  const isOffline = signal(opts.offline ?? false);
  const activeDownloadCount = signal(opts.active ?? 0);
  const activeJobs = signal(new Array(opts.acquireJobs ?? 0).fill({}));
  const canAcquire = signal(opts.canAcquire ?? true);
  const pending = signal(opts.pending ?? 0);

  TestBed.configureTestingModule({
    imports: [BottomNavComponent],
    providers: [
      provideRouter([
        { path: '', component: _Stub },
        { path: 'library', component: _Stub },
        { path: 'get', component: _Stub },
        { path: 'settings', component: _Stub },
      ]),
      { provide: AuthService, useValue: { canAcquire } },
      { provide: SetupService, useValue: { isOffline } },
      { provide: TransferService, useValue: { activeDownloadCount } },
      { provide: DownloadReviewService, useValue: { pending } },
      { provide: AcquireService, useValue: { activeJobs } },
    ],
  });

  const fixture = TestBed.createComponent(BottomNavComponent);
  const router = TestBed.inject(Router);
  fixture.detectChanges();
  return { fixture, isOffline, activeDownloadCount, activeJobs, pending, router };
}

function linkFor(
  fixture: { nativeElement: Document | HTMLElement },
  to: string,
): HTMLAnchorElement | null {
  const anchors = Array.from(fixture.nativeElement.querySelectorAll('a')) as HTMLAnchorElement[];
  return anchors.find((a) => a.getAttribute('href') === to) ?? null;
}

describe('BottomNavComponent', () => {
  it('renders the four curated tabs (Admin excluded)', () => {
    const { fixture } = setup();
    const links = fixture.nativeElement.querySelectorAll('a, span') as NodeListOf<HTMLElement>;
    const labels = Array.from(links).map((el) => el.textContent?.trim());
    expect(labels).toEqual(['nav.home', 'nav.library', 'nav.get', 'nav.settings']);
    // `label` is an i18n key now (issue #236), so assert the keys resolve —
    // otherwise a typo would render the raw key and still pass the list check.
    for (const key of labels) {
      expect(BASE_CATALOG, `missing catalog key: ${key}`).toHaveProperty([key]);
    }
  });

  it('includes Add as a tab that stays enabled offline (its Downloads half works)', () => {
    const { fixture } = setup();
    const getTab = fixture.componentInstance.tabs().find((t) => t.to === '/get');
    expect(getTab).toBeDefined();
    expect(getTab?.label).toBe('nav.get');
    expect(getTab?.onlineOnly).toBe(false);
  });

  it('hides the Add tab for a listener (cannot acquire)', () => {
    const { fixture } = setup({ canAcquire: false });
    const labels = Array.from(
      fixture.nativeElement.querySelectorAll('a, span') as NodeListOf<HTMLElement>,
    ).map((el) => el.textContent?.trim());
    expect(labels).toEqual(['nav.home', 'nav.library', 'nav.settings']);
    expect(fixture.componentInstance.tabs().some((t) => t.to === '/get')).toBe(false);
  });

  it('keeps every tab reachable offline, since none of them needs the server outright', () => {
    const { fixture } = setup({ offline: true });
    // Home was the last online-only tab: the mosaic used to be a wall of dead
    // server-backed shelves and now fills with the device's downloaded tracks.
    // Library serves its offline Songs tab, Get keeps its Downloads half, and
    // Settings never needed the network — so nothing renders as a dead span.
    expect(fixture.nativeElement.querySelectorAll('a').length).toBe(4);
    expect(fixture.nativeElement.querySelectorAll('nav span').length).toBe(0);
  });

  it('sizes the grid to the four visible tabs', () => {
    const { fixture } = setup();
    expect(fixture.componentInstance.gridColumns()).toBe('repeat(4, minmax(0, 1fr))');
  });

  it('narrows the grid for a listener so there is no empty trailing column', () => {
    // The old bar hardcoded `grid-cols-5` while a listener saw 4 tabs, leaving
    // a dead column and off-centre targets.
    const { fixture } = setup({ canAcquire: false });
    expect(fixture.componentInstance.gridColumns()).toBe('repeat(3, minmax(0, 1fr))');
  });

  it('shows a badge on Get when transfers are active', () => {
    const { fixture, activeDownloadCount } = setup({ active: 0 });
    expect(fixture.nativeElement.querySelector('nav a span')).toBeNull();

    activeDownloadCount.set(4);
    fixture.detectChanges();
    const badge = fixture.nativeElement.querySelector('nav a span') as HTMLElement;
    expect(badge?.textContent?.trim()).toBe('4');
  });

  it('folds the download-review pending count into the Add badge (issue #411)', () => {
    const { fixture } = setup({ active: 1, pending: 2 });
    expect(fixture.componentInstance.activeDownloads()).toBe(3);
    const badge = fixture.nativeElement.querySelector('nav a span') as HTMLElement;
    expect(badge?.textContent?.trim()).toBe('3');
  });

  it('counts in-flight URL acquisitions too, matching the desktop nav badge', () => {
    // These two badges used to disagree: mobile omitted acquire jobs, so a
    // spotdl/yt-dlp download showed a count on desktop and nothing on a phone.
    const { fixture } = setup({ active: 2, acquireJobs: 3 });
    const badge = fixture.nativeElement.querySelector('nav a span') as HTMLElement;
    expect(badge?.textContent?.trim()).toBe('5');
  });

  it('sits at the mini-player stacking level (z-50) so a modal hides menu + player together', () => {
    const { fixture } = setup();
    const nav = fixture.nativeElement.querySelector('nav') as HTMLElement;
    // The player bar is z-50; the tab bar must match so a z-50 modal backdrop
    // can't hide the menu while leaving the player visible.
    expect(nav.classList).toContain('z-50');
    expect(nav.classList).not.toContain('z-40');
  });

  it('isDisabled is true only for online-only tabs while offline', () => {
    const { fixture, isOffline } = setup();
    const c = fixture.componentInstance;
    expect(c.isDisabled({ to: '/', label: 'nav.home', onlineOnly: true })).toBe(false);

    isOffline.set(true);
    expect(c.isDisabled({ to: '/', label: 'nav.home', onlineOnly: true })).toBe(true);
    expect(c.isDisabled({ to: '/get', label: 'nav.get', onlineOnly: false })).toBe(false);
  });

  describe('active tab', () => {
    it('marks the current route as active and the others as inactive', async () => {
      const { fixture, router } = setup();
      await router.navigateByUrl('/library');
      fixture.detectChanges();

      const library = linkFor(fixture, '/library');
      const settings = linkFor(fixture, '/settings');
      expect(library, 'library link present').toBeTruthy();
      expect(settings, 'settings link present').toBeTruthy();
      expect(library!.classList.contains('is-active')).toBe(true);
      expect(settings!.classList.contains('is-active')).toBe(false);
    });

    it('Home only matches on exact "/" so children do not light it up', async () => {
      const { fixture, router } = setup();
      await router.navigateByUrl('/library');
      fixture.detectChanges();
      expect(linkFor(fixture, '/')!.classList.contains('is-active')).toBe(false);

      await router.navigateByUrl('/');
      fixture.detectChanges();
      expect(linkFor(fixture, '/')!.classList.contains('is-active')).toBe(true);
    });

    it('loads a stylesheet that paints the active tab with --theme-accent', async () => {
      const { fixture, router } = setup();
      await router.navigateByUrl('/library');
      fixture.detectChanges();

      // jsdom doesn't honor `[data-theme]` token swap, so we can't read the
      // resolved `--theme-accent` here; instead we assert the component's
      // stylesheet was attached and references --theme-accent (full color
      // resolution is e2e-tested in mobile-ux.spec.ts).
      const styles = Array.from(document.querySelectorAll('style')).map((s) => s.textContent ?? '');
      const painted = styles.some((s) => s.includes('.is-active') && s.includes('--theme-accent'));
      expect(painted, 'is-active uses --theme-accent').toBe(true);
    });
  });
});
