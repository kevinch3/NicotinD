import { TestBed } from '@angular/core/testing';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import { BackButtonService } from './back-button.service';

describe('BackButtonService (issue #394)', () => {
  let exitApp: ReturnType<typeof vi.fn>;
  let listeners: Array<(state: { canGoBack: boolean }) => void>;
  let locationBack: ReturnType<typeof vi.fn>;
  let routerUrl: string;

  function setup(url = '/library') {
    exitApp = vi.fn();
    listeners = [];
    routerUrl = url;
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: {
        App: {
          addListener: (_: string, cb: (state: { canGoBack: boolean }) => void) =>
            listeners.push(cb),
          exitApp,
        },
      },
    };
    locationBack = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        BackButtonService,
        {
          provide: Router,
          useValue: {
            get url() {
              return routerUrl;
            },
          },
        },
        { provide: Location, useValue: { back: locationBack } },
      ],
    });
    const service = TestBed.inject(BackButtonService);
    service.initialize();
    return service;
  }

  afterEach(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
  });

  it('registers a native backButton listener on a native platform', () => {
    setup();
    expect(listeners.length).toBe(1);
  });

  it('a registered overlay handler consumes the press before any navigation', () => {
    const service = setup();
    let closed = 0;
    service.stack.push(() => {
      closed++;
      return true;
    });
    listeners[0]!({ canGoBack: true });
    expect(closed).toBe(1);
    expect(locationBack).not.toHaveBeenCalled();
    expect(exitApp).not.toHaveBeenCalled();
  });

  it('with nothing to close, Back walks router history', () => {
    setup('/library/albums/x');
    listeners[0]!({ canGoBack: true });
    expect(locationBack).toHaveBeenCalled();
    expect(exitApp).not.toHaveBeenCalled();
  });

  it('at the home route with nothing to close, Back exits the app', () => {
    setup('/');
    listeners[0]!({ canGoBack: false });
    expect(locationBack).not.toHaveBeenCalled();
    expect(exitApp).toHaveBeenCalled();
  });
});
