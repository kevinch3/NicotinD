import { Component } from '@angular/core';
import { vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TvPlayerComponent } from './tv-player.component';
import { TvKaraokeComponent } from './tv-karaoke.component';
import { PlayerService, type Track } from '../../services/player.service';
import { RemotePlaybackService } from '../../services/remote-playback.service';
import { TranslateService } from '../../services/translate.service';

const track = (id: string): Track => ({ id, title: id.toUpperCase(), artist: 'E2E Test Artist' });

/** The overlay has its own spec; here only the mount/unmount wiring matters. */
@Component({ selector: 'app-tv-karaoke', template: '' })
class StubTvKaraokeComponent {}

describe('TvPlayerComponent', () => {
  function create() {
    TestBed.configureTestingModule({
      imports: [TvPlayerComponent],
      providers: [
        provideRouter([]),
        // A real catalog, so the "Playing on <device>" assertion below reads
        // what a viewer reads rather than an un-interpolated key.
        {
          provide: TranslateService,
          useValue: {
            t: (key: string, params?: Record<string, string>) =>
              key === 'remote.playingOn' ? `Playing on ${params?.['name']}` : key,
            lang: () => 'en',
            // TranslatePipe reads this unconditionally (#1106) — a `useValue`
            // stub standing in for the whole service must carry it too.
            revision: () => 0,
          },
        },
      ],
    });
    TestBed.overrideComponent(TvPlayerComponent, {
      remove: { imports: [TvKaraokeComponent] },
      add: { imports: [StubTvKaraokeComponent] },
    });
    const player = TestBed.inject(PlayerService);
    const remote = TestBed.inject(RemotePlaybackService);
    player.play(track('s1'));
    const fixture = TestBed.createComponent(TvPlayerComponent);
    fixture.detectChanges();
    return { fixture, player, remote };
  }

  const q = (fixture: { nativeElement: HTMLElement }, id: string) =>
    fixture.nativeElement.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  afterEach(() => localStorage.clear());

  it('has no Next-up control while nothing is queued', () => {
    const { fixture } = create();

    expect(q(fixture, 'tv-next-up')).toBeNull();
  });

  it('opens the D-pad queue from the Next-up chip — reachable at last (#1127)', () => {
    // The overlay's own rows are covered by now-playing-tv-queue.component.spec;
    // template bindings onto a child's signal inputs do not resolve under this
    // JIT test setup (src/testing/signal-input.ts), so this asserts the wiring
    // this component owns: the chip opens the overlay at all, which on TV it
    // never did — the component shipped mounted only by the phone sheet.
    const { fixture, player } = create();
    player.queue.set([track('s2'), track('s3')]);
    fixture.detectChanges();

    expect(q(fixture, 'tv-queue-overlay')).toBeNull();
    q(fixture, 'tv-next-up')!.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.queueOpen()).toBe(true);
    expect(q(fixture, 'tv-queue-overlay')).not.toBeNull();
  });

  it('jumping in the queue plays that track and closes the overlay', () => {
    const { fixture, player } = create();
    player.queue.set([track('s2'), track('s3')]);
    fixture.componentInstance.queueOpen.set(true);

    fixture.componentInstance.onQueueJump(1);

    expect(player.currentTrack()?.id).toBe('s3');
    expect(fixture.componentInstance.queueOpen()).toBe(false);
  });

  it('removing from the queue leaves the overlay open to remove another', () => {
    const { fixture, player } = create();
    player.queue.set([track('s2'), track('s3')]);
    fixture.componentInstance.queueOpen.set(true);

    fixture.componentInstance.onQueueRemove(0);

    expect(player.queue().map((t) => t.id)).toEqual(['s3']);
    expect(fixture.componentInstance.queueOpen()).toBe(true);
  });

  describe('karaoke (#1134)', () => {
    it('the Lyrics row mounts the overlay — the surface this route never had', () => {
      const { fixture } = create();

      expect(fixture.nativeElement.querySelector('app-tv-karaoke')).toBeNull();
      q(fixture, 'tv-lyrics')!.click();
      fixture.detectChanges();

      expect(fixture.componentInstance.karaokeOpen()).toBe(true);
      expect(fixture.nativeElement.querySelector('app-tv-karaoke')).not.toBeNull();
    });

    it('closing unmounts it and hands focus back to the row that opened it', () => {
      vi.useFakeTimers();
      try {
        const { fixture } = create();
        q(fixture, 'tv-lyrics')!.click();
        fixture.detectChanges();

        fixture.componentInstance.closeKaraoke();
        fixture.detectChanges();
        vi.runAllTimers();

        expect(fixture.componentInstance.karaokeOpen()).toBe(false);
        expect(fixture.nativeElement.querySelector('app-tv-karaoke')).toBeNull();
        expect(document.activeElement).toBe(q(fixture, 'tv-lyrics'));
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('remote playback (#1128)', () => {
    it('offers the output picker even when the audio is here', () => {
      const { fixture } = create();

      expect(q(fixture, 'tv-remote-row')).not.toBeNull();
    });

    it('names the device the audio moved to', () => {
      const { fixture, remote } = create();
      remote.setDevices([{ id: 'phone', name: 'Safari on iPhone', type: 'web', lastSeen: 0 }]);
      remote.setActiveDeviceId('phone');
      fixture.detectChanges();

      expect(q(fixture, 'tv-remote-row')!.textContent).toContain('Safari on iPhone');
    });

    it('pressing the row opens the chooser, which is how the audio comes back', () => {
      const { fixture, remote } = create();

      q(fixture, 'tv-remote-row')!.click();

      expect(remote.switcherOpen()).toBe(true);
    });
  });
});
