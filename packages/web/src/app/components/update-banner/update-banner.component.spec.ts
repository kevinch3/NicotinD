import { TestBed } from '@angular/core/testing';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { UpdateBannerComponent } from './update-banner.component';
import { UpdateService } from '../../services/update.service';
import { UPDATE_BANNER_HEIGHT_VAR } from '../../lib/player-chrome';

describe('UpdateBannerComponent', () => {
  const updateAvailable = signal(false);

  const fakeUpdate = () => ({
    updateAvailable,
    applying: signal(false),
    targetBuild: signal<string | null>(null),
    applyUpdate: vi.fn(),
  });

  function setup() {
    TestBed.configureTestingModule({
      imports: [UpdateBannerComponent],
      providers: [{ provide: UpdateService, useValue: fakeUpdate() }],
    });
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    fixture.detectChanges();
    return fixture;
  }

  const published = () => document.documentElement.style.getPropertyValue(UPDATE_BANNER_HEIGHT_VAR);

  afterEach(() => {
    updateAvailable.set(false);
    TestBed.resetTestingModule();
    document.documentElement.style.removeProperty(UPDATE_BANNER_HEIGHT_VAR);
  });

  // The toast stack clears the strip by this height; it is not bottom chrome (#1699).
  it('publishes 0px while hidden', () => {
    setup();
    expect(published()).toBe('0px');
  });

  it('publishes the strip measured height while it shows, and 0px once it hides', () => {
    TestBed.configureTestingModule({
      imports: [UpdateBannerComponent],
      providers: [{ provide: UpdateService, useValue: fakeUpdate() }],
    });
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    // jsdom lays nothing out and signal viewChild does not resolve under this
    // harness (as in player.component.spec.ts), so the strip is injected,
    // present only while the template would render it.
    const strip = document.createElement('div');
    strip.getBoundingClientRect = () => ({ height: 52.4 }) as DOMRect;
    Object.defineProperty(fixture.componentInstance, 'strip', {
      value: () => (updateAvailable() ? { nativeElement: strip } : undefined),
      configurable: true,
    });
    fixture.detectChanges();
    expect(published()).toBe('0px');

    updateAvailable.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="update-banner"]')).not.toBeNull();
    expect(published()).toBe('53px');

    updateAvailable.set(false);
    fixture.detectChanges();
    expect(published()).toBe('0px');
  });

  it('clears the variable when destroyed', () => {
    const fixture = setup();
    fixture.destroy();
    expect(published()).toBe('');
  });
});
