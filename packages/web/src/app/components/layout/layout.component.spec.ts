import { TestBed } from '@angular/core/testing';
import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { LayoutComponent } from './layout.component';
import { AuthService } from '../../services/auth.service';
import { PlayerService } from '../../services/player.service';

function setup() {
  const playerStub = { currentTrack: signal<{ id: string } | null>(null) };
  const authStub = { username: signal('user'), role: signal('user'), logout: () => {} };

  TestBed.configureTestingModule({
    imports: [LayoutComponent],
    providers: [
      provideRouter([]),
      { provide: PlayerService, useValue: playerStub },
      { provide: AuthService, useValue: authStub },
    ],
    schemas: [NO_ERRORS_SCHEMA],
  });

  // Override template to only what we're testing — avoids instantiating heavy child components
  TestBed.overrideComponent(LayoutComponent, {
    set: {
      template: `<main [class]="'flex-1 ' + (player.currentTrack() ? 'pb-20' : '')"></main>`,
      imports: [],
    },
  });

  const fixture = TestBed.createComponent(LayoutComponent);
  fixture.detectChanges();
  return { fixture, playerStub };
}

describe('LayoutComponent — player safe margin', () => {
  it('adds pb-20 to <main> when a track is loaded', () => {
    const { fixture, playerStub } = setup();

    playerStub.currentTrack.set({ id: '1' });
    fixture.detectChanges();

    const main: HTMLElement = fixture.nativeElement.querySelector('main');
    expect(main.classList).toContain('pb-20');
  });

  it('does not add pb-20 to <main> when no track is loaded', () => {
    const { fixture } = setup();
    // currentTrack is null by default

    const main: HTMLElement = fixture.nativeElement.querySelector('main');
    expect(main.classList).not.toContain('pb-20');
  });

  it('removes pb-20 when track is cleared after being set', () => {
    const { fixture, playerStub } = setup();

    playerStub.currentTrack.set({ id: '1' });
    fixture.detectChanges();

    playerStub.currentTrack.set(null);
    fixture.detectChanges();

    const main: HTMLElement = fixture.nativeElement.querySelector('main');
    expect(main.classList).not.toContain('pb-20');
  });
});
