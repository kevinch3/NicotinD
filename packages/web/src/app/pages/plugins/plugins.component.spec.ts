import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { PluginsComponent } from './plugins.component';
import { PluginService, type PluginInfo } from '../../services/plugin.service';
import { AuthService } from '../../services/auth.service';

/**
 * Issue #235. With the deployment-wide kill-switch off, every acquisition route
 * hard-404s and the pollers never start — so listing acquisition extensions
 * offers a toggle that cannot do anything, and the page's "nothing is
 * downloaded until you enable an extension here" framing is actively wrong.
 */
const ACQ: PluginInfo = {
  id: 'slskd',
  kind: 'acquisition',
  name: 'Soulseek',
  enabled: false,
} as PluginInfo;
const META: PluginInfo = {
  id: 'discogs',
  kind: 'metadata',
  name: 'Discogs',
  enabled: false,
} as PluginInfo;

function render(acquisitionEnabled: boolean): HTMLElement {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [PluginsComponent],
    providers: [
      provideRouter([]),
      {
        provide: PluginService,
        useValue: {
          refresh: () => Promise.resolve(),
          plugins: signal([ACQ, META]),
          acquisition: signal([ACQ]),
          metadata: signal([META]),
          connectivity: signal([]),
        },
      },
      {
        provide: AuthService,
        useValue: { serverAcquisitionEnabled: signal(acquisitionEnabled) },
      },
    ],
  });
  const fixture = TestBed.createComponent(PluginsComponent);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('PluginsComponent — acquisition kill-switch (#235)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the Acquisition section when acquisition is enabled', () => {
    const el = render(true);
    expect(el.querySelector('[data-testid="extensions-acquisition-section"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="extensions-acquisition-off"]')).toBeNull();
    expect(el.textContent).toContain('Soulseek');
  });

  it('hides the section and explains why when acquisition is off', () => {
    const el = render(false);
    expect(el.querySelector('[data-testid="extensions-acquisition-section"]')).toBeNull();

    const note = el.querySelector('[data-testid="extensions-acquisition-off"]');
    expect(note).not.toBeNull();
    // Naming the env var is the point — otherwise an admin can't act on it.
    expect(note!.textContent).toContain('NICOTIND_ACQUISITION=off');
    // The acquisition plugin itself must not be listed anywhere.
    expect(el.textContent).not.toContain('Soulseek');
  });

  it('still shows unrelated extension kinds when acquisition is off', () => {
    // Metadata/connectivity have nothing to do with acquisition; hiding them
    // would make the switch look broader than it is.
    expect(render(false).textContent).toContain('Discogs');
  });
});
