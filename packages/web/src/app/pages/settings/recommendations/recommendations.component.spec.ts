import { Component, input, output } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { RecommendationsSettingsComponent } from './recommendations.component';
import { TrackRowComponent } from '../../../components/track-row/track-row.component';
import { RecommendationsApiService } from '../../../services/api/recommendations-api.service';
import { PlayerService } from '../../../services/player.service';
import type { ExcludedSong } from '../../../services/api/api-types';

// TrackRowComponent declares `track` as input.required, and this JIT harness
// doesn't register inputs on a *nested* component — rendering the real row
// throws NG0950 (see src/testing/signal-input.ts, landmine 1). The row has its
// own spec; here the stub renders the subtitle and a Remove button so the
// page's reason text and restore wiring stay observable.
@Component({
  selector: 'app-track-row',
  standalone: true,
  template:
    '<div class="row">{{ subtitle() }}<button type="button" title="Remove" (click)="remove.emit()"></button></div>',
})
class TrackRowStub {
  readonly track = input<unknown>();
  readonly subtitle = input<string>();
  readonly artists = input<unknown>();
  readonly duration = input<unknown>();
  readonly showRemove = input<unknown>();
  readonly showLike = input<unknown>();
  readonly play = output<void>();
  readonly remove = output<void>();
}

const rows: ExcludedSong[] = [
  {
    songId: 's1',
    reason: 'explicit',
    since: 2,
    song: { id: 's1', title: 'Toxic', artist: 'Britney', duration: 200 },
  },
  {
    songId: 's2',
    reason: 'skips',
    since: 1,
    skips: 3,
    song: { id: 's2', title: 'Skippy', artist: 'B', duration: 100 },
  },
  { songId: 'gone', reason: 'explicit', since: 0, song: null },
];

async function setup(excluded: ExcludedSong[] = rows) {
  const api = {
    getExcluded: vi.fn(() => of({ excluded })),
    feedback: vi.fn(() => of({ id: 1 })),
    restore: vi.fn(() => of({ ok: true })),
  };
  const player = {
    playSingle: vi.fn(),
    currentTrack: () => null,
    isPlaying: () => false,
    buffering: () => false,
    bufferingVisible: () => false,
  };
  TestBed.configureTestingModule({
    imports: [RecommendationsSettingsComponent],
    providers: [
      provideRouter([]),
      { provide: RecommendationsApiService, useValue: api },
      { provide: PlayerService, useValue: player },
    ],
  });
  TestBed.overrideComponent(RecommendationsSettingsComponent, {
    remove: { imports: [TrackRowComponent] },
    add: { imports: [TrackRowStub] },
  });
  const fixture = TestBed.createComponent(RecommendationsSettingsComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  // Settings groups render collapsed; open every toggle before asserting.
  const host = fixture.nativeElement as HTMLElement;
  for (const t of Array.from(
    host.querySelectorAll<HTMLButtonElement>('[data-testid="settings-group-toggle"]'),
  )) {
    // The open state is remembered in localStorage per group, which outlives
    // one spec's TestBed — only open a group that is actually closed.
    if (t.getAttribute('aria-expanded') !== 'true') t.click();
  }
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, api, player, el: fixture.nativeElement as HTMLElement };
}

describe('RecommendationsSettingsComponent', () => {
  it('lists every excluded song, and names the reason for each', async () => {
    const { el, fixture } = await setup();
    const items = el.querySelectorAll('[data-testid="recommendations-excluded-row"]');
    expect(items).toHaveLength(3);
    // Nested inputs never land in this harness, so the reason line is pinned
    // through the method the template binds rather than the rendered text.
    const cmp = fixture.componentInstance;
    expect(cmp.reasonKey(rows[0]!)).toBe('recommendations.reasonExplicit');
    expect(cmp.reasonKey(rows[1]!)).toBe('recommendations.reasonSkips');
    expect(cmp.reasonKey(rows[2]!)).toBe('recommendations.gone');
  });

  it('shows the empty state once loaded with nothing held out', async () => {
    const { el } = await setup([]);
    expect(el.querySelector('[data-testid="recommendations-empty"]')).toBeTruthy();
  });

  it('the row remove control restores the song and drops it from the list', async () => {
    const { el, api, fixture } = await setup();
    fixture.componentInstance.restore(rows[0]!);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.restore).toHaveBeenCalledWith('s1');
    expect(el.querySelector('[data-song-id="s1"]')).toBeNull();
    expect(el.querySelectorAll('[data-testid="recommendations-excluded-row"]')).toHaveLength(2);
  });
});
