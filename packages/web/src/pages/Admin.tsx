import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { PasswordField } from '@/components/PasswordField';

interface UserRow {
  id: string;
  username: string;
  role: string;
  status: string;
  created_at: string;
}

export function AdminPage() {
  const currentUserId = useAuthStore((s) => {
    const token = s.token;
    if (!token) return null;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.sub as string;
    } catch {
      return null;
    }
  });

  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Reset password modal
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [resetting, setResetting] = useState(false);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<UserRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  // System panel
  const [systemStatus, setSystemStatus] = useState<{ slskd: { healthy: boolean; connected: boolean }; navidrome: { healthy: boolean } } | null>(null);
  const [scanStatus, setScanStatus] = useState<{ scanning: boolean; count: number } | null>(null);
  const [restarting, setRestarting] = useState<{ slskd: boolean; navidrome: boolean }>({ slskd: false, navidrome: false });
  const [logService, setLogService] = useState<'slskd' | 'navidrome'>('slskd');
  const [logs, setLogs] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  useEffect(() => {
    loadUsers();
    loadSystemStatus();
  }, []);

  async function loadSystemStatus() {
    try {
      const [status, scan] = await Promise.all([api.getStatus(), api.getScanStatus()]);
      setSystemStatus(status);
      setScanStatus(scan);
    } catch { /* non-fatal */ }
  }

  async function handleRestart(service: 'slskd' | 'navidrome') {
    setRestarting((prev) => ({ ...prev, [service]: true }));
    try {
      await api.restartService(service);
      setTimeout(loadSystemStatus, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to restart ${service}`);
    } finally {
      setRestarting((prev) => ({ ...prev, [service]: false }));
    }
  }

  async function loadLogs(service: 'slskd' | 'navidrome') {
    setLogService(service);
    setLogsLoading(true);
    try {
      const res = await api.getServiceLogs(service);
      setLogs(res.logs);
    } catch {
      setLogs([`Failed to load ${service} logs`]);
    } finally {
      setLogsLoading(false);
    }
  }

  async function loadUsers() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getUsers();
      setUsers(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }

  async function toggleRole(user: UserRow) {
    const newRole = user.role === 'admin' ? 'user' : 'admin';
    try {
      await api.updateUserRole(user.id, newRole);
      setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, role: newRole } : u)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role');
    }
  }

  async function toggleStatus(user: UserRow) {
    const newStatus = user.status === 'active' ? 'disabled' : 'active';
    try {
      await api.updateUserStatus(user.id, newStatus);
      setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, status: newStatus } : u)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status');
    }
  }

  async function handleResetPassword() {
    if (!resetTarget || !newPassword.trim()) return;
    setResetting(true);
    try {
      await api.resetUserPassword(resetTarget.id, newPassword.trim());
      setResetTarget(null);
      setNewPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setResetting(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteUser(deleteTarget.id);
      setUsers((prev) => prev.filter((u) => u.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete user');
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-8">
        <p className="text-zinc-500">Loading users...</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-12">
      <div>
      <h1 className="text-xl font-bold text-zinc-100 mb-8">User Management</h1>

      {error && (
        <div className="mb-6 px-4 py-2.5 rounded-lg text-sm bg-red-950/50 border border-red-900/50 text-red-400">
          {error}
          <button onClick={() => setError(null)} className="ml-2 text-red-500 hover:text-red-300">
            dismiss
          </button>
        </div>
      )}

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800">
              <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                User
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Role
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Status
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-500 hidden sm:table-cell">
                Joined
              </th>
              <th className="text-right px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const isSelf = user.id === currentUserId;
              return (
                <tr key={user.id} className="border-b border-zinc-800/50 last:border-0">
                  <td className="px-4 py-3 text-zinc-200">
                    {user.username}
                    {isSelf && <span className="ml-1.5 text-xs text-zinc-500">(you)</span>}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        user.role === 'admin'
                          ? 'bg-amber-950/50 text-amber-400 border border-amber-900/50'
                          : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                      }`}
                    >
                      {user.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center gap-1.5 text-xs ${
                        user.status === 'active' ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          user.status === 'active' ? 'bg-emerald-500' : 'bg-red-500'
                        }`}
                      />
                      {user.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-500 text-xs hidden sm:table-cell">
                    {new Date(user.created_at + 'Z').toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => toggleRole(user)}
                        disabled={isSelf}
                        title={isSelf ? 'Cannot change your own role' : `Make ${user.role === 'admin' ? 'user' : 'admin'}`}
                        className="px-2 py-1 rounded text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        {user.role === 'admin' ? 'Demote' : 'Promote'}
                      </button>
                      <button
                        onClick={() => toggleStatus(user)}
                        disabled={isSelf}
                        title={isSelf ? 'Cannot disable your own account' : `${user.status === 'active' ? 'Disable' : 'Enable'} account`}
                        className="px-2 py-1 rounded text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        {user.status === 'active' ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        onClick={() => {
                          setResetTarget(user);
                          setNewPassword('');
                        }}
                        title="Reset password"
                        className="px-2 py-1 rounded text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition"
                      >
                        Reset PW
                      </button>
                      <button
                        onClick={() => setDeleteTarget(user)}
                        disabled={isSelf}
                        title={isSelf ? 'Cannot delete your own account' : 'Delete user'}
                        className="px-2 py-1 rounded text-xs text-red-400/70 hover:text-red-400 hover:bg-red-950/30 transition disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      </div>

      {/* System Panel */}
      <div>
        <h2 className="text-xl font-bold text-zinc-100 mb-8">System</h2>

        {/* Service cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
          {(['slskd', 'navidrome'] as const).map((svc) => {
            const health = systemStatus?.[svc];
            const isHealthy = health?.healthy ?? false;
            const isRestarting = restarting[svc];
            return (
              <div key={svc} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-zinc-200 capitalize">{svc}</p>
                  <span className={`inline-flex items-center gap-1.5 text-xs mt-1 ${isHealthy ? 'text-emerald-400' : 'text-red-400'}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${isHealthy ? 'bg-emerald-500' : 'bg-red-500'}`} />
                    {systemStatus ? (isHealthy ? 'Healthy' : 'Unreachable') : '—'}
                    {svc === 'slskd' && systemStatus && (
                      <span className="text-zinc-500 ml-1">
                        {(systemStatus.slskd as any).connected ? '· Connected' : '· Disconnected'}
                      </span>
                    )}
                  </span>
                </div>
                <button
                  onClick={() => handleRestart(svc)}
                  disabled={isRestarting}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition disabled:opacity-50"
                >
                  {isRestarting ? 'Restarting…' : 'Restart'}
                </button>
              </div>
            );
          })}
        </div>

        {/* Scan status */}
        {scanStatus && (
          <div className="flex items-center gap-3 mb-8 text-sm">
            <span className="text-zinc-500">Library scan:</span>
            {scanStatus.scanning ? (
              <span className="flex items-center gap-2 text-blue-400">
                <span className="inline-block w-3 h-3 border-2 border-blue-800 border-t-blue-400 rounded-full animate-spin" />
                Scanning — {scanStatus.count.toLocaleString()} songs indexed
              </span>
            ) : (
              <span className="text-zinc-400">Idle — {scanStatus.count.toLocaleString()} songs</span>
            )}
          </div>
        )}

        {/* Log viewer */}
        <div>
          <div className="flex items-center gap-3 mb-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Logs</span>
            <div className="flex gap-1">
              {(['slskd', 'navidrome'] as const).map((svc) => (
                <button
                  key={svc}
                  onClick={() => loadLogs(svc)}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition ${
                    logService === svc && logs.length > 0
                      ? 'bg-zinc-700 text-zinc-200'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {svc}
                </button>
              ))}
            </div>
            {logs.length > 0 && (
              <button
                onClick={() => loadLogs(logService)}
                className="ml-auto text-xs text-zinc-500 hover:text-zinc-300 transition"
              >
                Refresh
              </button>
            )}
          </div>
          {logsLoading && (
            <div className="flex items-center gap-2 py-4 text-xs text-zinc-500">
              <span className="inline-block w-3 h-3 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
              Loading logs…
            </div>
          )}
          {!logsLoading && logs.length > 0 && (
            <pre className="rounded-lg bg-zinc-950 border border-zinc-800 p-4 text-[11px] text-zinc-400 overflow-auto max-h-72 leading-relaxed">
              {logs.join('\n')}
            </pre>
          )}
          {!logsLoading && logs.length === 0 && (
            <p className="text-xs text-zinc-600">Select a service above to view logs.</p>
          )}
        </div>
      </div>

      {/* Reset Password Modal */}
      {resetTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setResetTarget(null)}>
          <div
            className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 w-full max-w-sm mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-zinc-200 mb-4">
              Reset password for {resetTarget.username}
            </h3>
            <PasswordField
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password"
              autoComplete="new-password"
              inputClassName="w-full px-4 py-2.5 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition text-sm"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setResetTarget(null)}
                className="px-4 py-2 rounded-lg text-sm text-zinc-400 hover:text-zinc-200 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleResetPassword}
                disabled={resetting || !newPassword.trim() || newPassword.trim().length < 4}
                className="px-4 py-2 rounded-lg bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-zinc-200 transition disabled:opacity-50"
              >
                {resetting ? 'Resetting...' : 'Reset Password'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setDeleteTarget(null)}>
          <div
            className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 w-full max-w-sm mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-zinc-200 mb-2">Delete user</h3>
            <p className="text-sm text-zinc-400 mb-4">
              Are you sure you want to delete <strong className="text-zinc-200">{deleteTarget.username}</strong>?
              This action cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-4 py-2 rounded-lg text-sm text-zinc-400 hover:text-zinc-200 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold hover:bg-red-500 transition disabled:opacity-50"
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
