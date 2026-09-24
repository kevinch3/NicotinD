import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { EntityMenuButtonComponent } from './entity-menu-button.component';
import { EntityMenuService } from '../../services/entity-menu.service';

@Component({
  standalone: true,
  imports: [EntityMenuButtonComponent],
  template: `
    <a href="/x" data-testid="tile" (click)="clicks = clicks + 1" (pointerdown)="downs = downs + 1">
      <app-entity-menu-button [actions]="actions" />
    </a>
  `,
})
class HostComponent {
  clicks = 0;
  downs = 0;
  actions = () => [{ label: 'Play', action: () => {} }];
}

describe('EntityMenuButtonComponent', () => {
  function setup() {
    TestBed.configureTestingModule({ imports: [HostComponent] });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    const open = vi.spyOn(TestBed.inject(EntityMenuService), 'open');
    const button = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      '[data-testid="entity-menu-button"]',
    )!;
    return { fixture, host: fixture.componentInstance, button, open };
  }

  afterEach(() => document.documentElement.classList.remove('tv-build'));

  it("opens the menu anchored to itself, without following the tile's link", () => {
    const { button, host, open } = setup();
    button.click();
    expect(open).toHaveBeenCalledWith({
      actions: [expect.objectContaining({ label: 'Play' })],
      anchor: button,
    });
    expect(host.clicks).toBe(0);
  });

  it("a press on it never starts the tile's hold", () => {
    const { button, host } = setup();
    button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(host.downs).toBe(0);
  });

  it('is in the tab order and labelled, and only visible on hover or focus', () => {
    const { button } = setup();
    expect(button.getAttribute('tabindex')).not.toBe('-1');
    expect(button.getAttribute('aria-label')).toBeTruthy();
    expect(button.className).toMatch(/\bopacity-0\b/);
    expect(button.className).toMatch(/group-hover:opacity-100/);
    expect(button.className).toMatch(/focus-visible:opacity-100/);
  });

  it('renders nothing on TV (a D-pad has no hover)', () => {
    document.documentElement.classList.add('tv-build');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [HostComponent] });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="entity-menu-button"]'),
    ).toBeNull();
  });
});
