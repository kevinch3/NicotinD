import { Component, NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { HOME_VIEW_LOADERS, HomeComponent, homeViewOf } from './home.component';
import { UserPreferencesService } from '../../services/user-preferences.service';

@Component({ standalone: true, template: '<p data-testid="fake-mosaic">mosaic</p>' })
class FakeMosaic {}
@Component({ standalone: true, template: '<p data-testid="fake-shelves">shelves</p>' })
class FakeShelves {}

describe('homeViewOf', () => {
  it('defaults an unset preference to the mosaic', () => {
    expect(homeViewOf(null)).toBe('mosaic');
    expect(homeViewOf('shelves')).toBe('shelves');
  });
});

describe('HomeComponent', () => {
  function setup(homeView: 'mosaic' | 'shelves' | null) {
    const prefs = { homeView: signal(homeView), patch: vi.fn() };
    const loaders = {
      mosaic: vi.fn(async () => FakeMosaic),
      shelves: vi.fn(async () => FakeShelves),
    };
    TestBed.configureTestingModule({
      imports: [HomeComponent],
      providers: [
        { provide: UserPreferencesService, useValue: prefs },
        { provide: HOME_VIEW_LOADERS, useValue: loaders },
      ],
      // The JIT harness cannot bind the child's signal input (`[view]`); the
      // switch's own spec covers that surface.
      schemas: [NO_ERRORS_SCHEMA],
    });
    const fixture = TestBed.createComponent(HomeComponent);
    fixture.detectChanges();
    return { fixture, prefs, loaders, el: fixture.nativeElement as HTMLElement };
  }

  it('loads only the chosen view; the other chunk is never requested', async () => {
    const { fixture, loaders, el } = setup('shelves');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="fake-shelves"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="fake-mosaic"]')).toBeNull();
    expect(loaders.mosaic).not.toHaveBeenCalled();
  });

  it('renders the mosaic when nothing is chosen', async () => {
    const { fixture, loaders, el } = setup(null);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="fake-mosaic"]')).not.toBeNull();
    expect(loaders.shelves).not.toHaveBeenCalled();
  });

  it('a switch writes the preference through the door and swaps the view in place', async () => {
    const { fixture, prefs, loaders, el } = setup(null);
    await fixture.whenStable();
    fixture.detectChanges();

    fixture.componentInstance.select('shelves');
    expect(prefs.patch).toHaveBeenCalledWith({ homeView: 'shelves' });
    // The door is a stub here, so echo what the service would do.
    prefs.homeView.set('shelves');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="fake-shelves"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="fake-mosaic"]')).toBeNull();
    expect(loaders.shelves).toHaveBeenCalledTimes(1);
  });

  it('renders the switch for both views', async () => {
    for (const view of ['mosaic', 'shelves'] as const) {
      TestBed.resetTestingModule();
      const { fixture, el } = setup(view);
      await fixture.whenStable();
      fixture.detectChanges();
      expect(el.querySelector('[data-testid="home-view-switch"]'), view).not.toBeNull();
    }
  });

  it('ships real loaders for both views by default', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const loaders = TestBed.inject(HOME_VIEW_LOADERS);
    expect(typeof loaders.mosaic).toBe('function');
    expect(typeof loaders.shelves).toBe('function');
  });
});
