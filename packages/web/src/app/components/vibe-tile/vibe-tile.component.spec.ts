import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { VibeTileComponent } from './vibe-tile.component';
import { setInputValue } from '../../../testing/signal-input';

function setup(inputs: Partial<Record<string, unknown>> = {}) {
  // One fresh module + component per scenario: the raw input write bypasses
  // signalSetFn, so a second write never invalidates readers that already read
  // it (testing/signal-input.ts, landmine 2).
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [VibeTileComponent] });
  const fixture = TestBed.createComponent(VibeTileComponent);
  const c = fixture.componentInstance as unknown as Record<string, never>;
  setInputValue(c['label'], 'Happy');
  for (const [k, v] of Object.entries(inputs)) setInputValue(c[k], v as never);
  fixture.detectChanges();
  return { fixture, button: fixture.nativeElement.querySelector('button') as HTMLButtonElement };
}

describe('VibeTileComponent', () => {
  it('paints the gradient and white text in the color tone', () => {
    const { button } = setup({ tone: 'color', gradient: 'from-amber-400 to-orange-500' });

    expect(button.classList).toContain('bg-gradient-to-br');
    expect(button.classList).toContain('from-amber-400');
    expect(button.classList).toContain('to-orange-500');
    expect(button.classList).toContain('text-white');
  });

  it('uses the flat themed surface and never a gradient in the muted tone', () => {
    // The whole point of the muted tone: genres must not compete with vibes.
    const { button } = setup({ tone: 'muted', gradient: 'from-amber-400 to-orange-500' });

    expect(button.classList).not.toContain('bg-gradient-to-br');
    expect(button.classList).not.toContain('from-amber-400');
    expect(button.classList).toContain('bg-theme-surface-2/70');
    expect(button.classList).toContain('text-theme-secondary');
  });

  it('switches width on the wide input', () => {
    expect(setup({ wide: true }).button.classList).toContain('w-40');
    expect(setup({ wide: false }).button.classList).toContain('w-[4.75rem]');
  });

  it('emits tapped on click and blocks the click when disabled', () => {
    const { fixture, button } = setup({ tone: 'color' });
    const tapped = vi.fn();
    fixture.componentInstance.tapped.subscribe(tapped);

    button.click();
    expect(tapped).toHaveBeenCalledTimes(1);

    const off = setup({ disabled: true });
    off.button.click();
    expect(off.button.disabled).toBe(true);
  });

  it('marks the tile busy while its radio is loading', () => {
    const { fixture, button } = setup({ busy: true });

    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(fixture.nativeElement.querySelector('.animate-spin')).not.toBeNull();
  });

  it('omits the emoji span when no emoji is given', () => {
    const withEmoji = setup({ emoji: '😊' });
    expect(withEmoji.fixture.nativeElement.textContent).toContain('😊');

    const without = setup({});
    expect(without.fixture.nativeElement.querySelector('[aria-hidden="true"]')).toBeNull();
  });
});
