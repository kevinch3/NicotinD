import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ServerConfigService } from '../../services/server-config.service';
import { AuthService } from '../../services/auth.service';
import {
  DEFAULT_SERVER_URL,
  normalizeServerUrl,
  buildApiUrl,
  isHealthyResponse,
} from '../../lib/server-url';
import { parsePairingPayload, probeCandidates, claimPairing } from '../../lib/pairing';
import { canScanBarcode, scanBarcode, platformId } from '../../services/native/native-capabilities';

/**
 * Server-picker screen (native shell). Lets the user point the app at any
 * self-hosted NicotinD server, defaulting to the canonical instance. Validates
 * the entry against `GET /api/health` before persisting and routing to login.
 * Never shown on web (guarded by serverGuard → needsConfiguration() is false).
 *
 * Pairing: "Scan QR" reads the desktop's Link-a-device QR (candidate URLs +
 * one-time token), probes the URLs, claims the token, and lands signed in —
 * one scan replaces typing a URL and a password. The optional pairing-code
 * field is the manual fallback for the same flow (URL + code off the desktop
 * screen).
 */
@Component({
  selector: 'app-server-config',
  imports: [FormsModule],
  templateUrl: './server-config.component.html',
})
export class ServerConfigComponent {
  private server = inject(ServerConfigService);
  private auth = inject(AuthService);
  private router = inject(Router);

  url = this.server.baseUrl() || DEFAULT_SERVER_URL;
  pairingCode = '';
  readonly error = signal('');
  readonly checking = signal(false);
  readonly canScan = canScanBarcode();

  async connect(): Promise<void> {
    this.error.set('');
    const normalized = normalizeServerUrl(this.url);
    if (!normalized) {
      this.error.set('Enter a valid server URL');
      return;
    }
    this.checking.set(true);
    try {
      const res = await fetch(buildApiUrl(normalized, '/api/health'), {
        headers: { Accept: 'application/json' },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !isHealthyResponse(body)) {
        throw new Error('unhealthy');
      }
      const code = this.pairingCode.trim();
      if (code) {
        await this.claimAndEnter(normalized, { code });
        return;
      }
      this.server.setBaseUrl(normalized);
      this.router.navigateByUrl('/login');
    } catch (e) {
      this.error.set(
        e instanceof PairingError ? e.message : "Couldn't reach a NicotinD server at that address",
      );
    } finally {
      this.checking.set(false);
    }
  }

  async scan(): Promise<void> {
    this.error.set('');
    const raw = await scanBarcode();
    if (raw === null) return; // cancelled / unavailable — not an error
    const payload = parsePairingPayload(raw);
    if (!payload) {
      this.error.set("That QR code isn't a NicotinD pairing code");
      return;
    }
    this.checking.set(true);
    try {
      const reachable = await probeCandidates(payload.urls);
      if (!reachable) {
        throw new PairingError("Couldn't reach the server from this phone");
      }
      await this.claimAndEnter(reachable, { token: payload.token });
    } catch (e) {
      this.error.set(e instanceof PairingError ? e.message : 'Pairing failed — try a fresh code');
    } finally {
      this.checking.set(false);
    }
  }

  /** Claim a pairing token/code against `serverUrl`, then persist + sign in. */
  private async claimAndEnter(
    serverUrl: string,
    credential: { token?: string; code?: string },
  ): Promise<void> {
    let result;
    try {
      result = await claimPairing(serverUrl, { ...credential, platform: platformId() });
    } catch (e) {
      throw new PairingError(e instanceof Error ? e.message : 'Pairing failed');
    }
    this.server.setBaseUrl(serverUrl);
    this.auth.login(result.token, result.user.username, result.user.role);
    this.router.navigateByUrl('/');
  }
}

/** Marks errors whose message is already user-presentable. */
class PairingError extends Error {}
