import { TestBed } from '@angular/core/testing';
import { PasswordFieldComponent } from './password-field.component';

describe('PasswordFieldComponent', () => {
  it('renders a block-level host so sibling space-y margins measure from the real input height (#832)', () => {
    TestBed.configureTestingModule({ imports: [PasswordFieldComponent] });
    const fixture = TestBed.createComponent(PasswordFieldComponent);
    fixture.detectChanges();
    // Angular's default host display is `inline`, which collapses to a line box and eats
    // the gap a `space-y-*` sibling expects to measure from the input's real height.
    expect(fixture.nativeElement.classList.contains('block')).toBe(true);
    fixture.destroy();
  });
});
