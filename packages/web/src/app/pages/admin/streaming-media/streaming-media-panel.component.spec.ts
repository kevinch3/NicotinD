import { describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { StreamingMediaPanelComponent } from './streaming-media-panel.component';
import { SystemApiService } from '../../../services/api/system-api.service';
import { expandAllGroups } from '../../../../testing/expand-groups';

/**
 * Moved here from `admin.component.spec.ts` when this section was extracted out
 * of the 1800-line Admin template: the assertions are about this panel, and
 * reaching them through the whole page meant standing up a provider wall for
 * services it never touches.
 */
function setup() {
  TestBed.configureTestingModule({
    imports: [StreamingMediaPanelComponent],
    providers: [
      {
        provide: SystemApiService,
        useValue: {
          getStreamingSettings: vi.fn(() =>
            of({
              transcodeEnabled: true,
              format: 'opus',
              maxBitRate: 192,
              forceTranscode: false,
              ffmpegAvailable: true,
            }),
          ),
          saveStreamingSettings: vi.fn((p: unknown) => of(p as object)),
          getVocalSeparation: vi.fn(() => of({ enabled: false, configurable: true })),
          setVocalSeparation: vi.fn((enabled: boolean) => of({ enabled, configurable: true })),
        },
      },
    ],
  });
  return TestBed.createComponent(StreamingMediaPanelComponent);
}

describe('StreamingMediaPanelComponent (TV D-pad navigation)', () => {
  it('streaming checkboxes get per-row groups; the selects stay outside every group (issue #396)', async () => {
    const fixture = setup();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentInstance.streaming.set({
      transcodeEnabled: true,
      format: 'opus',
      maxBitRate: 192,
      forceTranscode: false,
      ffmpegAvailable: true,
    } as never);
    fixture.detectChanges();
    expandAllGroups(fixture);
    const el: HTMLElement = fixture.nativeElement;
    const panel = el.querySelector('[data-testid="streaming-panel"]')!;
    const checkboxes = Array.from(panel.querySelectorAll('input[type="checkbox"]'));
    // transcode on-the-fly, ML vocal separation (issue #603), and the second
    // transcoding checkbox — every one D-pad reachable inside its own row group.
    expect(checkboxes.length).toBe(3);
    for (const checkbox of checkboxes) {
      expect(checkbox.hasAttribute('appTvNavItem')).toBe(true);
      expect(checkbox.closest('[appTvNavGroup]')).not.toBeNull();
    }
    // The structural invariant from the user-row test: a <select> is never
    // inside a nav group's subtree, so its own option cycling is never
    // intercepted (per-row exclusion, not attribute absence).
    const selects = Array.from(panel.querySelectorAll('select'));
    expect(selects.length).toBe(2);
    for (const select of selects) {
      expect(select.closest('[appTvNavGroup]')).toBeNull();
    }
    fixture.destroy();
  });
});
