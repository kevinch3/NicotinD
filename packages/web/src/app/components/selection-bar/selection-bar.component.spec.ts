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

function click(fixture: ReturnType<typeof setup>, text: string): void {
  const btn = fixture.debugElement
    .queryAll(By.css('button'))
    .find((d) => (d.nativeElement as HTMLButtonElement).textContent?.trim().startsWith(text));
  if (!btn) throw new Error(`button "${text}" not found`);
  btn.triggerEventHandler('click', null);
}

describe('SelectionBarComponent', () => {
  it('renders the action buttons and a "selected" label', () => {
    const fixture = setup();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('selected');
    expect(text).toContain('Select all');
    expect(text).toContain('Add to playlist');
    expect(text).toContain('Cancel');
  });

  it('emits add when "Add to playlist" is clicked', () => {
    const fixture = setup();
    let fired = false;
    fixture.componentInstance.add.subscribe(() => (fired = true));
    click(fixture, 'Add to playlist');
    expect(fired).toBe(true);
  });

  it('emits selectAll when "Select all" is clicked', () => {
    const fixture = setup();
    let fired = false;
    fixture.componentInstance.selectAll.subscribe(() => (fired = true));
    click(fixture, 'Select all');
    expect(fired).toBe(true);
  });

  it('emits cancel when "Cancel" is clicked', () => {
    const fixture = setup();
    let fired = false;
    fixture.componentInstance.cancel.subscribe(() => (fired = true));
    click(fixture, 'Cancel');
    expect(fired).toBe(true);
  });

  it('disables "Add to playlist" while nothing is selected (count 0)', () => {
    const fixture = setup();
    const addBtn = fixture.debugElement
      .queryAll(By.css('button'))
      .find((d) =>
        (d.nativeElement as HTMLButtonElement).textContent?.trim().startsWith('Add to playlist'),
      );
    expect((addBtn!.nativeElement as HTMLButtonElement).disabled).toBe(true);
  });
});
