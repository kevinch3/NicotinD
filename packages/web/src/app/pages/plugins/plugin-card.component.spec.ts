import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { PluginCardComponent } from './plugin-card.component';
import type { PluginInfo } from '../../services/plugin.service';

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
  it('shows "Off" for a disabled plugin', () => {
    const el = render(basePlugin({ enabled: false }));
    expect(el.querySelector('[data-testid="plugin-status"]')?.textContent?.trim()).toBe('Off');
  });

  it('shows "Needs config" for an enabled, unconfigured plugin', () => {
    const el = render(basePlugin({ enabled: true, needsConfig: true, available: false }));
    expect(el.querySelector('[data-testid="plugin-status"]')?.textContent?.trim()).toBe(
      'Needs config',
    );
  });

  it('shows "Unavailable" for an enabled, configured, but unreachable plugin', () => {
    const el = render(basePlugin({ enabled: true, needsConfig: false, available: false }));
    expect(el.querySelector('[data-testid="plugin-status"]')?.textContent?.trim()).toBe(
      'Unavailable',
    );
  });

  it('shows "Ready" for an enabled, configured, available plugin', () => {
    const el = render(basePlugin({ enabled: true, needsConfig: false, available: true }));
    expect(el.querySelector('[data-testid="plugin-status"]')?.textContent?.trim()).toBe('Ready');
  });

  it('renders only one status pill, not the old two-badge combination', () => {
    const el = render(basePlugin({ enabled: true, needsConfig: false, available: false }));
    expect(el.querySelectorAll('[data-testid="plugin-status"]').length).toBe(1);
  });
});
