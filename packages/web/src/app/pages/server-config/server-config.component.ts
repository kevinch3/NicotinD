import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ServerConfigService } from '../../services/server-config.service';
import {
  DEFAULT_SERVER_URL,
  normalizeServerUrl,
  buildApiUrl,
  isHealthyResponse,
} from '../../lib/server-url';

/**
 * Server-picker screen (native shell). Lets the user point the app at any
 * self-hosted NicotinD server, defaulting to the canonical instance. Validates
 * the entry against `GET /api/health` before persisting and routing to login.
 * Never shown on web (guarded by serverGuard → needsConfiguration() is false).
 */
@Component({
  selector: 'app-server-config',
  imports: [FormsModule],
  templateUrl: './server-config.component.html',
})
export class ServerConfigComponent {
  private server = inject(ServerConfigService);
  private router = inject(Router);

  url = this.server.baseUrl() || DEFAULT_SERVER_URL;
  readonly error = signal('');
  readonly checking = signal(false);

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
      this.server.setBaseUrl(normalized);
      this.router.navigateByUrl('/login');
    } catch {
      this.error.set("Couldn't reach a NicotinD server at that address");
    } finally {
      this.checking.set(false);
    }
  }
}
