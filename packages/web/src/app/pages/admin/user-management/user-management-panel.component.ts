import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ROLES, type Role } from '../../../../types/core';
import { SettingsGroupComponent } from '../../../components/settings-group/settings-group.component';
import { MenuPanelComponent } from '../../../components/menu-panel/menu-panel.component';
import { PasswordFieldComponent } from '../../../components/password-field/password-field.component';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';
import { BottomChromeSafeDirective } from '../../../directives/bottom-chrome-safe.directive';
import { userActivityDetail, userActivityLabel } from '../../../lib/user-activity';
import type { Translator } from '../../../lib/relative-time';
import { AuthService } from '../../../services/auth.service';
import { ConfirmService } from '../../../services/confirm.service';
import { SystemApiService } from '../../../services/api/system-api.service';
import type { AdminUser } from '../../../services/api/api-types';
import { TranslateService } from '../../../services/translate.service';

/**
 * Admin card for user management: the users table with role/status changes,
 * password reset and deletion, plus the create-user and reset-password modals
 * (both `fixed inset-0 z-50`, so their position in the DOM is irrelevant).
 *
 * `loading` and `error` live here rather than on the page. They are written
 * exclusively by this section's actions, and gating the *whole* Admin page on
 * `GET /api/admin/users` meant a slow user query blanked system health,
 * processing and everything else behind a bare "Loading users…". Now only this
 * card waits, and its error banner appears where the failing action lives.
 */
@Component({
  selector: 'app-user-management-panel',
  standalone: true,
  host: { class: 'contents' },
  imports: [
    SettingsGroupComponent,
    FormsModule,
    TranslatePipe,
    MenuPanelComponent,
    PasswordFieldComponent,
    TvNavGroupDirective,
    TvNavItemDirective,
    BottomChromeSafeDirective,
  ],
  templateUrl: './user-management-panel.component.html',
})
export class UserManagementPanelComponent implements OnInit {
  private readonly api = inject(SystemApiService);
  private readonly auth = inject(AuthService);
  private readonly confirm = inject(ConfirmService);
  readonly i18n = inject(TranslateService);

  readonly users = signal<AdminUser[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  readonly resetTarget = signal<AdminUser | null>(null);
  readonly newPassword = signal('');
  readonly resetting = signal(false);

  readonly showCreateUser = signal(false);
  readonly newUsername = signal('');
  readonly newUserPassword = signal('');
  readonly creating = signal(false);

  readonly roles = ROLES;

  private readonly translate: Translator = (key, params) => this.i18n.t(key, params);

  ngOnInit(): void {
    void this.loadUsers();
  }

  /**
   * A `computed`, not a method: every users-table row calls it three times (the
   * "(you)" marker, the role cell, and two disabled bindings), and as a method
   * that meant base64-decoding + JSON.parsing the JWT on every one of those on
   * every change-detection pass. Still read as `currentUserId()` in the template.
   */
  readonly currentUserId = computed<string | null>(() => {
    const token = this.auth.token();
    if (!token) return null;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.sub as string;
    } catch {
      return null;
    }
  });

  async setRole(user: AdminUser, newRole: Role): Promise<void> {
    if (newRole === user.role) return;
    const prevRole = user.role;
    this.users.update((prev) => prev.map((u) => (u.id === user.id ? { ...u, role: newRole } : u)));
    try {
      await firstValueFrom(this.api.updateUserRole(user.id, newRole));
    } catch (err) {
      this.users.update((prev) =>
        prev.map((u) => (u.id === user.id ? { ...u, role: prevRole } : u)),
      );
      this.error.set(err instanceof Error ? err.message : this.i18n.t('admin.updateRoleFailed'));
    }
  }

  async toggleStatus(user: AdminUser): Promise<void> {
    const newStatus = user.status === 'active' ? 'disabled' : 'active';
    try {
      await firstValueFrom(this.api.updateUserStatus(user.id, newStatus as 'active' | 'disabled'));
      this.users.update((prev) =>
        prev.map((u) => (u.id === user.id ? { ...u, status: newStatus } : u)),
      );
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : this.i18n.t('admin.updateStatusFailed'));
    }
  }

  async handleResetPassword(): Promise<void> {
    const target = this.resetTarget();
    if (!target || !this.newPassword().trim()) return;
    this.resetting.set(true);
    try {
      await firstValueFrom(this.api.resetUserPassword(target.id, this.newPassword().trim()));
      this.resetTarget.set(null);
      this.newPassword.set('');
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : this.i18n.t('admin.resetPasswordFailed'));
    } finally {
      this.resetting.set(false);
    }
  }

  async handleCreateUser(): Promise<void> {
    const username = this.newUsername().trim();
    const password = this.newUserPassword().trim();
    if (!username || !password) return;
    this.creating.set(true);
    try {
      await firstValueFrom(this.api.createUser(username, password));
      // Reload rather than appending: the list is ordered by activity
      // server-side, and a never-connected new user does not simply belong last.
      await this.loadUsers();
      this.showCreateUser.set(false);
      this.newUsername.set('');
      this.newUserPassword.set('');
    } catch (err: any) {
      this.error.set(err.error?.error ?? err.message ?? this.i18n.t('admin.createUserFailed'));
    } finally {
      this.creating.set(false);
    }
  }

  /**
   * Deleting a user routes through the app-wide confirm host rather than a
   * modal this page hand-rolls — same shape as every other destructive action
   * (`ConfirmService`, mounted once in the layout).
   */
  async confirmDeleteUser(user: AdminUser): Promise<void> {
    const ok = await this.confirm.ask(
      this.i18n.t('admin.deleteUserConfirm', { username: user.username }),
    );
    if (!ok) return;
    try {
      await firstValueFrom(this.api.deleteUser(user.id));
      this.users.update((prev) => prev.filter((u) => u.id !== user.id));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : this.i18n.t('admin.deleteUserFailed'));
    }
  }

  private async loadUsers(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const data = await firstValueFrom(this.api.getUsers());
      this.users.set(data);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : this.i18n.t('admin.loadUsersFailed'));
    } finally {
      this.loading.set(false);
    }
  }

  formatDate(dateStr: string): string {
    return new Date(dateStr + 'Z').toLocaleDateString();
  }

  /**
   * Shared by the static self badge and the role-picker trigger, so the two
   * cannot drift — they are the same badge, one of which happens to be clickable.
   */
  roleBadgeClass(role: string): string {
    return (
      'inline-block px-2 py-0.5 rounded text-xs font-medium border border-theme ' +
      (role === 'admin' ? 'status-warn' : 'bg-theme-surface-2 text-theme-secondary')
    );
  }

  /** "Online" / "3d ago" / "Never" — see lib/user-activity.ts. */
  activityLabel(user: AdminUser): string {
    return userActivityLabel(user, this.translate);
  }

  /** "2 devices · 3 sessions" while connected, else '' (the row renders nothing). */
  activityDetail(user: AdminUser): string {
    return userActivityDetail(user, this.translate);
  }

  /** Absolute last-connection time for the Activity cell's tooltip. */
  lastSeenExact(user: AdminUser): string {
    return user.last_seen_at === null ? '' : new Date(user.last_seen_at).toLocaleString();
  }
}
