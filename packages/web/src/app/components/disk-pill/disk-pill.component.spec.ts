import { ɵSIGNAL as SIGNAL } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DiskPillComponent } from './disk-pill.component';

/**
 * The web JIT vitest harness can't drive Angular signal input()s the normal way
 * (see artist-links.component.spec.ts). We write straight to the signal node and
 * read the pure computeds directly, so there's no stale-notification concern.
 */
function setInputValue<T>(inputSignal: () => T, value: T): void {
  (inputSignal as unknown as Record<typeof SIGNAL, { value: T }>)[SIGNAL].value = value;
}

function make(): DiskPillComponent {
  TestBed.configureTestingModule({ imports: [DiskPillComponent] });
  return TestBed.createComponent(DiskPillComponent).componentInstance;
}

describe('DiskPillComponent', () => {
  it('formats a used / total label', () => {
    const c = make();
    setInputValue(c.used, 95 * 1024 ** 3);
    setInputValue(c.total, 969 * 1024 ** 3);
    expect(c.label()).toBe('95.0 GB / 969 GB');
  });

  it('computes fill percent and a green→red colour from the ratio', () => {
    const c = make();
    setInputValue(c.used, 50);
    setInputValue(c.total, 100);
    expect(c.fillPercent()).toBe(50);
    expect(c.fillColor()).toBe('hsl(70, 70%, 45%)');
  });

  it('is fully green (0%) when the disk is empty', () => {
    const c = make();
    setInputValue(c.used, 0);
    setInputValue(c.total, 100);
    expect(c.fillPercent()).toBe(0);
    expect(c.fillColor()).toBe('hsl(140, 70%, 45%)');
  });
});
