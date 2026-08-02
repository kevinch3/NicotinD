import { TestBed } from '@angular/core/testing';
import { NowPlayingQueuePanelComponent } from './now-playing-queue-panel.component';
import { PlayerService } from '../../../services/player.service';
import { AuthService } from '../../../services/auth.service';

describe('NowPlayingQueuePanelComponent', () => {
  let jumpToQueueIndex: ReturnType<typeof vi.fn>;
  let queue: Array<{ id: string; title: string; artist: string; coverArt?: string }>;

  beforeEach(() => {
    jumpToQueueIndex = vi.fn();
    queue = [{ id: 'a', title: 'A', artist: 'Artist A' }];
    TestBed.configureTestingModule({
      providers: [
        {
          provide: PlayerService,
          useValue: {
            queue: () => queue,
            context: () => null,
            jumpToQueueIndex,
            clearQueue: vi.fn(),
            removeFromQueue: vi.fn(),
            moveInQueue: vi.fn(),
          },
        },
        { provide: AuthService, useValue: { token: () => 'tok' } },
      ],
    });
  });

  it('renders queue tracks and jumps on click', () => {
    const fixture = TestBed.createComponent(NowPlayingQueuePanelComponent);
    fixture.detectChanges();
    // Not the first `<button>` overall — the "Clear" button (queue.length > 0)
    // renders ahead of the track rows in the header, so target the jump
    // button specifically via its `appTvNavItem` marker (the row's other
    // interactive element, Remove, also carries it but sits second in the DOM).
    const row = fixture.nativeElement.querySelector('[appTvNavItem]');
    row.click();
    expect(jumpToQueueIndex).toHaveBeenCalledWith(0);
  });

  it('shows an empty state with no queue', () => {
    queue = [];
    const fixture = TestBed.createComponent(NowPlayingQueuePanelComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('nowPlaying.queueEmpty');
  });
});
