import { TestBed } from '@angular/core/testing';
import { NowPlayingTvQueueComponent } from './now-playing-tv-queue.component';
import { BackButtonService } from '../../../services/native/back-button.service';
import { setInputValue } from '../../../../testing/signal-input';

/**
 * The lightweight D-pad queue overlay the TV Next-up chip opens (issue #399).
 * The desktop queue panel is template-gated off on TV, so jump/remove come
 * from here.
 */
describe('NowPlayingTvQueueComponent', () => {
  const tracks = [
    { id: 'a', title: 'Opening Static', artist: 'E2E Test Artist' },
    { id: 'b', title: 'Second Wind', artist: 'E2E Test Artist' },
  ];

  function create() {
    const fixture = TestBed.createComponent(NowPlayingTvQueueComponent);
    setInputValue(fixture.componentInstance.queue, tracks as never);
    fixture.detectChanges();
    return fixture;
  }

  it('renders one row per queued track', () => {
    const fixture = create();
    const rows = fixture.nativeElement.querySelectorAll('[data-testid="tv-queue-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Opening Static');
  });

  it('activating a row emits jump with its index', () => {
    const fixture = create();
    let jumped: number | undefined;
    fixture.componentInstance.jump.subscribe((i: number) => (jumped = i));
    fixture.nativeElement.querySelectorAll('[data-testid="tv-queue-row"]')[1].click();
    expect(jumped).toBe(1);
  });

  it('the row remove button emits remove, not jump', () => {
    const fixture = create();
    let jumped: number | undefined;
    let removed: number | undefined;
    fixture.componentInstance.jump.subscribe((i: number) => (jumped = i));
    fixture.componentInstance.remove.subscribe((i: number) => (removed = i));
    fixture.nativeElement.querySelectorAll('[data-testid="tv-queue-remove"]')[0].click();
    expect(removed).toBe(0);
    expect(jumped).toBeUndefined();
  });

  it('registers on the back stack: Escape/Back emits closed (issue #398 shape)', () => {
    const fixture = create();
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    expect(TestBed.inject(BackButtonService).stack.handleBack()).toBe(true);
    expect(closed).toBe(1);
  });

  it('autofocuses the first row so the D-pad lands inside the overlay', () => {
    const fixture = create();
    // ngAfterViewChecked drives the one-shot autofocus (the JIT-harness-safe
    // pattern MenuPanel established).
    fixture.detectChanges();
    expect(document.activeElement?.getAttribute('data-testid')).toBe('tv-queue-row');
  });
});
