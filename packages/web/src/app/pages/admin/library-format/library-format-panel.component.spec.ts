import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { LibraryFormatPanelComponent } from './library-format-panel.component';
import { SystemApiService } from '../../../services/api/system-api.service';
import { expandAllGroups } from '../../../../testing/expand-groups';

/** Two formats: the current one, and one that would re-encode 12 songs. */
const SETTINGS = {
  format: 'opus',
  ffmpegAvailable: true,
  available: [
    {
      id: 'opus',
      ext: 'opus',
      canNormalizeLoudness: true,
      maxEmbeddedPictureBytes: 524288,
      impact: { alreadyTarget: 12, wouldReEncode: 0, destructive: false },
    },
    {
      id: 'mp3',
      ext: 'mp3',
      canNormalizeLoudness: false,
      maxEmbeddedPictureBytes: null,
      impact: { alreadyTarget: 0, wouldReEncode: 12, destructive: true },
    },
  ],
};

function setup(save = vi.fn(() => of({ ...SETTINGS, format: 'mp3' }))) {
  TestBed.configureTestingModule({
    imports: [LibraryFormatPanelComponent],
    providers: [
      {
        provide: SystemApiService,
        useValue: {
          getLibraryFormatSettings: vi.fn(() => of(structuredClone(SETTINGS))),
          saveLibraryFormat: save,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(LibraryFormatPanelComponent);
  return { fixture, save };
}

async function render(fixture: ReturnType<typeof setup>['fixture']) {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  expandAllGroups(fixture);
  return fixture.nativeElement as HTMLElement;
}

describe('LibraryFormatPanelComponent', () => {
  it('states each format capability beside the choice, not in a doc', async () => {
    // #1256's stated trap: a selector that silently turns off loudness
    // normalization is worse than no selector, because the capability loss has
    // no symptom afterwards. So the warning has to be on the option itself.
    const { fixture } = setup();
    const el = await render(fixture);
    // Asserted on the i18n KEY, not the English copy: the pipe is unresolved
    // under test, and pinning prose would make this fail on a wording change
    // rather than on the behaviour it is here to protect.
    const mp3 = el.querySelector('[data-testid="library-format-option-mp3"]')!;
    expect(mp3.textContent).toContain('admin.libraryFormatGainNo');
    const opus = el.querySelector('[data-testid="library-format-option-opus"]')!;
    expect(opus.textContent).toContain('admin.libraryFormatGainYes');
  });

  it('does NOT save straight away when the change would re-encode files', async () => {
    // The whole reason this is not a plain dropdown. Switching on a populated
    // library queues a whole-library re-encode and re-mints every song id.
    const { fixture, save } = setup();
    await render(fixture);
    fixture.componentInstance.select(SETTINGS.available[1]!);
    fixture.detectChanges();

    expect(save).not.toHaveBeenCalled();
    const confirm = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="library-format-confirm"]',
    );
    expect(confirm).toBeTruthy();
    // The count is quoted, not a vague warning.
    expect(confirm!.textContent).toContain('12');
  });

  it('sends confirm only after the operator has seen the count', async () => {
    const { fixture, save } = setup();
    await render(fixture);
    fixture.componentInstance.select(SETTINGS.available[1]!);
    fixture.detectChanges();
    fixture.componentInstance.confirmPending();
    await fixture.whenStable();

    expect(save).toHaveBeenCalledWith('mp3', true);
  });

  it('cancelling leaves the format alone', async () => {
    const { fixture, save } = setup();
    await render(fixture);
    fixture.componentInstance.select(SETTINGS.available[1]!);
    fixture.componentInstance.cancelPending();
    fixture.detectChanges();

    expect(save).not.toHaveBeenCalled();
    expect(fixture.componentInstance.settings()?.format).toBe('opus');
  });

  it('applies a non-destructive change without asking', async () => {
    // Choosing a format on a library that holds nothing else is free, and
    // making an operator confirm a no-op teaches them to click through.
    const free = {
      ...SETTINGS.available[1]!,
      impact: { alreadyTarget: 0, wouldReEncode: 0, destructive: false },
    };
    const { fixture, save } = setup();
    await render(fixture);
    fixture.componentInstance.select(free);
    await fixture.whenStable();

    expect(save).toHaveBeenCalledWith('mp3', false);
  });

  it('re-selecting the current format does nothing', async () => {
    const { fixture, save } = setup();
    await render(fixture);
    fixture.componentInstance.select(SETTINGS.available[0]!);
    expect(save).not.toHaveBeenCalled();
  });
});
