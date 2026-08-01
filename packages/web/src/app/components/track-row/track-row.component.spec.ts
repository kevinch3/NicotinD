import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TrackRowComponent } from './track-row.component';
import { PlayerService, type Track } from '../../services/player.service';
import { AuthService } from '../../services/auth.service';
import { ServerConfigService } from '../../services/server-config.service';
import { LikeService } from '../../services/like.service';
import { setInputValue } from '../../../testing/signal-input';

const ROW_TRACK: Track = { id: 't1', title: 'Song One', artist: 'Artist A' };
const OTHER_TRACK: Track = { id: 't2', title: 'Song Two', artist: 'Artist B' };

/**
 * Signal inputs are driven via the shared `setInputValue` helper — the JIT
 * harness registers no signal inputs, so neither a `[foo]="…"` binding nor
 * `componentRef.setInput()` reaches them. The full rationale, the measured
 * no-op of the supported API, and the call-before-detectChanges rule live in
 * `src/testing/signal-input.ts`. Here the row itself is the unit under test, so
 * it renders the real production template rather than a stub.
 */
describe('TrackRowComponent — current-track indicator', () => {
  function setup() {
    TestBed.configureTestingModule({
      imports: [TrackRowComponent],
      providers: [
        PlayerService,
        { provide: AuthService, useValue: { token: signal('test-token') } },
        { provide: ServerConfigService, useValue: { apiUrl: (u: string) => u } },
        { provide: LikeService, useValue: { isLiked: () => false, toggle: () => {} } },
      ],
    });
    const fixture = TestBed.createComponent(TrackRowComponent);
    setInputValue(fixture.componentInstance.track, ROW_TRACK);
    setInputValue(fixture.componentInstance.indexLabel, 3);
    setInputValue(fixture.componentInstance.showCover, false);
    const player = TestBed.inject(PlayerService);
    player.clear();
    fixture.detectChanges();
    const row = () =>
      fixture.nativeElement.querySelector('[data-testid="track-row"]') as HTMLElement;
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

  it('the title button is a valid D-pad nav item (marked appTvNavItem)', () => {
    const { fixture } = setup();
    fixture.detectChanges();
    const title: HTMLElement = fixture.nativeElement.querySelector(
      '[data-testid="track-row-title"]',
    );
    expect(title.hasAttribute('appTvNavItem')).toBe(true);
  });
});
