import { TestBed } from '@angular/core/testing';
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
  };
  let sub: Subscription;

  function setup(initialIsPlaying: boolean) {
    playerStub = {
      isPlaying: vi.fn(() => initialIsPlaying),
      pause: vi.fn(),
      resume: vi.fn(),
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
});
