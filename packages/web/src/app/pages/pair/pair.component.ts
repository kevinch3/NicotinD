import { Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { parsePairingParams, claimPairing, describeBrowser } from '../../lib/pairing';

/**
 * `/pair` — the landing page a pairing QR now points at. The QR encodes
 * `<server>/pair#t=<token>` (token in the fragment, so it never reaches
 * server or proxy logs), which means scanning it with the phone's *built-in
 * camera app* works too: the browser opens this page on the server itself,
 * the page claims the one-time token same-origin, stores the resulting
 * device-bound session, and lands signed in — no app required. The NicotinD
 * app's in-app "Scan QR" parses the same link without ever loading this page.
 */
@Component({
  selector: 'app-pair',
  imports: [RouterLink],
  templateUrl: './pair.component.html',
})
export class PairComponent implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);

  readonly state = signal<'claiming' | 'done' | 'error'>('claiming');
  readonly error = signal('');
  readonly username = signal('');

  ngOnInit(): void {
    void this.claim();
  }

  private async claim(): Promise<void> {
    // The token rides in the URL fragment; Angular's router preserves it in
    // location.hash. Query form accepted as a fallback for hand-edited links.
    const parsed =
      parsePairingParams(window.location.hash) ?? parsePairingParams(window.location.search);
    if (!parsed) {
      this.state.set('error');
      this.error.set('This pairing link is incomplete — generate a fresh QR on the server.');
      return;
    }
    try {
      // Same-origin claim: this page is served by the target server itself.
      const result = await claimPairing('', {
        token: parsed.token,
        platform: 'web',
        deviceName: describeBrowser(navigator.userAgent),
      });
      this.auth.login(result.token, result.user.username, result.user.role);
      this.username.set(result.user.username);
      this.state.set('done');
      setTimeout(() => this.router.navigateByUrl('/'), 1200);
    } catch (e) {
      this.state.set('error');
      this.error.set(e instanceof Error ? e.message : 'Pairing failed');
    }
  }
}
