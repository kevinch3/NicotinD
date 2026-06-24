import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { LayoutComponent } from './layout.component';
import { AuthService } from '../../services/auth.service';
import { PlayerService } from '../../services/player.service';
import { TransferService } from '../../services/transfer.service';
import { AcquireService } from '../../services/acquire.service';
import { APP_VERSION } from '../../app.config';

function setup() {
  const playerStub = {
    currentTrack: signal<{ id: string } | null>(null),
    setRadioProvider: () => {},
  };
  const authStub = { username: signal('user'), role: signal('user'), logout: () => {} };

  TestBed.configureTestingModule({
    imports: [LayoutComponent],
    providers: [
      provideRouter([]),
      { provide: PlayerService, useValue: playerStub },
      { provide: AuthService, useValue: authStub },
      { provide: APP_VERSION, useValue: '0.0.0-test' },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  // Override template to only what we're testing — avoids instantiating heavy child components
  TestBed.overrideComponent(LayoutComponent, {
    set: {
      template: `<main [class]="'flex-1 ' + mainPadClass()"></main>`,
      imports: [],
    },
  });

  const fixture = TestBed.createComponent(LayoutComponent);
  fixture.detectChanges();
  return { fixture, playerStub };
}

describe('LayoutComponent — player + tab-bar safe margin', () => {
  it('stacks tab-bar + player padding when a track is loaded', () => {
    const { fixture, playerStub } = setup();

    playerStub.currentTrack.set({ id: '1' });
    fixture.detectChanges();

    const main: HTMLElement = fixture.nativeElement.querySelector('main');
    // mobile: tab bar + player (+ safe-area inset); desktop: just the player
    expect(main.classList).toContain('pb-[calc(8rem+env(safe-area-inset-bottom))]');
    expect(main.classList).toContain('md:pb-20');
  });

  it('reserves only the tab-bar height on mobile when no track is loaded', () => {
    const { fixture } = setup();
    // currentTrack is null by default

    const main: HTMLElement = fixture.nativeElement.querySelector('main');
    expect(main.classList).toContain('pb-[calc(3.5rem+env(safe-area-inset-bottom))]');
    expect(main.classList).toContain('md:pb-0');
    expect(main.classList).not.toContain('pb-[calc(8rem+env(safe-area-inset-bottom))]');
  });

  it('drops the player padding when a track is cleared after being set', () => {
    const { fixture, playerStub } = setup();

    playerStub.currentTrack.set({ id: '1' });
    fixture.detectChanges();

    playerStub.currentTrack.set(null);
    fixture.detectChanges();

    const main: HTMLElement = fixture.nativeElement.querySelector('main');
    expect(main.classList).not.toContain('pb-[calc(8rem+env(safe-area-inset-bottom))]');
    expect(main.classList).toContain('pb-[calc(3.5rem+env(safe-area-inset-bottom))]');
  });
});

describe('LayoutComponent — desktop downloads badge', () => {
  it('sums active transfers and in-flight acquire jobs into downloadCount', () => {
    const playerStub = {
      currentTrack: signal<{ id: string } | null>(null),
      setRadioProvider: () => {},
    };
    const transfersStub = {
      activeDownloadCount: signal(2),
      startPolling: () => {},
      stopPolling: () => {},
    };
    const acquireStub = {
      activeJobs: signal<unknown[]>([{}, {}, {}]),
      refresh: async () => {},
    };

    TestBed.configureTestingModule({
      imports: [LayoutComponent],
      providers: [
        provideRouter([]),
        { provide: PlayerService, useValue: playerStub },
        { provide: AuthService, useValue: { username: signal('u'), role: signal('user'), logout: () => {} } },
        { provide: TransferService, useValue: transfersStub },
        { provide: AcquireService, useValue: acquireStub },
        { provide: APP_VERSION, useValue: '0.0.0-test' },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    });
    TestBed.overrideComponent(LayoutComponent, {
      set: { template: `<span>{{ downloadCount() }}</span>`, imports: [] },
    });

    const fixture = TestBed.createComponent(LayoutComponent);
    fixture.detectChanges();

    expect(fixture.componentInstance.downloadCount()).toBe(5);

    transfersStub.activeDownloadCount.set(0);
    acquireStub.activeJobs.set([]);
    expect(fixture.componentInstance.downloadCount()).toBe(0);
  });
});
