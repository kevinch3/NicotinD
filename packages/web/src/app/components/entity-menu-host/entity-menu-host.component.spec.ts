import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { EntityMenuHostComponent, OPEN_GRACE_MS } from './entity-menu-host.component';
import { EntityMenuService } from '../../services/entity-menu.service';
import { BackButtonService } from '../../services/native/back-button.service';

describe('EntityMenuHostComponent', () => {
  function setup() {
    const back = { stack: { push: vi.fn(() => vi.fn()) } };
    TestBed.configureTestingModule({
      imports: [EntityMenuHostComponent],
      providers: [{ provide: BackButtonService, useValue: back }],
    });
    const menu = TestBed.inject(EntityMenuService);
    const fixture = TestBed.createComponent(EntityMenuHostComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, menu, el, back };
  }

  const actions = () => [
    { label: 'Start radio', labelKey: 'entityMenu.startRadio', action: vi.fn() },
    { label: 'Open', labelKey: 'entityMenu.open', action: vi.fn() },
  ];

  it('renders nothing while no menu is open', () => {
    const { el } = setup();
    expect(el.querySelector('[data-testid="entity-menu"]')).toBeNull();
  });

  it('renders the actions in order at a clamped point, and running one closes the menu', () => {
    const { fixture, menu, el } = setup();
    const acts = actions();
    menu.open({ actions: acts, at: { x: -50, y: 20 } });
    fixture.detectChanges();

    const panel = el.querySelector<HTMLElement>('[data-testid="entity-menu"]')!;
    expect(panel).not.toBeNull();
    // Clamped into the viewport: never left of the margin.
    expect(parseFloat(panel.style.left)).toBeGreaterThanOrEqual(8);
    const items = Array.from(
      el.querySelectorAll<HTMLButtonElement>('[data-testid^="entity-action-"]'),
    );
    expect(items.map((b) => b.dataset['testid'])).toEqual([
      'entity-action-Start radio',
      'entity-action-Open',
    ]);

    items[0].click();
    expect(acts[0].action).toHaveBeenCalled();
    expect(menu.state()).toBeNull();
  });

  it('anchors under an element when one is given', () => {
    const { fixture, menu, el } = setup();
    const anchor = document.createElement('button');
    anchor.getBoundingClientRect = () =>
      ({ left: 300, top: 100, right: 340, bottom: 130, width: 40, height: 30 }) as DOMRect;
    menu.open({ actions: actions(), anchor });
    fixture.detectChanges();
    const panel = el.querySelector<HTMLElement>('[data-testid="entity-menu"]')!;
    expect(parseFloat(panel.style.top)).toBeGreaterThanOrEqual(130);
  });

  it('closes on Escape and on a click outside', () => {
    const { fixture, menu } = setup();
    menu.open({ actions: actions(), at: { x: 10, y: 10 } });
    fixture.detectChanges();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(menu.state()).toBeNull();

    menu.open({ actions: actions(), at: { x: 10, y: 10 } });
    fixture.detectChanges();
    menu.openedAt = performance.now() - OPEN_GRACE_MS - 1;
    document.body.click();
    expect(menu.state()).toBeNull();
  });

  // The release of the hold that opened the menu: the pointer is over the
  // panel, so the click lands on the common ancestor, outside both listeners.
  it('ignores an outside click within the grace period after opening', () => {
    const { fixture, menu } = setup();
    menu.open({ actions: actions(), at: { x: 10, y: 10 } });
    fixture.detectChanges();
    document.body.click();
    expect(menu.state()).not.toBeNull();
    menu.openedAt = performance.now() - OPEN_GRACE_MS - 1;
    document.body.click();
    expect(menu.state()).toBeNull();
  });

  it('a click inside the panel does not close it (the item handler does)', () => {
    const { fixture, menu, el } = setup();
    menu.open({ actions: actions(), at: { x: 10, y: 10 } });
    fixture.detectChanges();
    el.querySelector<HTMLElement>('[data-testid="entity-menu"]')!.click();
    expect(menu.state()).not.toBeNull();
  });

  it('registers a hardware-Back handler while open and unregisters on close', () => {
    const { fixture, menu, back } = setup();
    menu.open({ actions: actions(), at: { x: 10, y: 10 } });
    fixture.detectChanges();
    expect(back.stack.push).toHaveBeenCalledTimes(1);
    const unregister = back.stack.push.mock.results[0].value as ReturnType<typeof vi.fn>;
    menu.close();
    fixture.detectChanges();
    expect(unregister).toHaveBeenCalled();
  });

  it('a destructive action is styled as such', () => {
    const { fixture, menu, el } = setup();
    menu.open({
      actions: [{ label: 'Remove', action: vi.fn(), destructive: true }],
      at: { x: 10, y: 10 },
    });
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="entity-action-Remove"]')!.className).toContain(
      'text-red-400',
    );
  });
});
