import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Component, signal } from '@angular/core';
import { BottomNavComponent } from './bottom-nav.component';
import { AuthService } from '../../services/auth.service';
import { SetupService } from '../../services/setup.service';
import { TransferService } from '../../services/transfer.service';

@Component({ standalone: true, template: '' })
class _Stub {}

function setup(opts: { offline?: boolean; active?: number; canAcquire?: boolean } = {}) {
  const isOffline = signal(opts.offline ?? false);
  const activeDownloadCount = signal(opts.active ?? 0);
  const canAcquire = signal(opts.canAcquire ?? true);

  TestBed.configureTestingModule({
    imports: [BottomNavComponent],
    providers: [
      provideRouter([
        { path: '', component: _Stub },
        { path: 'library', component: _Stub },
        { path: 'downloads', component: _Stub },
        { path: 'search', component: _Stub },
        { path: 'settings', component: _Stub },
      ]),
      { provide: AuthService, useValue: { canAcquire } },
      { provide: SetupService, useValue: { isOffline } },
      { provide: TransferService, useValue: { activeDownloadCount } },
    ],
  });

  const fixture = TestBed.createComponent(BottomNavComponent);
  const router = TestBed.inject(Router);
  fixture.detectChanges();
  return { fixture, isOffline, activeDownloadCount, router };
}

function linkFor(fixture: { nativeElement: Document | HTMLElement }, to: string): HTMLAnchorElement | null {
  const anchors = Array.from(fixture.nativeElement.querySelectorAll('a')) as HTMLAnchorElement[];
  return anchors.find((a) => a.getAttribute('href') === to) ?? null;
}

describe('BottomNavComponent', () => {
  it('renders the five curated tabs (Admin excluded)', () => {
    const { fixture } = setup();
    const links = fixture.nativeElement.querySelectorAll('a, span') as NodeListOf<HTMLElement>;
    const labels = Array.from(links).map((el) => el.textContent?.trim());
    expect(labels).toEqual(['Home', 'Library', 'Downloads', 'Search', 'Settings']);
  });

  it('includes Search as an online-only tab in the TABS list', () => {
    const { fixture } = setup();
    const searchTab = fixture.componentInstance.tabs().find((t) => t.to === '/search');
    expect(searchTab).toBeDefined();
    expect(searchTab?.label).toBe('Search');
    expect(searchTab?.onlineOnly).toBe(true);
  });

  it('hides the Downloads tab for a listener (cannot acquire)', () => {
    const { fixture } = setup({ canAcquire: false });
    const labels = Array.from(
      fixture.nativeElement.querySelectorAll('a, span') as NodeListOf<HTMLElement>,
    ).map((el) => el.textContent?.trim());
    expect(labels).toEqual(['Home', 'Library', 'Search', 'Settings']);
    expect(fixture.componentInstance.tabs().some((t) => t.to === '/downloads')).toBe(false);
  });

  it('renders online-only tabs as disabled spans when offline', () => {
    const { fixture } = setup({ offline: true });
    // Home (radio landing) + Search are online-only → 2 spans; Library (offline
    // Songs), Downloads, and Settings stay links.
    const anchors = fixture.nativeElement.querySelectorAll('a');
    const spans = fixture.nativeElement.querySelectorAll('nav span');
    expect(anchors.length).toBe(3);
    expect(spans.length).toBe(2);
  });

  it('shows a badge on Downloads when transfers are active', () => {
    const { fixture, activeDownloadCount } = setup({ active: 0 });
    expect(fixture.nativeElement.querySelector('nav a span')).toBeNull();

    activeDownloadCount.set(4);
    fixture.detectChanges();
    const badge = fixture.nativeElement.querySelector('nav a span') as HTMLElement;
    expect(badge?.textContent?.trim()).toBe('4');
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
    expect(c.isDisabled({ to: '/', label: 'Search', onlineOnly: true })).toBe(false);

    isOffline.set(true);
    expect(c.isDisabled({ to: '/', label: 'Search', onlineOnly: true })).toBe(true);
    expect(c.isDisabled({ to: '/downloads', label: 'Downloads', onlineOnly: false })).toBe(false);
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
      const painted = styles.some(
        (s) => s.includes('.is-active') && s.includes('--theme-accent'),
      );
      expect(painted, 'is-active uses --theme-accent').toBe(true);
    });
  });
});
