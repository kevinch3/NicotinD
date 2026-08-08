import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AgentTokensApiService } from '../../../services/api/agent-tokens-api.service';
import type {
  AgentScope,
  AgentTokenMintResponse,
  AgentTokenRow,
} from '../../../services/api/api-types';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import { SettingsGroupComponent } from '../../../components/settings-group/settings-group.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { TranslateService } from '../../../services/translate.service';

/**
 * Mint/list/revoke MCP agent tokens (issue #232) — the credential an external
 * LLM/agent presents to `/api/mcp` to curate this user's library. Server-side
 * this is `requireCurator`-gated (see routes/agent-tokens.ts); the route is
 * additionally `curatorGuard`-gated client-side to match.
 */
@Component({
  selector: 'app-agent-tokens',
  imports: [
    RouterLink,
    FormsModule,
    TvNavGroupDirective,
    TvNavItemDirective,
    SettingsGroupComponent,
    TranslatePipe,
  ],
  templateUrl: './agent-tokens.component.html',
})
export class AgentTokensComponent implements OnInit {
  private api = inject(AgentTokensApiService);
  private readonly i18n = inject(TranslateService);

  readonly tokens = signal<AgentTokenRow[]>([]);
  readonly error = signal('');
  readonly busy = signal(false);
  /** The just-minted secret — shown once, then never retrievable again. */
  readonly minted = signal<AgentTokenMintResponse | null>(null);
  readonly copied = signal(false);

  name = '';
  scope: AgentScope = 'refiner:curate';

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.api.listTokens().subscribe({
      next: (res) => this.tokens.set(res.tokens),
      error: () => this.error.set(this.i18n.t('agentTokens.errorLoad')),
    });
  }

  mint(): void {
    const name = this.name.trim();
    if (!name || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.api.mintToken(name, this.scope).subscribe({
      next: (res) => {
        this.minted.set(res);
        this.name = '';
        this.busy.set(false);
        this.load();
      },
      error: () => {
        this.busy.set(false);
        this.error.set(this.i18n.t('agentTokens.errorCreate'));
      },
    });
  }

  revoke(token: AgentTokenRow): void {
    this.api.revokeToken(token.id).subscribe({
      next: () => this.tokens.update((list) => list.filter((t) => t.id !== token.id)),
      error: () => this.error.set(this.i18n.t('agentTokens.errorRevoke')),
    });
  }

  dismissMinted(): void {
    this.minted.set(null);
  }

  copySecret(secret: string): void {
    void navigator.clipboard?.writeText(secret).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    });
  }

  formatWhen(ms: number | null): string {
    if (!ms) return '—';
    return new Date(ms).toLocaleDateString();
  }
}
