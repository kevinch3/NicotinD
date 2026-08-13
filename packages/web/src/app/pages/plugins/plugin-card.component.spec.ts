import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { PluginCardComponent } from './plugin-card.component';
import { PluginService, type PluginInfo } from '../../services/plugin.service';
import { SystemApiService } from '../../services/api/system-api.service';
import BASE_CATALOG from '../../../../public/i18n/en.json';

function basePlugin(overrides: Partial<PluginInfo>): PluginInfo {
  return {
    id: 'test-plugin',
    name: 'Test Plugin',
    description: 'A plugin for testing.',
    kind: 'metadata',
    capabilities: ['genre'],
    enabled: false,
    available: false,
    needsConfig: false,
    ...overrides,
  } as PluginInfo;
}

function render(plugin: PluginInfo): HTMLElement {
  TestBed.configureTestingModule({
    imports: [PluginCardComponent],
    providers: [provideRouter([])],
  });
  const fixture = TestBed.createComponent(PluginCardComponent);
  fixture.componentInstance.plugin = plugin;
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('PluginCardComponent — unified status pill', () => {
  // No catalog is loaded in this harness, so the `t` pipe renders the raw key;
  // assert the key lands in the DOM AND exists in the base catalog (issue #380,
  // the admin.component.spec.ts pattern).
  it('shows the Off pill for a disabled plugin', () => {
    const el = render(basePlugin({ enabled: false }));
    expect(el.querySelector('[data-testid="plugin-status"]')?.textContent?.trim()).toBe(
      'extensions.statusOff',
    );
    expect(BASE_CATALOG).toHaveProperty(['extensions.statusOff']);
  });

  it('shows the Needs-config pill for an enabled, unconfigured plugin', () => {
    const el = render(basePlugin({ enabled: true, needsConfig: true, available: false }));
    expect(el.querySelector('[data-testid="plugin-status"]')?.textContent?.trim()).toBe(
      'extensions.statusNeedsConfig',
    );
    expect(BASE_CATALOG).toHaveProperty(['extensions.statusNeedsConfig']);
  });

  it('shows the Unavailable pill for an enabled, configured, but unreachable plugin', () => {
    const el = render(basePlugin({ enabled: true, needsConfig: false, available: false }));
    expect(el.querySelector('[data-testid="plugin-status"]')?.textContent?.trim()).toBe(
      'extensions.statusUnavailable',
    );
    expect(BASE_CATALOG).toHaveProperty(['extensions.statusUnavailable']);
  });

  it('shows the Ready pill for an enabled, configured, available plugin', () => {
    const el = render(basePlugin({ enabled: true, needsConfig: false, available: true }));
    expect(el.querySelector('[data-testid="plugin-status"]')?.textContent?.trim()).toBe(
      'extensions.statusReady',
    );
    expect(BASE_CATALOG).toHaveProperty(['extensions.statusReady']);
  });

  it('renders only one status pill, not the old two-badge combination', () => {
    const el = render(basePlugin({ enabled: true, needsConfig: false, available: false }));
    expect(el.querySelectorAll('[data-testid="plugin-status"]').length).toBe(1);
  });
});

/**
 * Task 4 (settings-cards unification): the card's description/capabilities/
 * config form collapse into a body toggled independently of the always-visible
 * Enable/Disable button, persisted per-device like `SettingsGroupComponent`.
 */
describe('PluginCardComponent — collapsible body', () => {
  beforeEach(() => localStorage.clear());

  it('is collapsed by default (no body rendered)', () => {
    const el = render(basePlugin({ description: 'A plugin for testing.' }));
    expect(el.querySelector('[data-testid="plugin-card-body"]')).toBeNull();
    expect(
      el.querySelector('[data-testid="plugin-card-toggle"]')?.getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('expands the body when the toggle is clicked, and persists the state', () => {
    const fixture = TestBed.createComponent(PluginCardComponent);
    fixture.componentInstance.plugin = basePlugin({ description: 'A plugin for testing.' });
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    const toggle = el.querySelector<HTMLButtonElement>('[data-testid="plugin-card-toggle"]')!;
    toggle.click();
    fixture.detectChanges();

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const body = el.querySelector('[data-testid="plugin-card-body"]');
    expect(body).not.toBeNull();
    expect(body!.textContent).toContain('A plugin for testing.');
    expect(localStorage.getItem('nicotind-group-plugin-test-plugin')).toBe('true');
  });

  it('keeps the Enable/Disable button clickable while collapsed', () => {
    const el = render(basePlugin({ enabled: false }));
    const toggleBtn = el.querySelector<HTMLButtonElement>('[data-testid="plugin-toggle"]')!;
    expect(el.querySelector('[data-testid="plugin-card-body"]')).toBeNull();
    expect(toggleBtn.disabled).toBe(false);
    // The Enable/Disable button must not be nested inside the collapsible
    // toggle button (invalid HTML — nested interactive elements — and it
    // would also toggle the body open on every enable/disable click).
    const cardToggle = el.querySelector('[data-testid="plugin-card-toggle"]')!;
    expect(cardToggle.contains(toggleBtn)).toBe(false);
  });
});
