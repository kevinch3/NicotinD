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
  configFields: [{ key: 'apiKey', label: 'API key', type: 'text' }],
} as PluginInfo;
const META2: PluginInfo = {
  id: 'lrclib',
  kind: 'metadata',
  name: 'LRCLIB',
  enabled: true,
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
          plugins: signal([ACQ, META, META2]),
          acquisition: signal([ACQ]),
          metadata: signal([META, META2]),
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

  it('renders each plugin card toggle button as an appTvNavItem, excluding inline config inputs', () => {
    const el = render(true);
    const toggle = el.querySelector('[data-testid="plugin-toggle"]');
    expect(toggle?.hasAttribute('appTvNavItem')).toBe(true);
    const configInput = el.querySelector('[data-testid="plugin-config-form"] input');
    expect(configInput?.hasAttribute('appTvNavItem')).toBe(false);
  });

  /**
   * The behavioural counterpart to the attribute assertion above, and the
   * regression test for the bug it could not catch: the card used to live in a
   * shared `<ng-template #card>` declared as a SIBLING of the three
   * `<section appTvNavGroup>` blocks and instantiated with `ngTemplateOutlet`.
   * An embedded view is created from its template's DECLARATION context, and
   * the node injector walks the DECLARATION ancestry — so every
   * `TvNavItemDirective` in the card resolved `inject(TvNavGroupDirective)` to
   * `null`, registered with nothing, and D-pad navigation on this whole page
   * was a silent no-op. The directive-selector attributes stayed in the DOM
   * throughout, which is exactly why an attribute-only test stayed green.
   */
  it('ArrowDown moves focus between plugin cards inside a section group', () => {
    const el = render(true);
    const section = el.querySelector('[data-testid="extensions-metadata-section"]')!;
    const items: HTMLElement[] = Array.from(section.querySelectorAll('[appTvNavItem]'));
    // Two metadata plugins are seeded, each contributing a toggle + a Save
    // button, so there is something to move to.
    expect(items.length).toBeGreaterThan(1);
    items[0]!.focus();
    items[0]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(items[1]);
  });
});
