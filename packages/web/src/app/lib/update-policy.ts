/**
 * When a staged app update may apply itself.
 *
 * The update is applied **in the background, without asking** (#1126): a banner
 * you can ignore forever is how a fleet of installed PWAs ends up months
 * behind. "Without asking" still has two hard constraints:
 *
 * 1. **Never while audio is playing.** `activateUpdate()` + reload tears down
 *    the `<audio>` element, and on the device that is currently the remote
 *    output it also drops the cast for everyone driving it.
 * 2. **Never under the hands of someone using the app.** A reload that fires
 *    mid-sentence loses a half-typed search, a settings field, a running
 *    import. Waiting for the page to be hidden costs nothing: the app is
 *    backgrounded many times a day, and the reload is then invisible — the
 *    next look at the app is already the new version.
 *
 * Constraint 2 is not a loophole for constraint 1: a backgrounded tab that is
 * still the audio output is playing, and playing wins.
 *
 * There is no third constraint for "the user has not noticed yet". A staged
 * version that never applies is the bug, so every trigger — the VERSION_READY
 * itself, the page going hidden, playback stopping — re-asks this one question.
 */
export interface UpdateApplyState {
  /** A newer version is downloaded and waiting to be activated. */
  ready: boolean;
  /** This device is producing audio right now. */
  playing: boolean;
  /** The document is on screen. */
  visible: boolean;
}

export function canApplyUpdateNow({ ready, playing, visible }: UpdateApplyState): boolean {
  return ready && !playing && !visible;
}
