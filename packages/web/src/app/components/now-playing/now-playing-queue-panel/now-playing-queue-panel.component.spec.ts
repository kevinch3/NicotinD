import { TestBed } from '@angular/core/testing';
import { NowPlayingQueuePanelComponent } from './now-playing-queue-panel.component';
import { PlayerService } from '../../../services/player.service';
import { AuthService } from '../../../services/auth.service';
import { provideRouter } from '@angular/router';

describe('NowPlayingQueuePanelComponent', () => {
  let jumpToQueueIndex: ReturnType<typeof vi.fn>;
  let queue: Array<{
    id: string;
    title: string;
    artist: string;
    coverArt?: string;
    album?: string;
    albumId?: string;
  }>;

  beforeEach(() => {
    jumpToQueueIndex = vi.fn();
    queue = [{ id: 'a', title: 'A', artist: 'Artist A', album: 'Album A', albumId: 'al-a' }];
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
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

  it('the jump target is the title button, not a wrapper around the whole row', () => {
    // An anchor may not sit inside a button, so the artist/album entity links
    // live beside the title button rather than inside one big jump button.
    const fixture = TestBed.createComponent(NowPlayingQueuePanelComponent);
    fixture.detectChanges();
    const row: HTMLElement = fixture.nativeElement.querySelector('[data-testid="queue-row"]');
    expect(row.tagName).toBe('DIV');
    const title: HTMLButtonElement = row.querySelector('[data-testid="queue-row-title"]')!;
    expect(title.tagName).toBe('BUTTON');
    expect(title.hasAttribute('appTvNavItem')).toBe(true);
    expect(title.textContent).toContain('A');
    expect(row.querySelector('app-artist-links')).not.toBeNull();
    expect(row.querySelector('app-entity-link')).not.toBeNull();
    expect(title.querySelector('a, app-entity-link, app-artist-links')).toBeNull();
    title.click();
    expect(jumpToQueueIndex).toHaveBeenCalledWith(0);
  });

  it('renders no album link when the queue track has no album', () => {
    queue = [{ id: 'a', title: 'A', artist: 'Artist A' }];
    const fixture = TestBed.createComponent(NowPlayingQueuePanelComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-entity-link')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('·');
  });

  it('keeps the remove button as the row’s other nav item, after the title', () => {
    const fixture = TestBed.createComponent(NowPlayingQueuePanelComponent);
    fixture.detectChanges();
    const items: HTMLElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('[appTvNavItem]'),
    );
    expect(items[0]!.getAttribute('data-testid')).toBe('queue-row-title');
    expect(items[items.length - 1]!.getAttribute('data-testid')).toBe('queue-remove');
  });

  it('shows an empty state with no queue', () => {
    queue = [];
    const fixture = TestBed.createComponent(NowPlayingQueuePanelComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('nowPlaying.queueEmpty');
  });

  it('no longer owns the resize handle (hoisted to the shell, above the tabs)', () => {
    const fixture = TestBed.createComponent(NowPlayingQueuePanelComponent);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="now-playing-queue-resize"]'),
    ).toBeNull();
  });
});
