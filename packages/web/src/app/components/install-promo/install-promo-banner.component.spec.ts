import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi } from 'vitest';
import { signal } from '@angular/core';
import { InstallPromoBannerComponent } from './install-promo-banner.component';
import { InstallPromptService } from '../../services/install-prompt.service';
import BASE_CATALOG from '../../../../public/i18n/en.json';

function setup(opts: { show: boolean; canInstall: boolean }) {
  const svc = {
    showPromotion: signal(opts.show),
    canInstall: signal(opts.canInstall),
    installing: signal(false),
    install: vi.fn().mockResolvedValue('accepted'),
    dismissPromotion: vi.fn(),
  };
  TestBed.configureTestingModule({
    imports: [InstallPromoBannerComponent],
    providers: [{ provide: InstallPromptService, useValue: svc }],
  });
  const fixture = TestBed.createComponent(InstallPromoBannerComponent);
  fixture.detectChanges();
  const q = (id: string) =>
    fixture.nativeElement.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  return { fixture, svc, q };
}

describe('InstallPromoBannerComponent', () => {
  it('renders nothing while the service has nothing to promote', () => {
    const { q } = setup({ show: false, canInstall: true });
    expect(q('install-promo')).toBeNull();
  });

  it('offers Install + Not now when a prompt was captured', () => {
    const { q, svc } = setup({ show: true, canInstall: true });
    expect(q('install-promo')).not.toBeNull();
    q('install-promo-install')!.click();
    expect(svc.install).toHaveBeenCalledTimes(1);
    q('install-promo-dismiss')!.click();
    expect(svc.dismissPromotion).toHaveBeenCalledTimes(1);
  });

  it('on iOS there is no prompt to fire, so only the instructions and Not now render', () => {
    const { q, fixture } = setup({ show: true, canInstall: false });
    expect(q('install-promo')).not.toBeNull();
    expect(q('install-promo-install')).toBeNull();
    expect(q('install-promo-dismiss')).not.toBeNull();
    // The pipe renders bare keys under test; the copy itself lives in the catalog.
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('install.iosBody');
    expect(BASE_CATALOG['install.iosBody']).toMatch(/Add to Home Screen/);
  });

  it('has catalog entries for every key it renders', () => {
    for (const key of [
      'install.promoTitle',
      'install.promoBody',
      'install.iosBody',
      'install.install',
      'install.notNow',
      'install.dismissLabel',
    ]) {
      expect(BASE_CATALOG).toHaveProperty([key]);
    }
  });
});
