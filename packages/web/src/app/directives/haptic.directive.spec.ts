import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { HapticDirective } from './haptic.directive';
import { haptic } from '../lib/haptics';

vi.mock('../lib/haptics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/haptics')>()),
  haptic: vi.fn(),
}));

@Component({
  standalone: true,
  imports: [HapticDirective],
  template: `
    <button type="button" data-testid="bare" appHaptic></button>
    <button type="button" data-testid="named" appHaptic="select"></button>
  `,
})
class HostComponent {}

describe('HapticDirective', () => {
  afterEach(() => vi.mocked(haptic).mockClear());

  function click(testId: string) {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLElement>(`[data-testid="${testId}"]`)!
      .click();
  }

  it('fires the named event on click', () => {
    click('named');
    expect(haptic).toHaveBeenCalledExactlyOnceWith('select');
  });

  it('a bare appHaptic is a tap', () => {
    click('bare');
    expect(haptic).toHaveBeenCalledExactlyOnceWith('tap');
  });

  it('fires nothing until the host is clicked', () => {
    TestBed.createComponent(HostComponent).detectChanges();
    expect(haptic).not.toHaveBeenCalled();
  });
});
