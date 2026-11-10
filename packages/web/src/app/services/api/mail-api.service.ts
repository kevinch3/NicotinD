import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { MailAdminView, MailSettingsUpdate, MailTestResult } from './api-types';

/**
 * Admin → Email delivery (docs/email-invitations.md, increment 3). The SMTP
 * password is write-only: `get()` reports `passwordSet`, never the value.
 */
@Injectable({ providedIn: 'root' })
export class MailApiService {
  private http = inject(HttpClient);

  get() {
    return this.http.get<MailAdminView>('/api/admin/mail');
  }

  save(body: MailSettingsUpdate) {
    return this.http.put<MailAdminView>('/api/admin/mail', body);
  }

  sendTest(to: string) {
    return this.http.post<MailTestResult>('/api/admin/mail/test', { to });
  }

  /** The forgot-password switch; 409 `MAIL_NOT_CONFIGURED` while mail is off. */
  setRecovery(enabled: boolean) {
    return this.http.put<MailAdminView>('/api/admin/mail/recovery', { enabled });
  }
}
