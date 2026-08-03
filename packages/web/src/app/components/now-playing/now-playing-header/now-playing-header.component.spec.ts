import { TestBed } from '@angular/core/testing';
import { NowPlayingHeaderComponent } from './now-playing-header.component';
import { PlayerService } from '../../../services/player.service';
import { RemotePlaybackService } from '../../../services/remote-playback.service';

describe('NowPlayingHeaderComponent', () => {
  let setNowPlayingOpen: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setNowPlayingOpen = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: PlayerService, useValue: { setNowPlayingOpen } },
        { provide: RemotePlaybackService, useValue: { remoteEnabled: () => false } },
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
