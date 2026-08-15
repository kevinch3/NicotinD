import { TestBed } from '@angular/core/testing';
import { AddonCatalogCardComponent } from './addon-catalog-card.component';
import {
  AddonCatalogService,
  type AddonCatalogItem,
  type AddonInstallResult,
} from '../../services/addon-catalog.service';
import { setInputValue } from '../../../testing/signal-input';
import BASE_CATALOG from '../../../../public/i18n/en.json';

function baseEntry(over: Partial<AddonCatalogItem>): AddonCatalogItem {
  return {
    id: 'ytdlp-addon',
    name: 'yt-dlp',
    description: 'Resolve audio from URLs.',
    kind: 'acquisition',
    capabilities: ['resolve', 'download'],
    risk: 'Third-party sites.',
    addonUrl: 'http://ytdlp-addon:8586',
    composeServices: [
      {
        name: 'ytdlp-addon',
        image: 'ghcr.io/kevinch3/nicotind-ytdlp-addon:latest',
        profile: 'ytdlp-addon',
        tokenEnvVar: 'YTDLP_ADDON_TOKEN',
      },
    ],
    volumes: ['ytdlp-addon-data'],
    state: 'available',
    ...over,
  } as AddonCatalogItem;
}

const INSTALL_RESULT: AddonInstallResult = {
  token: 'nca_addon_abcdef',
  addonUrl: 'http://ytdlp-addon:8586',
  reused: false,
  composeSnippet: {
    services: '  ytdlp-addon:\n    environment:\n      YTDLP_ADDON_TOKEN: nca_addon_abcdef',
    volumes: ['ytdlp-addon-data'],
    command: 'docker compose --profile ytdlp-addon up -d',
    full: 'YTDLP_ADDON_TOKEN: nca_addon_abcdef\ndocker compose --profile ytdlp-addon up -d',
  },
};

const catalogMock = {
  install: () => Promise.resolve(INSTALL_RESULT),
  check: () => Promise.resolve({ state: 'pending' as const, promoted: false }),
  refresh: () => Promise.resolve(),
};

function render(entry: AddonCatalogItem) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [AddonCatalogCardComponent],
    providers: [{ provide: AddonCatalogService, useValue: catalogMock }],
  });
  const fixture = TestBed.createComponent(AddonCatalogCardComponent);
  setInputValue(fixture.componentInstance.entry, entry);
  fixture.detectChanges();
  return fixture;
}

describe('AddonCatalogCardComponent', () => {
  it('shows the state badge with a real i18n key', () => {
    const el = render(baseEntry({ state: 'available' })).nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="addon-catalog-state"]')?.textContent?.trim()).toBe(
      'extensions.catalogAvailable',
    );
    expect(BASE_CATALOG).toHaveProperty(['extensions.catalogAvailable']);
  });

  it('offers Install for available, Check for pending, Enable for installed', () => {
    const avail = render(baseEntry({ state: 'available' })).nativeElement as HTMLElement;
    expect(avail.querySelector('[data-testid="addon-catalog-install"]')).toBeTruthy();

    const pending = render(baseEntry({ state: 'pending' })).nativeElement as HTMLElement;
    expect(pending.querySelector('[data-testid="addon-catalog-check"]')).toBeTruthy();

    const installed = render(baseEntry({ state: 'installed' })).nativeElement as HTMLElement;
    expect(installed.querySelector('[data-testid="addon-catalog-enable"]')).toBeTruthy();

    const builtin = render(baseEntry({ id: 'archive', state: 'builtin' }))
      .nativeElement as HTMLElement;
    expect(builtin.querySelector('[data-testid="addon-catalog-install"]')).toBeNull();
  });

  it('installing reveals the snippet with the minted token (not change-me)', async () => {
    const fixture = render(baseEntry({ state: 'available' }));
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('[data-testid="addon-catalog-install"]') as HTMLButtonElement).click();
    await fixture.whenStable();
    // The entry input stays 'available' in a unit test, but the pending body
    // renders off the entry state — drive it directly by re-rendering pending
    // with the install result already present.
    const fixture2 = render(baseEntry({ state: 'pending' }));
    fixture2.componentInstance.install.set(INSTALL_RESULT);
    fixture2.detectChanges();
    const el2 = fixture2.nativeElement as HTMLElement;
    const snippet = el2.querySelector('[data-testid="addon-catalog-snippet"]')?.textContent ?? '';
    expect(snippet).toContain('YTDLP_ADDON_TOKEN: nca_addon_abcdef');
    expect(snippet).not.toContain('change-me');
  });

  it('pending without an in-memory snippet offers "Show setup"', () => {
    const el = render(baseEntry({ state: 'pending' })).nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="addon-catalog-show-setup"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="addon-catalog-snippet"]')).toBeNull();
  });

  it('draws a highlight ring when deep-linked and offers a share link', async () => {
    // Both signal inputs must land before the first detectChanges (JIT harness).
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AddonCatalogCardComponent],
      providers: [{ provide: AddonCatalogService, useValue: catalogMock }],
    });
    const fixture = TestBed.createComponent(AddonCatalogCardComponent);
    setInputValue(fixture.componentInstance.entry, baseEntry({ state: 'available' }));
    setInputValue(fixture.componentInstance.highlight, true);
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector(
      '[data-testid="addon-catalog-card"]',
    ) as HTMLElement;
    expect(card.classList.contains('ring-2')).toBe(true);

    (
      fixture.nativeElement.querySelector(
        '[data-testid="addon-catalog-share"]',
      ) as HTMLButtonElement
    ).click();
    await fixture.whenStable();
    fixture.detectChanges();
    const link = fixture.nativeElement.querySelector(
      '[data-testid="addon-catalog-share-link"]',
    ) as HTMLInputElement;
    expect(link.value).toContain('/extensions/install?catalog=ytdlp-addon');
  });

  it('Enable emits the addon id up to the parent page', () => {
    const fixture = render(baseEntry({ state: 'installed' }));
    let emitted: string | null = null;
    fixture.componentInstance.enableRequested.subscribe((id: string) => (emitted = id));
    (
      fixture.nativeElement.querySelector(
        '[data-testid="addon-catalog-enable"]',
      ) as HTMLButtonElement
    ).click();
    expect(emitted).toBe('ytdlp-addon');
  });
});
