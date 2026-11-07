import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { ImportEntryComponent } from './import-entry.component';
import { setInputValue } from '../../../testing/signal-input';

function render(dragging = false) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [ImportEntryComponent] });
  const fixture = TestBed.createComponent(ImportEntryComponent);
  setInputValue(fixture.componentInstance.dragging, dragging);
  fixture.detectChanges();
  const button = fixture.nativeElement.querySelector(
    '[data-testid="import-browse"]',
  ) as HTMLButtonElement;
  return { fixture, button };
}

// #1664: the entry used to be a bare dotted-underline text link.
describe('ImportEntryComponent', () => {
  it('is a real button with a label, a drop hint and an SVG folder glyph', () => {
    const { button } = render();
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.querySelector('[data-testid="import-browse-label"]')).not.toBeNull();
    expect(button.querySelector('[data-testid="import-browse-hint"]')).not.toBeNull();
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button.className).not.toContain('underline');
  });

  it('meets the 44px touch floor', () => {
    expect(render().button.classList).toContain('min-h-11');
  });

  it('shows a drag-over state while a folder is over the page', () => {
    const idle = render(false).button;
    expect(idle.getAttribute('data-dragging')).toBe('false');
    expect(idle.classList).not.toContain('border-theme-accent');

    const over = render(true).button;
    expect(over.getAttribute('data-dragging')).toBe('true');
    expect(over.classList).toContain('border-theme-accent');
    expect(over.classList).toContain('border-dashed');
  });

  it('asks for the folder picker when pressed', () => {
    const { fixture, button } = render();
    const pick = vi.fn();
    fixture.componentInstance.pick.subscribe(pick);
    button.click();
    expect(pick).toHaveBeenCalledTimes(1);
  });
});
