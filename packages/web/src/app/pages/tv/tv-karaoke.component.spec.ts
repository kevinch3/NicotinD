import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, type Observable } from 'rxjs';
import { vi } from 'vitest';
import type { LyricsDto } from '@nicotind/core';
import { TvKaraokeComponent } from './tv-karaoke.component';
import { PlayerService, type Track } from '../../services/player.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import { BackButtonService } from '../../services/native/back-button.service';
import { TranslateService } from '../../services/translate.service';
import { KaraokeBrowseMode } from '../../lib/karaoke-browse';

const track: Track = { id: 's1', title: 'Opening Static', artist: 'E2E Test Artist' };

function synced(): LyricsDto {
  return {
    plain: 'one\ntwo',
    synced: '[00:01.00]one\n[00:03.00]two',
    source: 'lrclib',
    customized: false,
    updatedAt: 0,
    offsetMs: 0,
  };
}

describe('TvKaraokeComponent (#1134)', () => {
  function create(lyrics: LyricsDto | null = null) {
    const api = {
      getLyrics: vi.fn<(id: string) => Observable<LyricsDto | null>>(() => of(lyrics)),
      fetchLyrics: vi.fn<(id: string, force?: boolean) => Observable<LyricsDto | null>>(() =>
        of(null),
      ),
    };
    TestBed.configureTestingModule({
      imports: [TvKaraokeComponent],
      providers: [
        provideRouter([]),
        { provide: LibraryApiService, useValue: api },
        {
          provide: TranslateService,
          useValue: { t: (key: string) => key, lang: () => 'en', revision: () => 0 },
        },
      ],
    });
    const player = TestBed.inject(PlayerService);
    player.play(track);
    const fixture = TestBed.createComponent(TvKaraokeComponent);
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    fixture.detectChanges();
    return { fixture, player, api, closed };
  }

  const q = (fixture: { nativeElement: HTMLElement }, sel: string) =>
    fixture.nativeElement.querySelector<HTMLElement>(sel);

  afterEach(() => localStorage.clear());

  it('mounts the same fullscreen overlay the phone uses, for the playing track', () => {
    const { fixture, api } = create();

    expect(q(fixture, '[data-testid="karaoke-overlay"]')).not.toBeNull();
    expect(api.getLyrics).toHaveBeenCalledWith('s1');
    expect(fixture.componentInstance.title()).toBe('Opening Static');
  });

  it('follows the queue: a new track under the overlay loads its own lyrics', () => {
    const { fixture, player, api } = create();

    player.play({ id: 's2', title: 'Second Wind', artist: 'E2E Test Artist' });
    fixture.detectChanges();

    expect(api.getLyrics).toHaveBeenLastCalledWith('s2');
  });

  // The overlay's own buttons (exit, browse, mute, transport) are covered by
  // now-playing-karaoke-fullscreen.component.spec.ts, and the bindings from
  // this wrapper onto them by the TV e2e project: under this JIT harness a
  // parent's bindings onto a child's signal inputs and outputs do not resolve
  // (src/testing/signal-input.ts), so a click routed through the child here
  // would prove nothing either way. What follows is the wiring this component
  // owns.

  it('Escape and hardware Back close the overlay first, not the route (#398 stack)', () => {
    const { closed } = create();

    expect(TestBed.inject(BackButtonService).stack.handleBack()).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('a browse-list line seeks there and returns to auto-follow', () => {
    const { fixture, player } = create(synced());
    const seek = vi.spyOn(player, 'seek').mockImplementation(() => {});
    fixture.componentInstance.browse.interact();
    expect(fixture.componentInstance.browse.browsing()).toBe(true);

    fixture.componentInstance.seekToLine(1);

    expect(seek).toHaveBeenCalledWith(3);
    expect(fixture.componentInstance.browse.browsing()).toBe(false);
  });

  it('ignores a line that does not exist', () => {
    const { fixture, player } = create(synced());
    const seek = vi.spyOn(player, 'seek').mockImplementation(() => {});

    fixture.componentInstance.seekToLine(7);

    expect(seek).not.toHaveBeenCalled();
  });

  it('highlights the line under the playhead', () => {
    const { fixture, player } = create(synced());

    player.currentTime.set(3.5);

    expect(fixture.componentInstance.activeLine()).toBe(1);
    expect(fixture.componentInstance.currentLineText()).toBe('two');
    expect(fixture.componentInstance.nextLineText()).toBeNull();
  });

  it('play/pause drives the local player — this TV is the audio output', () => {
    const { fixture, player } = create();
    expect(player.isPlaying()).toBe(true);

    fixture.componentInstance.togglePlay();
    expect(player.isPlaying()).toBe(false);

    fixture.componentInstance.togglePlay();
    expect(player.isPlaying()).toBe(true);
  });

  it('the idle countdown cannot outlive the overlay', () => {
    vi.useFakeTimers();
    try {
      const { fixture } = create();
      const { browse } = fixture.componentInstance;
      browse.interact();
      fixture.destroy();

      // A countdown that survived destruction would flip this back to
      // auto-follow; disarmed, nothing changes however long we wait.
      vi.advanceTimersByTime(KaraokeBrowseMode.IDLE_MS * 2);
      expect(browse.browsing()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
