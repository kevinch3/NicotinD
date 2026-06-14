import { TestBed } from '@angular/core/testing';
import { IconComponent, isFilledIcon } from './icon.component';

describe('isFilledIcon', () => {
  it('marks only play as filled', () => {
    expect(isFilledIcon('play')).toBe(true);
    for (const name of ['back', 'download', 'share', 'close', 'add', 'delete'] as const) {
      expect(isFilledIcon(name)).toBe(false);
    }
  });
});

describe('IconComponent', () => {
  // The JIT harness can't drive the `name` input, so this renders the default
  // glyph (play) — enough to prove the component mounts a decorative svg.
  it('renders a decorative svg for its glyph', () => {
    TestBed.configureTestingModule({ imports: [IconComponent] });
    const fixture = TestBed.createComponent(IconComponent);
    fixture.detectChanges();
    const svg = fixture.nativeElement.querySelector('svg') as SVGElement;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('fill')).toBe('currentColor'); // default = play (filled)
    expect(svg.querySelector('polygon')).not.toBeNull();
  });
});
