import { canApplyUpdateNow } from './update-policy';

describe('canApplyUpdateNow', () => {
  const hiddenAndIdle = { ready: true, playing: false, visible: false };

  it('applies a staged update on a hidden, idle page', () => {
    expect(canApplyUpdateNow(hiddenAndIdle)).toBe(true);
  });

  it('never applies while audio is playing', () => {
    // The reload tears down the <audio> element — and on the device that is
    // the remote output, the cast everyone else is driving.
    expect(canApplyUpdateNow({ ...hiddenAndIdle, playing: true })).toBe(false);
  });

  it('a backgrounded tab that is still the output is playing, and playing wins', () => {
    expect(canApplyUpdateNow({ ready: true, playing: true, visible: false })).toBe(false);
  });

  it('never applies under the hands of someone using the app', () => {
    expect(canApplyUpdateNow({ ...hiddenAndIdle, visible: true })).toBe(false);
  });

  it('does nothing when no version is staged', () => {
    expect(canApplyUpdateNow({ ready: false, playing: false, visible: false })).toBe(false);
  });
});
