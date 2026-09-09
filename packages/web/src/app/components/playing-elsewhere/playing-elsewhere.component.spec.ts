import { TestBed } from '@angular/core/testing';
import { signal, computed } from '@angular/core';
import { PlayingElsewhereComponent } from './playing-elsewhere.component';
import { RemotePlaybackService, type RemoteDevice } from '../../services/remote-playback.service';

const MY_ID = 'me';
const tv: RemoteDevice = { id: 'tv', name: 'Living Room', type: 'web', lastSeen: 0 };

function setup(activeDeviceId: string | null, devices: RemoteDevice[] = [tv]) {
  const activeId = signal(activeDeviceId);
  const list = signal(devices);
  const setSwitcherOpen = vi.fn();
  const remote = {
    activeDeviceId: activeId,
    devices: list,
    playingElsewhere: computed(() => activeId() !== null && activeId() !== MY_ID),
    activeDevice: computed(() => list().find((d) => d.id === activeId()) ?? null),
    sessionControllable: computed(() => {
      const d = list().find((x) => x.id === activeId());
      return d !== undefined && d.available !== false;
    }),
    setSwitcherOpen,
  };
  TestBed.configureTestingModule({
    imports: [PlayingElsewhereComponent],
    providers: [{ provide: RemotePlaybackService, useValue: remote }],
  });
  const fixture = TestBed.createComponent(PlayingElsewhereComponent);
  fixture.detectChanges();
  const el: HTMLElement = fixture.nativeElement;
  return { fixture, el, remote, setSwitcherOpen };
}

describe('PlayingElsewhereComponent', () => {
  it('renders nothing while there is no session', () => {
    expect(setup(null).el.querySelector('[data-testid="playing-elsewhere"]')).toBeNull();
  });

  it('renders nothing while this device is the output', () => {
    expect(setup(MY_ID).el.querySelector('[data-testid="playing-elsewhere"]')).toBeNull();
  });

  it('names the device the session plays on', () => {
    const { el } = setup('tv');
    const strip = el.querySelector('[data-testid="playing-elsewhere"]');
    expect(strip).not.toBeNull();
    expect(strip?.getAttribute('data-controllable')).toBe('true');
    // The unit harness renders bare keys; the catalog wiring is covered by the
    // story and the e2e spec. The name reaches the pipe as its `{name}` param.
    expect(el.querySelector('[data-testid="playing-elsewhere-name"]')?.textContent).toContain(
      'remote.playingOn',
    );
    expect(el.querySelector('[data-testid="playing-elsewhere-uncontrollable"]')).toBeNull();
  });

  it('says so when the output cannot be driven from here', () => {
    const { el } = setup('tv', [{ ...tv, available: false }]);
    const strip = el.querySelector('[data-testid="playing-elsewhere"]');
    expect(strip?.getAttribute('data-controllable')).toBe('false');
    expect(el.querySelector('[data-testid="playing-elsewhere-uncontrollable"]')).not.toBeNull();
  });

  it('marks an output in its reconnect grace', () => {
    const { el } = setup('tv', [{ ...tv, pending: true }]);
    expect(el.textContent).toContain('remote.reconnecting');
  });

  it('tapping it opens the device switcher', () => {
    const { el, setSwitcherOpen } = setup('tv');
    (el.querySelector('[data-testid="playing-elsewhere"]') as HTMLButtonElement).click();
    expect(setSwitcherOpen).toHaveBeenCalledWith(true);
  });
});
