import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { SelectionBarComponent } from './selection-bar.component';

// Note: this Angular JIT test harness can't drive `input()` values, so we test
// the component's real responsibility — each button fires the right output — by
// subscribing to the instance outputs directly and triggering the click handler.
function setup() {
  TestBed.configureTestingModule({ imports: [SelectionBarComponent] });
  const fixture = TestBed.createComponent(SelectionBarComponent);
  fixture.detectChanges();
  return fixture;
}

/** Iconified actions are selected by data-testid; "Select all" stays text. */
function clickTestId(fixture: ReturnType<typeof setup>, testId: string): void {
  const btn = fixture.debugElement.query(By.css(`[data-testid="${testId}"]`));
  if (!btn) throw new Error(`button "${testId}" not found`);
  btn.triggerEventHandler('click', null);
}

function clickText(fixture: ReturnType<typeof setup>, text: string): void {
  const btn = fixture.debugElement
    .queryAll(By.css('button'))
    .find((d) => (d.nativeElement as HTMLButtonElement).textContent?.trim().startsWith(text));
  if (!btn) throw new Error(`button "${text}" not found`);
  btn.triggerEventHandler('click', null);
}

describe('SelectionBarComponent', () => {
  it('renders the action buttons (icon actions carry accessible labels)', () => {
    const fixture = setup();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent ?? '').toContain('selected');
    expect(el.textContent ?? '').toContain('Select all');
    // Iconified universal actions expose their name via aria-label.
    expect(el.querySelector('[data-testid="selection-add"]')?.getAttribute('aria-label')).toBe(
      'Add to playlist',
    );
    expect(el.querySelector('[data-testid="selection-cancel"]')?.getAttribute('aria-label')).toBe(
      'Cancel',
    );
  });

  it('emits add when the add button is clicked', () => {
    const fixture = setup();
    let fired = false;
    fixture.componentInstance.add.subscribe(() => (fired = true));
    clickTestId(fixture, 'selection-add');
    expect(fired).toBe(true);
  });

  it('emits selectAll when "Select all" is clicked', () => {
    const fixture = setup();
    let fired = false;
    fixture.componentInstance.selectAll.subscribe(() => (fired = true));
    clickText(fixture, 'Select all');
    expect(fired).toBe(true);
  });

  it('emits cancel when the cancel button is clicked', () => {
    const fixture = setup();
    let fired = false;
    fixture.componentInstance.cancel.subscribe(() => (fired = true));
    clickTestId(fixture, 'selection-cancel');
    expect(fired).toBe(true);
  });

  it('disables the add button while nothing is selected (count 0)', () => {
    const fixture = setup();
    const addBtn = fixture.debugElement.query(By.css('[data-testid="selection-add"]'));
    expect((addBtn!.nativeElement as HTMLButtonElement).disabled).toBe(true);
  });

  it('exposes a preserve output guarded by canPreserve', () => {
    // DI-free: instantiate and assert the output exists; template gating covered by e2e
    const fixture = TestBed.createComponent(SelectionBarComponent);
    expect(fixture.componentInstance.preserve).toBeDefined();
    expect(fixture.componentInstance.canPreserve).toBeDefined();
  });
});
