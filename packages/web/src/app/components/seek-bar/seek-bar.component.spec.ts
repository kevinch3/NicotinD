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
