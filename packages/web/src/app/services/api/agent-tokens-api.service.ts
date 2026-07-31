import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { AgentScope, AgentTokenMintResponse, AgentTokenRow } from './api-types';

/** MCP agent tokens (issue #232) — mint/list/revoke the scoped, revocable
 *  bearer credentials an external LLM/agent uses to curate this user's
 *  library through `/api/mcp`. Mirrors DevicesApiService's shape. */
@Injectable({ providedIn: 'root' })
export class AgentTokensApiService {
  private http = inject(HttpClient);

  listTokens() {
    return this.http.get<{ tokens: AgentTokenRow[] }>('/api/agent-tokens');
  }

  /** The returned `token` is the raw secret — shown exactly once. */
  mintToken(name: string, scope: AgentScope, expiresInDays?: number) {
    return this.http.post<AgentTokenMintResponse>('/api/agent-tokens', {
      name,
      scope,
      expiresInDays,
    });
  }

  revokeToken(id: string) {
    return this.http.delete<{ ok: boolean }>(`/api/agent-tokens/${encodeURIComponent(id)}`);
  }
}
