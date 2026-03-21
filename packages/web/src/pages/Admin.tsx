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

  useEffect(() => {
    loadUsers();
  }, []);

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
    <div className="max-w-3xl mx-auto px-6 py-8">
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
