import { signal } from '@angular/core';
import { ɵSIGNAL as SIGNAL } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TrackRowComponent } from './track-row.component';
import { PlayerService, type Track } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { ServerConfigService } from '../../services/server-config.service';

const ROW_TRACK: Track = { id: 't1', title: 'Song One', artist: 'Artist A' };
const OTHER_TRACK: Track = { id: 't2', title: 'Song Two', artist: 'Artist B' };

/**
 * The web JIT vitest harness (`test-setup.ts` + `@angular/compiler`, no
 * ngtsc build step) has no compile-time transform for Angular's signal
 * `input()`/`input.required()` initializer API, so an input can't be driven
 * the normal way: neither a host-template `[foo]="value"` binding nor
 * `componentRef.setInput()` reaches it — both silently fail to register
 * (`NG0303: Can't bind to 'foo'`), and reading a `.required()` input with no
 * value then throws `NG0950`. Confirmed by isolated repro against a minimal
 * component; already documented in project memory ("Web JIT vitest can't
 * drive input() signals") and in artist-detail.component.spec.ts's comment,
 * which sidesteps it by never rendering the real `<app-track-row>`. Here the
 * row itself is the unit under test, so instead we write straight to the
 * signal node behind the (Angular-exported, if internal) `ɵSIGNAL` symbol —
 * the same object Angular's own compiled setter would write to if the
 * missing transform ran. This exercises the real production template/CSS,
 * just swaps out *how* the input value gets in.
 */
// Call ONLY before the fixture's first detectChanges(): the raw .value write
// bypasses signalSetFn, so consumers that already read the signal are never
// notified and would keep rendering the stale value.
function setInputValue<T>(inputSignal: () => T, value: T): void {
  (inputSignal as unknown as Record<typeof SIGNAL, { value: T }>)[SIGNAL].value = value;
}

describe('TrackRowComponent — current-track indicator', () => {
  function setup() {
    TestBed.configureTestingModule({
      imports: [TrackRowComponent],
      providers: [
        PlayerService,
        { provide: AuthService, useValue: { token: signal('test-token') } },
        { provide: ServerConfigService, useValue: { apiUrl: (u: string) => u } },
      ],
    });
    const fixture = TestBed.createComponent(TrackRowComponent);
    setInputValue(fixture.componentInstance.track, ROW_TRACK);
    setInputValue(fixture.componentInstance.indexLabel, 3);
    setInputValue(fixture.componentInstance.showCover, false);
    const player = TestBed.inject(PlayerService);
    player.clear();
    fixture.detectChanges();
    const row = () => fixture.nativeElement.querySelector('[data-testid="track-row"]') as HTMLElement;
    return { fixture, player, row };
  }

  it('shows the index and no playback state when the row is not current', () => {
    const { player, fixture, row } = setup();
    player.currentTrack.set(OTHER_TRACK);
    fixture.detectChanges();
    expect(row().getAttribute('data-playback-state')).toBeNull();
    expect(row().textContent).toContain('3');
    expect(row().querySelector('.eq-bars')).toBeNull();
  });

  it('acknowledges instantly: current + buffering shows a spinner in the index slot', () => {
    const { player, fixture, row } = setup();
    player.currentTrack.set(ROW_TRACK);
    player.bufferingVisible.set(true);
    fixture.detectChanges();
    expect(row().getAttribute('data-playback-state')).toBe('buffering');
    expect(row().querySelector('.animate-spin')).not.toBeNull();
  });

  it('shows animated equalizer bars while playing', () => {
    const { player, fixture, row } = setup();
    player.currentTrack.set(ROW_TRACK);
    player.isPlaying.set(true);
    fixture.detectChanges();
    expect(row().getAttribute('data-playback-state')).toBe('playing');
    const bars = row().querySelector('.eq-bars');
    expect(bars).not.toBeNull();
    expect(bars!.classList.contains('eq-paused')).toBe(false);
  });

  it('shows static bars while paused and accents the title when current', () => {
    const { player, fixture, row } = setup();
    player.currentTrack.set(ROW_TRACK);
    player.isPlaying.set(false);
    fixture.detectChanges();
    expect(row().getAttribute('data-playback-state')).toBe('paused');
    expect(row().querySelector('.eq-bars.eq-paused')).not.toBeNull();
    const title = row().querySelector('[data-testid="track-row-title"] p') as HTMLElement;
    expect(title.classList.contains('text-theme-accent')).toBe(true);
  });
});
