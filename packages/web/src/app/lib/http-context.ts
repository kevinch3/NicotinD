import { HttpContextToken } from '@angular/common/http';

/**
 * A request whose 401 (or ACCOUNT_DISABLED 403) is the CALLER's to handle, not
 * a reason for the interceptor to log out whoever is signed in now (#1410).
 *
 * A TV profile switch checks a stored person's token with the sliding refresh.
 * If that switch has already been overtaken by a newer one, or the token is
 * simply dead, the interceptor's blanket logout used to sign out the person
 * now on screen and race the switch's own navigation. The switch reads the
 * refusal itself (`refreshSession` → 'refused'); nothing else should.
 */
export const KEEP_SESSION_ON_401 = new HttpContextToken<boolean>(() => false);
