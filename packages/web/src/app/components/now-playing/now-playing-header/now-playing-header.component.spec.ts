import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NowPlayingHeaderComponent } from './now-playing-header.component';
import { PlayerService } from '../../../services/player.service';
import { PlaybackWsService } from '../../../services/playback-ws.service';
import { RemotePlaybackService } from '../../../services/remote-playback.service';

describe('NowPlayingHeaderComponent', () => {
  let setNowPlayingOpen: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setNowPlayingOpen = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: PlayerService,
          // The header now reads the session's identity to name it (#996), so
          // the stub has to carry those signals as well as the close action.
          useValue: {
            setNowPlayingOpen,
            radio: signal(false),
            radioFilter: signal(null),
            context: signal(null),
            currentTrack: signal(null),
          },
        },
        {
          provide: RemotePlaybackService,
          useValue: {
            devices: signal([]),
            activeDeviceId: signal(null),
            switcherOpen: signal(false),
            setSwitcherOpen: vi.fn(),
            switchToDevice: vi.fn(),
          },
        },
        {
          provide: PlaybackWsService,
          useValue: { getDeviceId: () => 'me', getDeviceName: () => 'Me' },
        },
      ],
    });
  });

  it('closes the sheet when the close button is clicked', () => {
    const fixture = TestBed.createComponent(NowPlayingHeaderComponent);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('button').click();
    expect(setNowPlayingOpen).toHaveBeenCalledWith(false);
  });

  it('emits dragPointerDown on handle pointerdown', () => {
    const fixture = TestBed.createComponent(NowPlayingHeaderComponent);
    fixture.detectChanges();
    let emitted: PointerEvent | undefined;
    fixture.componentInstance.dragPointerDown.subscribe((e: PointerEvent) => (emitted = e));
    const handleRoot = fixture.nativeElement.querySelector(
      '[data-testid="now-playing-drag-handle"]',
    );
    handleRoot.dispatchEvent(new PointerEvent('pointerdown'));
    expect(emitted).toBeTruthy();
  });
});
