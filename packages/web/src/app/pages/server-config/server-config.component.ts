import { Component, computed, inject, signal } from '@angular/core';
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
import type { SavedServer } from '../../lib/server-registry';

/**
 * Server-picker screen (native shell). Lets the user point the app at any
 * self-hosted NicotinD server, defaulting to the canonical instance. Validates
 * the entry against `GET /api/health` before persisting and routing to login.
 * Never shown on web (guarded by serverGuard → needsConfiguration() is false).
 *
 * Servers are remembered (most recent first) with a per-server stashed session:
 * switching servers keeps each server's signed-in session, so hopping between
 * a home server and a friend's needs no retyping. Reached any time via
 * Settings → "Switch server" or the login page's "Use a different server".
 *
 * Pairing: "Scan QR" reads the desktop's Link-a-device QR (a `/pair` link
 * carrying candidate URLs + one-time token), probes the URLs, claims the
 * token, and lands signed in — one scan replaces typing a URL and a password.
 * The optional pairing-code field is the manual fallback for the same flow
 * (URL + code off the desktop screen).
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

  url = '';
  pairingCode = '';
  readonly error = signal('');
  readonly checking = signal(false);
  readonly canScan = canScanBarcode();
  /** Saved servers other than the active one (the active one shows pinned). */
  readonly servers = this.server.servers;
  readonly currentUrl = this.server.baseUrl;
  /** True when the picker was opened from a configured app (shows Back). */
  readonly canGoBack = computed(() => !this.server.needsConfiguration() && this.auth.isAuthenticated());
  readonly showAddForm = signal(false);

  /** The add-server form is shown directly when there's nothing saved yet. */
  readonly formVisible = computed(() => this.showAddForm() || this.servers().length === 0);

  constructor() {
    // Pre-fill the form with the canonical default only on a fresh install —
    // an added server should start from a blank field.
    if (this.servers().length === 0) this.url = this.server.baseUrl() || DEFAULT_SERVER_URL;
  }

  back(): void {
    this.router.navigateByUrl('/settings');
  }

  /** Tap a saved server: restore its stashed session, else go to its login. */
  async select(saved: SavedServer): Promise<void> {
    this.error.set('');
    // Re-selecting the active, signed-in server is a no-op navigation.
    if (saved.url === this.server.baseUrl() && this.auth.isAuthenticated()) {
      this.router.navigateByUrl('/');
      return;
    }
    this.switchTo(saved.url, saved.name);
    const stashed = this.server.stashedSessionFor(saved.url);
    if (stashed) {
      this.auth.login(stashed.token, stashed.username, stashed.role);
      this.router.navigateByUrl('/');
    } else {
      this.router.navigateByUrl('/login');
    }
  }

  remove(saved: SavedServer, event: Event): void {
    event.stopPropagation();
    this.server.forget(saved.url);
  }

  sessionHint(saved: SavedServer): string | null {
    return this.server.stashedSessionFor(saved.url)?.username ?? null;
  }

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
      this.switchTo(normalized);
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
    const outcome = await scanBarcode();
    if (outcome.status === 'cancelled' || outcome.status === 'unavailable') return;
    if (outcome.status === 'denied') {
      this.error.set('Camera access is denied — allow it in your phone settings, or type the URL and code instead');
      return;
    }
    if (outcome.status === 'error') {
      this.error.set('The scanner could not start — type the URL and code instead');
      return;
    }
    const payload = parsePairingPayload(outcome.value);
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
      await this.claimAndEnter(reachable, { token: payload.token }, payload.name);
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
    serverName?: string,
  ): Promise<void> {
    let result;
    try {
      result = await claimPairing(serverUrl, { ...credential, platform: platformId() });
    } catch (e) {
      throw new PairingError(e instanceof Error ? e.message : 'Pairing failed');
    }
    this.switchTo(serverUrl, serverName);
    this.auth.login(result.token, result.user.username, result.user.role);
    this.router.navigateByUrl('/');
  }

  /**
   * Common switch mechanics: stash the current server's session (so switching
   * back restores it), reset all per-server client state (player queue, caches
   * — resetSession keeps stashes, unlike logout), then point at the new server
   * and remember it in the saved list.
   */
  private switchTo(url: string, name?: string): void {
    const prevUrl = this.server.baseUrl();
    const token = this.auth.token();
    const username = this.auth.username();
    if (prevUrl && prevUrl !== url && token && username) {
      this.server.stashSessionFor(prevUrl, { token, username, role: this.auth.role() ?? 'user' });
    }
    this.auth.resetSession();
    this.server.setBaseUrl(url);
    this.server.remember(url, name);
  }
}

/** Marks errors whose message is already user-presentable. */
class PairingError extends Error {}
