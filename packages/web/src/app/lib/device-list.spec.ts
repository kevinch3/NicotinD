import type { RemoteDevice } from '@nicotind/core';
import { otherDevicesFor } from './device-list';

function device(id: string, over: Partial<RemoteDevice> = {}): RemoteDevice {
  return { id, name: id, type: 'web', lastSeen: 0, ...over };
}

const myId = 'profile-1:tab-a';

describe('otherDevicesFor', () => {
  it('drops this device from the list', () => {
    const rows = otherDevicesFor([device(myId), device('profile-2:tab-a')], myId);

    expect(rows.map((d) => d.id)).toEqual(['profile-2:tab-a']);
  });

  it('marks a sibling tab of this browser rather than listing an anonymous twin', () => {
    const rows = otherDevicesFor([device('profile-1:tab-b'), device('profile-2:tab-a')], myId);

    expect(rows.find((d) => d.id === 'profile-1:tab-b')?.sibling).toBe(true);
    expect(rows.find((d) => d.id === 'profile-2:tab-a')?.sibling).toBe(false);
  });

  it('lists a device that opted out, but does not offer it', () => {
    const rows = otherDevicesFor([device('other', { available: false })], myId);

    expect(rows).toHaveLength(1);
    expect(rows[0].offerable).toBe(false);
  });

  it('treats an absent `available` as offerable (an older server omits it)', () => {
    const rows = otherDevicesFor([device('other')], myId);

    expect(rows[0].offerable).toBe(true);
  });
});
