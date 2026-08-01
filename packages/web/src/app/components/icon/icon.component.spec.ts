import { TestBed } from '@angular/core/testing';
import { IconComponent, isFilledIcon } from './icon.component';
import { setInputValue } from '../../../testing/signal-input';

describe('isFilledIcon', () => {
  it('marks only play as filled', () => {
    expect(isFilledIcon('play')).toBe(true);
    for (const name of [
      'back',
      'download',
      'share',
      'close',
      'add',
      'delete',
      'palette',
      'headphones',
      'user',
      'sliders',
      'speaker',
      'smartphone',
      'monitor',
    ] as const) {
      expect(isFilledIcon(name)).toBe(false);
    }
  });
});

describe('IconComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [IconComponent] });
  });

  // The JIT harness can't drive the `name` input, so this renders the default
  // glyph (play) — enough to prove the component mounts a decorative svg.
  it('renders a decorative svg for its glyph', () => {
    const fixture = TestBed.createComponent(IconComponent);
    fixture.detectChanges();
    const svg = fixture.nativeElement.querySelector('svg') as SVGElement;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('fill')).toBe('currentColor'); // default = play (filled)
    expect(svg.querySelector('polygon')).not.toBeNull();
  });

  it('renders every new settings-header/device glyph without throwing', () => {
    const names = [
      'palette',
      'headphones',
      'user',
      'sliders',
      'speaker',
      'smartphone',
      'monitor',
    ] as const;
    for (const name of names) {
      const fixture = TestBed.createComponent(IconComponent);
      setInputValue(fixture.componentInstance.name, name);
      fixture.detectChanges();
      const svg = fixture.nativeElement.querySelector('svg') as SVGElement;
      expect(svg, `${name} did not render an svg`).not.toBeNull();
      expect(svg.getAttribute('fill')).toBe('none'); // none of these are filled glyphs
    }
  });
});
