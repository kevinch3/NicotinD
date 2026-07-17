import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { PairingMintResponse, PairedDevice, RemoteAccessStatus } from './api-types';

/** Device pairing (QR link) + Tailscale-Funnel remote access. The claim
 * endpoint is intentionally NOT here — it runs pre-auth from the server-picker
 * against a not-yet-selected server (see `lib/pairing.ts` claimPairing). */
@Injectable({ providedIn: 'root' })
export class DevicesApiService {
  private http = inject(HttpClient);

  mintPairing() {
    return this.http.post<PairingMintResponse>('/api/devices/pair', {});
  }

  getDevices() {
    return this.http.get<{ devices: PairedDevice[] }>('/api/devices');
  }

  revokeDevice(id: string) {
    return this.http.delete<{ ok: boolean }>(`/api/devices/${id}`);
  }

  getRemoteAccess() {
    return this.http.get<RemoteAccessStatus>('/api/admin/remote-access');
  }

  setRemoteAccess(enabled: boolean) {
    return this.http.post<RemoteAccessStatus>('/api/admin/remote-access', { enabled });
  }
}
