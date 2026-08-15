import { TestBed } from '@angular/core/testing';
import { AddonCatalogCardComponent } from './addon-catalog-card.component';
import type { AddonCatalogItem } from '../../services/addon-catalog.service';
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

function render(entry: AddonCatalogItem) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [AddonCatalogCardComponent] });
  const fixture = TestBed.createComponent(AddonCatalogCardComponent);
  // setInput() is a silent no-op under the JIT vitest harness; write the signal
  // node directly (see src/testing/signal-input.ts). Must precede detectChanges.
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

  it('offers a Set up step only for available (not builtin/installed) entries', () => {
    const avail = render(baseEntry({ state: 'available' })).nativeElement as HTMLElement;
    expect(avail.querySelector('[data-testid="addon-catalog-setup"]')).toBeTruthy();

    const installed = render(baseEntry({ state: 'installed' })).nativeElement as HTMLElement;
    expect(installed.querySelector('[data-testid="addon-catalog-setup"]')).toBeNull();

    const builtin = render(baseEntry({ id: 'archive', state: 'builtin' }))
      .nativeElement as HTMLElement;
    expect(builtin.querySelector('[data-testid="addon-catalog-setup"]')).toBeNull();
  });

  it('reveals the compose snippet on Set up, carrying the token env var', () => {
    const fixture = render(baseEntry({ state: 'available' }));
    const el = fixture.nativeElement as HTMLElement;
    (el.querySelector('[data-testid="addon-catalog-setup"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    const snippet = el.querySelector('[data-testid="addon-catalog-snippet"]')?.textContent ?? '';
    expect(snippet).toContain('YTDLP_ADDON_TOKEN:');
    expect(snippet).toContain('docker compose --profile ytdlp-addon up -d');
  });
});
