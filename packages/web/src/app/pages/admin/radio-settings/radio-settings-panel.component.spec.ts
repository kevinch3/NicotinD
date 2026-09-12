import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { RadioSettingsPanelComponent } from './radio-settings-panel.component';
import { SystemApiService } from '../../../services/api/system-api.service';
import { expandAllGroups } from '../../../../testing/expand-groups';

function setup(opts: { centroids?: number; genreAffinity?: boolean; saveFails?: boolean } = {}) {
  const save = vi.fn((p: { genreAffinity?: boolean }) =>
    opts.saveFails
      ? throwError(() => new Error('boom'))
      : of({ genreAffinity: p.genreAffinity ?? false, centroids: 833, computedAt: 1 }),
  );
  TestBed.configureTestingModule({
    imports: [RadioSettingsPanelComponent],
    providers: [
      {
        provide: SystemApiService,
        useValue: {
          getRadioSettings: vi.fn(() =>
            of({
              genreAffinity: opts.genreAffinity ?? false,
              centroids: opts.centroids ?? 0,
              computedAt: opts.centroids ? 1 : null,
            }),
          ),
          saveRadioSettings: save,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(RadioSettingsPanelComponent);
  return { fixture, save };
}

async function render(fixture: ReturnType<typeof setup>['fixture']) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  expandAllGroups(fixture);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('RadioSettingsPanelComponent (learned genre axis opt-in)', () => {
  it('renders the toggle OFF by default and says no genre profiles exist yet', async () => {
    const { fixture } = setup();
    const el = await render(fixture);
    const toggle = el.querySelector<HTMLInputElement>(
      '[data-testid="radio-genre-affinity-toggle"]',
    )!;
    expect(toggle.checked).toBe(false);
    // D-pad reachable inside its own row group, like every other admin checkbox.
    expect(toggle.hasAttribute('appTvNavItem')).toBe(true);
    expect(toggle.closest('[appTvNavGroup]')).not.toBeNull();
    // No translations are loaded in unit specs: the pipe echoes the key.
    expect(el.querySelector('[data-testid="radio-genre-affinity-status"]')!.textContent).toContain(
      'admin.radioGenreAffinityNone',
    );
    fixture.destroy();
  });

  it('shows how many genre profiles back the axis', async () => {
    const { fixture } = setup({ centroids: 833, genreAffinity: true });
    const el = await render(fixture);
    expect(
      el.querySelector<HTMLInputElement>('[data-testid="radio-genre-affinity-toggle"]')!.checked,
    ).toBe(true);
    expect(el.querySelector('[data-testid="radio-genre-affinity-status"]')!.textContent).toContain(
      'admin.radioGenreAffinityStatus',
    );
    fixture.destroy();
  });

  it('a toggle change saves the patch and echoes the server state back', async () => {
    const { fixture, save } = setup();
    const el = await render(fixture);
    const toggle = el.querySelector<HTMLInputElement>(
      '[data-testid="radio-genre-affinity-toggle"]',
    )!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(save).toHaveBeenCalledWith({ genreAffinity: true });
    expect(fixture.componentInstance.radio()?.centroids).toBe(833);
    expect(fixture.componentInstance.message()?.type).toBe('success');
    fixture.destroy();
  });

  it('reports a failed save without losing the loaded state', async () => {
    const { fixture } = setup({ saveFails: true });
    await render(fixture);
    await fixture.componentInstance.save({ genreAffinity: true });
    expect(fixture.componentInstance.message()?.type).toBe('error');
    expect(fixture.componentInstance.radio()?.genreAffinity).toBe(false);
    fixture.destroy();
  });
});
