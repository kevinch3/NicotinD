import type { RemoteDevice } from '@nicotind/core';
import { profileIdOf } from './device-id';

/** A connected device as a picker renders it. */
export interface PickableDevice extends RemoteDevice {
  /** Another tab of *this* browser — same profile half of the id (issue #882). */
  sibling: boolean;
  /** Picking it can actually move the audio there. */
  offerable: boolean;
}

/**
 * Every device except this one, annotated for a picker.
 *
 * A second tab of this browser is a real, separately castable output, but it
 * renders with the same UA-derived name — so the row is marked rather than left
 * an anonymous twin (issue #882). A device that opted out (or has had no
 * gesture yet) is **listed but not offered**: it can still become the output by
 * playing on its own, so the list must be able to name it.
 *
 * Shared because the phone popover and the TV's full-screen chooser must answer
 * "can I send audio there?" identically — two pickers disagreeing about which
 * devices are offerable is a bug nobody would see until they were holding both
 * devices (#1128).
 */
export function otherDevicesFor(devices: readonly RemoteDevice[], myId: string): PickableDevice[] {
  return devices
    .filter((d) => d.id !== myId)
    .map((d) => ({
      ...d,
      sibling: profileIdOf(d.id) === profileIdOf(myId),
      offerable: d.available !== false,
    }));
}
