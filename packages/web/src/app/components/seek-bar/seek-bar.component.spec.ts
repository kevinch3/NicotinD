import { ɵSIGNAL as SIGNAL } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SeekBarComponent } from './seek-bar.component';

function setup() {
  TestBed.configureTestingModule({ imports: [SeekBarComponent] });
  const fixture = TestBed.createComponent(SeekBarComponent);
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance };
}

describe('SeekBarComponent', () => {
  it('renders a native range input carrying the swipe-to-open guard attr', () => {
    const { fixture } = setup();
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.type).toBe('range');
    expect(input.getAttribute('data-seek')).not.toBeNull(); // onBarPointerDown guard
  });

  it('emits seek with the committed value on change and clears the scrub', () => {
    const { component } = setup();
    const seeks: number[] = [];
    component.seek.subscribe((v) => seeks.push(v));

    component.onInput({ target: { value: '42' } } as unknown as Event);
    // Mid-scrub the thumb follows the local value, not the (default 0) position.
    expect(component.value()).toBe(42);

    component.onChange({ target: { value: '42' } } as unknown as Event);
    expect(seeks).toEqual([42]);
    // Scrub released → value falls back to the bound position (default 0).
    expect(component.value()).toBe(0);
  });

  it('emits a live preview while scrubbing', () => {
    const { component } = setup();
    const previews: number[] = [];
    component.preview.subscribe((v) => previews.push(v));

    component.onInput({ target: { value: '10' } } as unknown as Event);
    component.onInput({ target: { value: '20' } } as unknown as Event);
    expect(previews).toEqual([10, 20]);
  });

  it('commits a seek when the input fires a native change event', () => {
    const { fixture, component } = setup();
    const seeks: number[] = [];
    component.seek.subscribe((v) => seeks.push(v));

    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    // Widen the range directly: the [max] binding is 0 (duration defaults to 0)
    // and the JIT harness can't set the duration input, so a bound value would
    // otherwise clamp to 0.
    input.max = '100';
    input.value = '7';
    input.dispatchEvent(new Event('change'));
    expect(seeks).toEqual([7]);
  });
});

// The JIT harness can't drive input() signals via bindings or setInput() —
// write straight to the node behind ɵSIGNAL instead, BEFORE the fixture's
// first detectChanges(). Pattern + full rationale documented in
// track-row.component.spec.ts.
function setInputValue<T>(inputSignal: () => T, value: T): void {
  (inputSignal as unknown as Record<typeof SIGNAL, { value: T }>)[SIGNAL].value = value;
}

describe('SeekBarComponent — buffered band', () => {
  function setupBuffered(buffered: { start: number; end: number }[]) {
    TestBed.configureTestingModule({ imports: [SeekBarComponent] });
    const fixture = TestBed.createComponent(SeekBarComponent);
    setInputValue(fixture.componentInstance.position, 10);
    setInputValue(fixture.componentInstance.duration, 100);
    setInputValue(fixture.componentInstance.buffered, buffered);
    fixture.detectChanges();
    return fixture.nativeElement.querySelector('input') as HTMLInputElement;
  }

  it('exposes the buffered segments as a gradient CSS var on the input', () => {
    const input = setupBuffered([{ start: 0, end: 50 }]);
    const bg = input.style.getPropertyValue('--seek-buffered-bg');
    expect(bg).toContain('linear-gradient(to right');
    expect(bg).toContain('var(--seek-buffered-color) 0%');
    expect(bg).toContain('var(--theme-surface-2) 50%');
  });

  it('sets no gradient var when nothing is buffered (falls back to plain track)', () => {
    const input = setupBuffered([]);
    expect(input.style.getPropertyValue('--seek-buffered-bg')).toBe('');
  });
});
