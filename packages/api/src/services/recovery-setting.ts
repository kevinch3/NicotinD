/**
 * Self-service password recovery switch (docs/email-invitations.md, increment 5).
 *
 * **Default off.** "Forgot password?" is an anonymous endpoint that sends mail,
 * so an admin opts in, and only while mail is actually on: `effective()` is the
 * stored choice AND a transport that is not `off`, read per request, so turning
 * mail off closes recovery on the next request without a second switch to forget.
 *
 * Its own `app_settings` row (`recovery`), separate from the mail block, so the
 * switch stays usable when `NICOTIND_MAIL_TRANSPORT` pins the mail settings
 * read-only — recovery is a policy, not transport config.
 *
 * ## Why it stores a link base
 *
 * A forgot-password request is anonymous, so its `Host` header is the caller's
 * to choose. Building the emailed link from it would let anyone have a victim's
 * reset token mailed to them pointing at a host they own (password-reset
 * poisoning). So the anonymous flow never uses the request origin: links point
 * at the operator's public URL, then the Funnel URL, then the origin the admin
 * was using when they turned recovery on — recorded here from that
 * authenticated request.
 */
import type { Database } from 'bun:sqlite';

export const RECOVERY_SETTING_KEY = 'recovery';

export interface StoredRecovery {
  enabled: boolean;
  /** The admin's origin when recovery was last turned on; '' before that. */
  linkBase: string;
}

const DEFAULT: StoredRecovery = { enabled: false, linkBase: '' };

export class RecoverySetting {
  constructor(
    private readonly db: Database,
    /** Whether mail can be sent right now (`MailService.status().enabled`). */
    private readonly mailEnabled: () => boolean,
  ) {}

  stored(): StoredRecovery {
    try {
      const row = this.db
        .query<{ value: string }, [string]>('SELECT value FROM app_settings WHERE key = ?')
        .get(RECOVERY_SETTING_KEY);
      if (!row) return { ...DEFAULT };
      const parsed = JSON.parse(row.value) as Partial<StoredRecovery>;
      return {
        enabled: parsed.enabled === true,
        linkBase: typeof parsed.linkBase === 'string' ? parsed.linkBase : '',
      };
    } catch {
      return { ...DEFAULT };
    }
  }

  /** On only while the admin chose it AND mail is on. */
  effective(): boolean {
    return this.stored().enabled && this.mailEnabled();
  }

  /** Turning on records `linkBase`; turning off keeps the last one. */
  set(enabled: boolean, linkBase?: string): StoredRecovery {
    const next: StoredRecovery = {
      enabled,
      linkBase: enabled && linkBase ? linkBase : this.stored().linkBase,
    };
    this.db.run(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [RECOVERY_SETTING_KEY, JSON.stringify(next)],
    );
    return next;
  }
}
