import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { BottomNavComponent } from './bottom-nav.component';
import { SetupService } from '../../services/setup.service';
import { TransferService } from '../../services/transfer.service';

function setup(opts: { offline?: boolean; active?: number } = {}) {
  const isOffline = signal(opts.offline ?? false);
  const activeDownloadCount = signal(opts.active ?? 0);

  TestBed.configureTestingModule({
    imports: [BottomNavComponent],
    providers: [
      provideRouter([]),
      { provide: SetupService, useValue: { isOffline } },
      { provide: TransferService, useValue: { activeDownloadCount } },
    ],
  });

  const fixture = TestBed.createComponent(BottomNavComponent);
  fixture.detectChanges();
  return { fixture, isOffline, activeDownloadCount };
}

describe('BottomNavComponent', () => {
  it('renders the four curated tabs (Admin excluded)', () => {
    const { fixture } = setup();
    const links = fixture.nativeElement.querySelectorAll('a, span') as NodeListOf<HTMLElement>;
    const labels = Array.from(links).map((el) => el.textContent?.trim());
    expect(labels).toEqual(['Search', 'Library', 'Downloads', 'Settings']);
  });

  it('renders online-only tabs as disabled spans when offline', () => {
    const { fixture } = setup({ offline: true });
    // Search + Library are online-only → spans; Downloads + Settings → links.
    const anchors = fixture.nativeElement.querySelectorAll('a');
    const spans = fixture.nativeElement.querySelectorAll('nav span');
    expect(anchors.length).toBe(2);
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
});
