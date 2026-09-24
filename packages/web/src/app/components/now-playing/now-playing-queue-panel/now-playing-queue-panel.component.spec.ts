import { TestBed } from '@angular/core/testing';
import { NowPlayingQueuePanelComponent } from './now-playing-queue-panel.component';
import { PlayerService } from '../../../services/player.service';
import { AuthService } from '../../../services/auth.service';
import { provideRouter } from '@angular/router';
import { ToastService } from '../../../services/toast.service';
import { LONG_PRESS_MS } from '../../../lib/row-gesture';

// jsdom lacks PointerEvent; MouseEvent stands in (same trick as row-gesture.spec).
function pointer(
  type: string,
  clientX: number,
  clientY: number,
  opts: { pointerType?: string; timeStamp?: number; target?: EventTarget } = {},
): PointerEvent {
  const e = new MouseEvent(type, { clientX, clientY, button: 0 }) as unknown as PointerEvent;
  Object.defineProperty(e, 'pointerType', { value: opts.pointerType ?? 'touch' });
  if (opts.timeStamp !== undefined)
    Object.defineProperty(e, 'timeStamp', { value: opts.timeStamp });
  if (opts.target) Object.defineProperty(e, 'target', { value: opts.target });
  return e;
}

describe('NowPlayingQueuePanelComponent', () => {
  let jumpToQueueIndex: ReturnType<typeof vi.fn>;
  let removeFromQueue: ReturnType<typeof vi.fn>;
  let moveInQueue: ReturnType<typeof vi.fn>;
  let insertInQueue: ReturnType<typeof vi.fn>;
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
    removeFromQueue = vi.fn((i: number) => {
      queue = queue.filter((_, j) => j !== i);
    });
    moveInQueue = vi.fn();
    insertInQueue = vi.fn((i: number, t: (typeof queue)[number]) => {
      queue = [...queue.slice(0, i), t, ...queue.slice(i)];
    });
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
            removeFromQueue,
            moveInQueue,
            insertInQueue,
          },
        },
        { provide: AuthService, useValue: { token: () => 'tok', mediaToken: () => 'tok' } },
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
  describe('touch gestures (#1295)', () => {
    const three = () => [
      { id: 'a', title: 'A', artist: 'X' },
      { id: 'b', title: 'B', artist: 'X' },
      { id: 'c', title: 'C', artist: 'X' },
    ];

    beforeEach(() => {
      queue = three();
      TestBed.inject(ToastService).reset();
    });
    afterEach(() => {
      TestBed.inject(ToastService).reset();
      vi.useRealTimers();
    });

    function swipe(
      component: NowPlayingQueuePanelComponent,
      index: number,
      path: Array<[x: number, t: number]>,
    ): void {
      const [x0, t0] = path[0]!;
      component.onRowPointerDown(pointer('pointerdown', x0, 50, { timeStamp: t0 }), index);
      for (const [x, t] of path.slice(1)) {
        document.dispatchEvent(pointer('pointermove', x, 50, { timeStamp: t }));
      }
      const [xe, te] = path[path.length - 1]!;
      document.dispatchEvent(pointer('pointerup', xe, 50, { timeStamp: te }));
    }

    it('a slow swipe past the threshold removes the row and offers Undo', () => {
      const fixture = TestBed.createComponent(NowPlayingQueuePanelComponent);
      fixture.detectChanges();
      swipe(fixture.componentInstance, 1, [
        [300, 0],
        [250, 500],
        [180, 1000],
        [180, 1500],
      ]);
      expect(removeFromQueue).toHaveBeenCalledWith(1);
      const toasts = TestBed.inject(ToastService).toasts();
      expect(toasts).toHaveLength(1);
      expect(toasts[0]!.duration).toBe(5);
      expect(toasts[0]!.actions?.[0]?.label).toBe('nowPlaying.undo');
    });

    it('a slow swipe short of the threshold snaps back', () => {
      const fixture = TestBed.createComponent(NowPlayingQueuePanelComponent);
      fixture.detectChanges();
      swipe(fixture.componentInstance, 1, [
        [300, 0],
        [260, 500],
        [250, 1000],
      ]);
      expect(removeFromQueue).not.toHaveBeenCalled();
      expect(fixture.componentInstance.swipeIndex()).toBeNull();
    });

    it('a short leftward flick removes', () => {
      const fixture = TestBed.createComponent(NowPlayingQueuePanelComponent);
      fixture.detectChanges();
      swipe(fixture.componentInstance, 0, [
        [300, 0],
        [285, 10],
        [260, 30],
      ]);
      expect(removeFromQueue).toHaveBeenCalledWith(0);
    });

    it('a rightward swipe never removes', () => {
      const fixture = TestBed.createComponent(NowPlayingQueuePanelComponent);
      fixture.detectChanges();
      swipe(fixture.componentInstance, 0, [
        [100, 0],
        [200, 10],
        [300, 20],
      ]);
      expect(removeFromQueue).not.toHaveBeenCalled();
    });

    it('Undo puts the track back at the index it left', () => {
      const fixture = TestBed.createComponent(NowPlayingQueuePanelComponent);
      fixture.detectChanges();
      const removed = queue[1]!;
      fixture.componentInstance.removeWithUndo(1);
      expect(queue.map((t) => t.id)).toEqual(['a', 'c']);
      const toast = TestBed.inject(ToastService);
      toast.toasts()[0]!.actions![0]!.callback();
      expect(insertInQueue).toHaveBeenCalledWith(1, removed);
      expect(queue.map((t) => t.id)).toEqual(['a', 'b', 'c']);
      expect(toast.toasts()).toHaveLength(0);
    });

    it('swallows the click a swipe ends with, so it never also jumps', () => {
      const fixture = TestBed.createComponent(NowPlayingQueuePanelComponent);
      fixture.detectChanges();
      swipe(fixture.componentInstance, 0, [
        [300, 0],
        [280, 500],
        [270, 1000],
      ]);
      const title: HTMLButtonElement = fixture.nativeElement.querySelector(
        '[data-testid="queue-row-title"]',
      );
      document.body.appendChild(fixture.nativeElement);
      title.click();
      expect(jumpToQueueIndex).not.toHaveBeenCalled();
      fixture.nativeElement.remove();
    });

    it('long-press then drag reorders through moveInQueue', () => {
      vi.useFakeTimers();
      const fixture = TestBed.createComponent(NowPlayingQueuePanelComponent);
      fixture.detectChanges();
      const items: HTMLElement[] = Array.from(
        fixture.nativeElement.querySelectorAll('[data-testid="queue-item"]'),
      );
      // jsdom lays nothing out: give the rows 50px heights at 0/50/100.
      items.forEach((el, i) => {
        el.getBoundingClientRect = () =>
          ({ top: i * 50, height: 50, bottom: i * 50 + 50 }) as DOMRect;
      });
      const component = fixture.componentInstance;
      component.onRowPointerDown(pointer('pointerdown', 100, 25), 0);
      vi.advanceTimersByTime(LONG_PRESS_MS);
      expect(component.liftIndex()).toBe(0);
      document.dispatchEvent(pointer('pointermove', 100, 140));
      expect(component.liftTarget()).toBe(2);
      // The siblings part: rows 1 and 2 slide up one row.
      expect(component.rowTransform(1)).toBe('translateY(-50px)');
      document.dispatchEvent(pointer('pointerup', 100, 140));
      expect(moveInQueue).toHaveBeenCalledWith(0, 2);
      expect(component.liftIndex()).toBeNull();
    });

    it('a mouse on the handle is left to HTML5 drag', () => {
      const fixture = TestBed.createComponent(NowPlayingQueuePanelComponent);
      fixture.detectChanges();
      const handle: HTMLElement = fixture.nativeElement.querySelector('[data-queue-handle]');
      const component = fixture.componentInstance;
      component.onRowPointerDown(
        pointer('pointerdown', 300, 50, { pointerType: 'mouse', target: handle }),
        0,
      );
      document.dispatchEvent(pointer('pointermove', 100, 50, { pointerType: 'mouse' }));
      document.dispatchEvent(pointer('pointerup', 100, 50, { pointerType: 'mouse' }));
      expect(removeFromQueue).not.toHaveBeenCalled();
    });

    it('an HTML5 drop reorders through the same handler', () => {
      const fixture = TestBed.createComponent(NowPlayingQueuePanelComponent);
      fixture.detectChanges();
      const component = fixture.componentInstance;
      const drag = new Event('dragstart') as DragEvent;
      component.onQueueDragStart(drag, 2);
      component.onQueueDrop(new Event('drop') as DragEvent, 0);
      expect(moveInQueue).toHaveBeenCalledWith(2, 0);
    });

    it('ArrowUp/ArrowDown on a focused handle move the row one step', () => {
      const fixture = TestBed.createComponent(NowPlayingQueuePanelComponent);
      fixture.detectChanges();
      const handles: HTMLElement[] = Array.from(
        fixture.nativeElement.querySelectorAll('[data-testid="queue-handle"]'),
      );
      expect(handles).toHaveLength(3);
      expect(handles[1]!.getAttribute('aria-label')).toBe('nowPlaying.reorderHandle');
      const down = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
      handles[1]!.dispatchEvent(down);
      expect(moveInQueue).toHaveBeenCalledWith(1, 2);
      expect(down.defaultPrevented).toBe(true);
      handles[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
      expect(moveInQueue).toHaveBeenCalledWith(1, 0);
    });

    it('arrow keys at the ends are a no-op', () => {
      const fixture = TestBed.createComponent(NowPlayingQueuePanelComponent);
      fixture.detectChanges();
      const handles: HTMLElement[] = Array.from(
        fixture.nativeElement.querySelectorAll('[data-testid="queue-handle"]'),
      );
      handles[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
      handles[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      expect(moveInQueue).not.toHaveBeenCalled();
    });

    it('rows are excluded from the sheet body gesture and pan-y for the list scroll', () => {
      const fixture = TestBed.createComponent(NowPlayingQueuePanelComponent);
      fixture.detectChanges();
      const item: HTMLElement = fixture.nativeElement.querySelector('[data-testid="queue-item"]');
      expect(item.hasAttribute('data-np-no-swipe')).toBe(true);
      expect(item.querySelector('.touch-pan-y')).not.toBeNull();
    });
  });
});
