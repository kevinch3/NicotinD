import { TestBed } from '@angular/core/testing';
import { ConfirmDialogComponent } from './confirm-dialog.component';
import { BackButtonService } from '../../services/native/back-button.service';
import { setInputValue } from '../../../testing/signal-input';

/**
 * The `@if`-rendered-modal shape of issue #398: the component registers its
 * cancel path on the shared BackHandlerStack for its whole lifetime (open =
 * alive), so one Escape / hardware Back press cancels the topmost dialog —
 * replacing the per-component `document:keydown.escape` handlers that all
 * fired at once when overlays stacked.
 */
describe('ConfirmDialogComponent (issue #398 stack registration)', () => {
  function create() {
    const fixture = TestBed.createComponent(ConfirmDialogComponent);
    setInputValue(fixture.componentInstance.message, 'Sure?');
    fixture.detectChanges();
    return fixture;
  }

  it('registers a stack closer that emits cancel', () => {
    const fixture = create();
    let cancelled = 0;
    fixture.componentInstance.cancel.subscribe(() => cancelled++);
    expect(TestBed.inject(BackButtonService).stack.handleBack()).toBe(true);
    expect(cancelled).toBe(1);
  });

  it('unregisters when the dialog leaves the DOM', () => {
    const fixture = create();
    fixture.destroy();
    expect(TestBed.inject(BackButtonService).stack.handleBack()).toBe(false);
  });
});
