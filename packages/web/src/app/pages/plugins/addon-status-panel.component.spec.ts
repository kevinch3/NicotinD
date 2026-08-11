import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of, throwError } from 'rxjs';
import { AddonStatusPanelComponent } from './addon-status-panel.component';
import { PluginService, type AddonStatus } from '../../services/plugin.service';

async function render(
  status: AddonStatus | 'error',
): Promise<ComponentFixture<AddonStatusPanelComponent>> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [AddonStatusPanelComponent],
    providers: [
      {
        provide: PluginService,
        useValue: {
          getAddonStatus: () =>
            status === 'error' ? throwError(() => new Error('down')) : of(status),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(AddonStatusPanelComponent);
  fixture.componentInstance.pluginId = 'fixture-addon';
  fixture.detectChanges();
  // ngOnInit resolves the status on a microtask; let it land, then re-render.
  await new Promise((r) => setTimeout(r, 0));
  fixture.detectChanges();
  return fixture;
}

describe('AddonStatusPanelComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the addon status rows', async () => {
    const fixture = await render({
      available: true,
      rows: [{ key: 'peers', label: 'Peers', value: '42' }],
    });
    const el = fixture.nativeElement as HTMLElement;
    const rows = el.querySelectorAll('[data-testid="addon-status-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Peers');
    expect(rows[0]!.textContent).toContain('42');
    expect(el.querySelector('[data-testid="addon-status-unreachable"]')).toBeNull();
  });

  it('shows the unreachable note when the addon reports unavailable', async () => {
    const fixture = await render({ available: false, rows: [] });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="addon-status-unreachable"]')).not.toBeNull();
  });

  it('degrades to unreachable when the fetch fails', async () => {
    const fixture = await render('error');
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="addon-status-unreachable"]')).not.toBeNull();
  });
});
