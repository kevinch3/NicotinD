import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { PluginsComponent } from './plugins.component';
import { PluginService, type PluginInfo } from '../../services/plugin.service';
import { AuthService } from '../../services/auth.service';

// Expanding the `slskd` card (part of `expandAll` below) mounts
// `SlskdSettingsComponent`, which calls `PluginService.hasSlskd()`/
// `getSlskdStatus()` from `ngOnInit` — the mock must carry them too.
const PLUGIN_SERVICE_SLSKD_STUB = {
  hasSlskd: () => false,
  getSlskdStatus: () => of(null),
};

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

type Fixture = ReturnType<(typeof TestBed)['createComponent']>;

function makeFixture(acquisitionEnabled: boolean): Fixture {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [PluginsComponent],
    providers: [
      provideRouter([]),
      {
        provide: PluginService,
        useValue: {
          ...PLUGIN_SERVICE_SLSKD_STUB,
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
  return fixture;
}

function render(acquisitionEnabled: boolean): HTMLElement {
  return makeFixture(acquisitionEnabled).nativeElement as HTMLElement;
}

/**
 * Task 4: every kind section (`app-settings-group`) AND every plugin card
 * within it starts collapsed, so a spec inspecting body content (config-form
 * inputs, plugin names/descriptions rendered inside a group's projected
 * content) must expand both levels first. Clicking every closed toggle in one
 * pass — rather than resolving a specific group/card — survives the
 * JIT-harness caveat noted in `settings.component.spec.ts`'s
 * `expandAllGroups` (a nested `input()` binding silently no-ops, so every
 * `app-settings-group` here falls back to the same default groupId/
 * defaultOpen, i.e. collapsed).
 */
function expandAll(fixture: Fixture): HTMLElement {
  const el = fixture.nativeElement as HTMLElement;
  const clickClosed = (selector: string): void => {
    el.querySelectorAll<HTMLButtonElement>(selector).forEach((btn) => {
      if (btn.getAttribute('aria-expanded') !== 'true') btn.click();
    });
    fixture.detectChanges();
  };
  // Two passes: a plugin card only mounts once its enclosing kind group is
  // open, so its `plugin-card-toggle` button isn't in the DOM to query/click
  // until the first pass's `detectChanges()` has run.
  clickClosed('[data-testid="settings-group-toggle"]');
  clickClosed('[data-testid="plugin-card-toggle"]');
  return el;
}

describe('PluginsComponent — acquisition kill-switch (#235)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the Acquisition section when acquisition is enabled', () => {
    const fixture = makeFixture(true);
    const collapsed = fixture.nativeElement as HTMLElement;
    expect(
      collapsed.querySelector('[data-testid="extensions-acquisition-section"]'),
    ).not.toBeNull();
    expect(collapsed.querySelector('[data-testid="extensions-acquisition-off"]')).toBeNull();

    const el = expandAll(fixture);
    expect(el.textContent).toContain('Soulseek');
  });

  it('hides the section and explains why when acquisition is off', () => {
    const el = expandAll(makeFixture(false));
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
    expect(expandAll(makeFixture(false)).textContent).toContain('Discogs');
  });

  it('renders each plugin card toggle button as an appTvNavItem, excluding inline config inputs', () => {
    const fixture = makeFixture(true);
    const el = expandAll(fixture);
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
    const fixture = makeFixture(true);
    const el = expandAll(fixture);
    const section = el.querySelector('[data-testid="extensions-metadata-section"]')!;
    const items: HTMLElement[] = Array.from(section.querySelectorAll('[appTvNavItem]'));
    // Two metadata plugins are seeded, each contributing a toggle + (once
    // expanded) a Save button, so there is something to move to.
    expect(items.length).toBeGreaterThan(1);
    items[0]!.focus();
    items[0]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(items[1]);
  });
});

describe('PluginsComponent — Connectivity section visibility', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('hides the Connectivity section entirely when no connectivity plugins are registered', () => {
    const el = expandAll(makeFixture(true));
    expect(el.querySelector('[data-testid="extensions-connectivity-section"]')).toBeNull();
    expect(el.textContent).not.toContain('Tailscale');
  });

  it('shows the Connectivity section when a connectivity plugin exists', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [PluginsComponent],
      providers: [
        provideRouter([]),
        {
          provide: PluginService,
          useValue: {
            ...PLUGIN_SERVICE_SLSKD_STUB,
            refresh: () => Promise.resolve(),
            plugins: signal([]),
            acquisition: signal([]),
            metadata: signal([]),
            connectivity: signal([
              {
                id: 'tailscale',
                kind: 'connectivity',
                name: 'Tailscale',
                enabled: false,
              } as PluginInfo,
            ]),
          },
        },
        { provide: AuthService, useValue: { serverAcquisitionEnabled: signal(true) } },
      ],
    });
    const fixture = TestBed.createComponent(PluginsComponent);
    fixture.detectChanges();
    const el = expandAll(fixture);
    expect(el.querySelector('[data-testid="extensions-connectivity-section"]')).not.toBeNull();
    expect(el.textContent).toContain('Tailscale');
  });
});
