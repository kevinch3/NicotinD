import { TestBed } from '@angular/core/testing';
import { NowPlayingCoverArtComponent } from './now-playing-cover-art.component';
import { PlayerService } from '../../../services/player.service';
import { AuthService } from '../../../services/auth.service';
import { setInputValue } from '../../../../testing/signal-input';

describe('NowPlayingCoverArtComponent', () => {
  const track = { id: 't1', title: 'Song', artist: 'Artist', bitRate: 320 };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        { provide: PlayerService, useValue: { currentTrack: () => track } },
        { provide: AuthService, useValue: { token: () => 'tok' } },
      ],
    });
  });

  it('renders a quality chip from bitRate', () => {
    const fixture = TestBed.createComponent(NowPlayingCoverArtComponent);
    setInputValue(fixture.componentInstance.coverMaxPx, 320);
    fixture.detectChanges();
    const chip = fixture.nativeElement.querySelector('[data-testid="now-playing-quality"]');
    expect(chip?.textContent?.trim()).toBe('320 kbps');
  });

  it('has no standalone lyrics-toggle button (superseded by the panel tabs)', () => {
    const fixture = TestBed.createComponent(NowPlayingCoverArtComponent);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[data-testid="now-playing-lyrics-toggle"]'),
    ).toBeNull();
  });

  it('publishes coverMaxPx as the --np-cover-max var, not an inline max-width', () => {
    // An inline style.max-width would beat every class — including the lg:
    // side-panel layout's fixed cap — so the mobile queue-resize shrink rides a
    // CSS var that lg:max-w-80 can override via the responsive cascade.
    const fixture = TestBed.createComponent(NowPlayingCoverArtComponent);
    setInputValue(fixture.componentInstance.coverMaxPx, 240);
    fixture.detectChanges();
    const cover: HTMLElement = fixture.nativeElement.querySelector(
      '[data-testid="now-playing-cover"]',
    );
    expect(cover.style.getPropertyValue('--np-cover-max')).toBe('240px');
    expect(cover.style.maxWidth).toBe('');
  });
});
