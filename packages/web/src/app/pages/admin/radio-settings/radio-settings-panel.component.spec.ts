import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { RadioSettingsPanelComponent } from './radio-settings-panel.component';
import { SystemApiService } from '../../../services/api/system-api.service';
import { expandAllGroups } from '../../../../testing/expand-groups';

function setup(
  opts: {
    centroids?: number;
    genreAffinity?: boolean;
    queueTarget?: number;
    saveFails?: boolean;
  } = {},
) {
  const save = vi.fn((p: { genreAffinity?: boolean; queueTarget?: number }) =>
    opts.saveFails
      ? throwError(() => new Error('boom'))
      : of({
          genreAffinity: p.genreAffinity ?? false,
          queueTarget: p.queueTarget ?? opts.queueTarget ?? 20,
          centroids: 833,
          computedAt: 1,
        }),
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
              queueTarget: opts.queueTarget ?? 20,
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

  describe('queue depth', () => {
    it('shows the depth the server holds', async () => {
      const { fixture } = setup({ queueTarget: 30 });
      const el = await render(fixture);
      const select = el.querySelector<HTMLSelectElement>('[data-testid="radio-queue-target"]')!;
      expect(select.value).toBe('30');
      // D-pad reachable inside its own row group, like every other admin control.
      expect(select.hasAttribute('appTvNavItem')).toBe(true);
      expect(select.closest('[appTvNavGroup]')).not.toBeNull();
      fixture.destroy();
    });

    /** The `+` coercion is load-bearing: the server drops a string outright. */
    it('saves a chosen depth as a number', async () => {
      const { fixture, save } = setup({ queueTarget: 20 });
      const el = await render(fixture);
      const select = el.querySelector<HTMLSelectElement>('[data-testid="radio-queue-target"]')!;
      select.value = '40';
      select.dispatchEvent(new Event('change'));
      await fixture.whenStable();

      expect(save).toHaveBeenCalledWith({ queueTarget: 40 });
      fixture.destroy();
    });

    it('offers only depths the server will accept', async () => {
      const { fixture } = setup();
      const el = await render(fixture);
      const options = [
        ...el.querySelectorAll<HTMLOptionElement>('[data-testid="radio-queue-target"] option'),
      ].map((o) => Number(o.value));
      expect(Math.min(...options)).toBeGreaterThanOrEqual(5);
      expect(Math.max(...options)).toBeLessThanOrEqual(50);
      fixture.destroy();
    });
  });
});
