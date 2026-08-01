import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import type { Subscription } from 'rxjs';
import { KeyboardShortcutsService } from './keyboard-shortcuts.service';
import { PlayerService } from './player.service';

function dispatchKeydown(target: EventTarget, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    code: key === ' ' ? 'Space' : key,
    bubbles: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe('KeyboardShortcutsService', () => {
  let playerStub: {
    isPlaying: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    playPrev: ReturnType<typeof vi.fn>;
    playNext: ReturnType<typeof vi.fn>;
    toggleVocalMute: ReturnType<typeof vi.fn>;
    setNowPlayingOpen: ReturnType<typeof vi.fn>;
    currentTime: ReturnType<typeof signal<number>>;
    seek: ReturnType<typeof vi.fn>;
  };
  let sub: Subscription;

  function setup(initialIsPlaying: boolean) {
    playerStub = {
      isPlaying: vi.fn(() => initialIsPlaying),
      pause: vi.fn(),
      resume: vi.fn(),
      playPrev: vi.fn(),
      playNext: vi.fn(),
      toggleVocalMute: vi.fn(),
      setNowPlayingOpen: vi.fn(),
      currentTime: signal(0),
      seek: vi.fn(),
    };
    TestBed.configureTestingModule({
      providers: [KeyboardShortcutsService, { provide: PlayerService, useValue: playerStub }],
    });
    const service = TestBed.inject(KeyboardShortcutsService);
    sub = service.initialize();
    return service;
  }

  afterEach(() => {
    sub?.unsubscribe();
    document.body.innerHTML = '';
  });

  it('Space resumes playback when paused and nothing is focused', () => {
    setup(false);
    dispatchKeydown(window, ' ');
    expect(playerStub.resume).toHaveBeenCalled();
    expect(playerStub.pause).not.toHaveBeenCalled();
  });

  it('Space pauses playback when playing', () => {
    setup(true);
    dispatchKeydown(window, ' ');
    expect(playerStub.pause).toHaveBeenCalled();
  });

  it('K also toggles play/pause', () => {
    setup(false);
    dispatchKeydown(window, 'k');
    expect(playerStub.resume).toHaveBeenCalled();
  });

  it('Space is ignored while a text input is focused', () => {
    setup(false);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    dispatchKeydown(input, ' ');
    expect(playerStub.resume).not.toHaveBeenCalled();
  });

  it('K is ignored while a text input is focused', () => {
    setup(false);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    dispatchKeydown(input, 'k');
    expect(playerStub.resume).not.toHaveBeenCalled();
  });

  it('Space is ignored while a button is focused (lets its own activation win)', () => {
    setup(false);
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    dispatchKeydown(button, ' ');
    expect(playerStub.resume).not.toHaveBeenCalled();
  });

  it('K still toggles play/pause even when a button is focused (letters have no native button activation)', () => {
    setup(false);
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    dispatchKeydown(button, 'k');
    expect(playerStub.resume).toHaveBeenCalled();
  });

  it('Space is ignored while a select is focused (lets its own dropdown-open win)', () => {
    setup(false);
    const select = document.createElement('select');
    document.body.appendChild(select);
    select.focus();
    dispatchKeydown(select, ' ');
    expect(playerStub.resume).not.toHaveBeenCalled();
  });

  it('Space is ignored while a role="switch" element is focused', () => {
    setup(false);
    const button = document.createElement('button');
    button.setAttribute('role', 'switch');
    document.body.appendChild(button);
    button.focus();
    dispatchKeydown(button, ' ');
    expect(playerStub.resume).not.toHaveBeenCalled();
  });

  it('J calls playPrev', () => {
    setup(false);
    dispatchKeydown(window, 'j');
    expect(playerStub.playPrev).toHaveBeenCalled();
  });

  it('L calls playNext', () => {
    setup(false);
    dispatchKeydown(window, 'l');
    expect(playerStub.playNext).toHaveBeenCalled();
  });

  it('M toggles vocal mute', () => {
    setup(false);
    dispatchKeydown(window, 'm');
    expect(playerStub.toggleVocalMute).toHaveBeenCalled();
  });

  it('N opens Now Playing', () => {
    setup(false);
    dispatchKeydown(window, 'n');
    expect(playerStub.setNowPlayingOpen).toHaveBeenCalledWith(true);
  });

  it('J/L/M/N are ignored while a text input is focused', () => {
    setup(false);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    for (const key of ['j', 'l', 'm', 'n']) {
      dispatchKeydown(input, key);
    }
    expect(playerStub.playPrev).not.toHaveBeenCalled();
    expect(playerStub.playNext).not.toHaveBeenCalled();
    expect(playerStub.toggleVocalMute).not.toHaveBeenCalled();
    expect(playerStub.setNowPlayingOpen).not.toHaveBeenCalled();
  });

  it('ArrowRight seeks forward 10s from the current position', () => {
    setup(false);
    playerStub.currentTime.set(30);
    dispatchKeydown(window, 'ArrowRight');
    expect(playerStub.seek).toHaveBeenCalledWith(40);
  });

  it('ArrowLeft seeks backward 10s, clamped to 0', () => {
    setup(false);
    playerStub.currentTime.set(5);
    dispatchKeydown(window, 'ArrowLeft');
    expect(playerStub.seek).toHaveBeenCalledWith(0);
  });

  it('does not seek when the keydown event was already handled (defaultPrevented) by a D-pad nav group', () => {
    setup(false);
    playerStub.currentTime.set(30);
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault(); // simulates a TvNavGroupDirective having already moved focus
    window.dispatchEvent(event);
    expect(playerStub.seek).not.toHaveBeenCalled();
  });

  it('ArrowLeft/ArrowRight are ignored while a text input is focused', () => {
    setup(false);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    dispatchKeydown(input, 'ArrowRight');
    dispatchKeydown(input, 'ArrowLeft');
    expect(playerStub.seek).not.toHaveBeenCalled();
  });
});
