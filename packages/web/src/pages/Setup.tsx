import { useState } from 'react';
import { api, type SetupStatus } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { PasswordField } from '@/components/PasswordField';

interface Props {
  setupStatus: SetupStatus;
}

type Step = 'admin' | 'soulseek' | 'tailscale' | 'done';

export function SetupPage({ setupStatus }: Props) {
  const login = useAuthStore((s) => s.login);

  const [step, setStep] = useState<Step>('admin');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Admin fields
  const [adminUsername, setAdminUsername] = useState('');
  const [adminPassword, setAdminPassword] = useState('');

  // Soulseek fields
  const [slskUsername, setSlskUsername] = useState('');
  const [slskPassword, setSlskPassword] = useState('');

  // Tailscale fields
  const [tsAuthKey, setTsAuthKey] = useState('');

  // Result
  const [tsHostname, setTsHostname] = useState('');
  const [tsIp, setTsIp] = useState('');

  // Collected data for final submit
  const [adminData, setAdminData] = useState<{ username: string; password: string } | null>(null);
  const [slskData, setSlskData] = useState<{ username: string; password: string } | null>(null);

  function handleAdminNext(e: React.FormEvent) {
    e.preventDefault();
    if (!adminUsername.trim() || !adminPassword.trim()) return;
    setAdminData({ username: adminUsername.trim(), password: adminPassword.trim() });
    setError('');
    setStep('soulseek');
  }

  function handleSoulseekNext() {
    if (slskUsername.trim() && slskPassword.trim()) {
      setSlskData({ username: slskUsername.trim(), password: slskPassword.trim() });
    }
    setError('');
    if (setupStatus.tailscale.available) {
      setStep('tailscale');
    } else {
      submitSetup(slskUsername.trim() && slskPassword.trim()
        ? { username: slskUsername.trim(), password: slskPassword.trim() }
        : null, null);
    }
  }

  function handleTailscaleNext() {
    const tsKey = tsAuthKey.trim() || null;
    submitSetup(slskData, tsKey ? tsKey : null);
  }

  async function submitSetup(
    soulseek: { username: string; password: string } | null,
    tailscaleKey: string | null,
  ) {
    if (!adminData) return;
    setLoading(true);
    setError('');

    try {
      const result = await api.completeSetup({
        admin: adminData,
        ...(soulseek ? { soulseek } : {}),
        ...(tailscaleKey ? { tailscale: { authKey: tailscaleKey } } : {}),
      });

      if (result.tailscale.connected && result.tailscale.hostname) {
        setTsHostname(result.tailscale.hostname);
        setTsIp(result.tailscale.ip ?? '');
      }

      // Store auth
      login(result.token, result.user.username, result.user.role);
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
    } finally {
      setLoading(false);
    }
  }

  function stepNumber() {
    if (step === 'admin') return 1;
    if (step === 'soulseek') return 2;
    if (step === 'tailscale') return 3;
    return 4;
  }

  const totalSteps = setupStatus.tailscale.available ? 3 : 2;

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-950">
      <div className="w-full max-w-md px-6">
        <h1 className="text-3xl font-bold text-center mb-2 text-zinc-100">NicotinD</h1>
        <p className="text-zinc-500 text-center text-sm mb-8">Initial Setup</p>

        {step !== 'done' && (
          <div className="flex items-center gap-2 mb-6 justify-center">
            {Array.from({ length: totalSteps }, (_, i) => (
              <div
                key={i}
                className={`h-1 rounded-full transition-all ${
                  i + 1 <= stepNumber()
                    ? 'w-8 bg-zinc-100'
                    : 'w-8 bg-zinc-800'
                }`}
              />
            ))}
          </div>
        )}

        {/* Step 1: Admin Account */}
        {step === 'admin' && (
          <form onSubmit={handleAdminNext} className="space-y-4">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-4">
                Create Admin Account
              </h2>
              <div className="space-y-3">
                <input
                  type="text"
                  placeholder="Username"
                  value={adminUsername}
                  onChange={(e) => setAdminUsername(e.target.value)}
                  required
                  autoFocus
                  className="w-full px-4 py-3 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition text-sm"
                />
                <PasswordField
                  placeholder="Password"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                  inputClassName="px-4 py-3 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition text-sm"
                />
              </div>
            </div>

            {error && <p className="text-red-400 text-sm">{error}</p>}

            <button
              type="submit"
              disabled={!adminUsername.trim() || !adminPassword.trim()}
              className="w-full py-3 rounded-lg bg-zinc-100 text-zinc-900 font-semibold hover:bg-zinc-200 transition disabled:opacity-50"
            >
              Next
            </button>
          </form>
        )}

        {/* Step 2: Soulseek */}
        {step === 'soulseek' && (
          <div className="space-y-4">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-1">
                Soulseek Network
              </h2>
              <p className="text-xs text-zinc-600 mb-4">
                Connect to Soulseek for P2P music search. You can skip this and configure it later in Settings.
              </p>
              <div className="space-y-3">
                <input
                  type="text"
                  placeholder="Soulseek username"
                  value={slskUsername}
                  onChange={(e) => setSlskUsername(e.target.value)}
                  autoFocus
                  className="w-full px-4 py-3 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition text-sm"
                />
                <PasswordField
                  placeholder="Soulseek password"
                  value={slskPassword}
                  onChange={(e) => setSlskPassword(e.target.value)}
                  autoComplete="new-password"
                  inputClassName="px-4 py-3 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition text-sm"
                />
              </div>
            </div>

            {error && <p className="text-red-400 text-sm">{error}</p>}

            <div className="flex gap-3">
              <button
                onClick={() => setStep('admin')}
                className="px-5 py-3 rounded-lg border border-zinc-800 text-zinc-400 text-sm font-medium hover:border-zinc-600 transition"
              >
                Back
              </button>
              <button
                onClick={handleSoulseekNext}
                disabled={loading}
                className="flex-1 py-3 rounded-lg bg-zinc-100 text-zinc-900 font-semibold hover:bg-zinc-200 transition disabled:opacity-50"
              >
                {slskUsername.trim() && slskPassword.trim()
                  ? setupStatus.tailscale.available ? 'Next' : 'Complete Setup'
                  : setupStatus.tailscale.available ? 'Skip' : 'Skip & Complete'}
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Tailscale */}
        {step === 'tailscale' && (
          <div className="space-y-4">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400 mb-1">
                Tailscale Remote Access
              </h2>
              <p className="text-xs text-zinc-600 mb-4">
                Connect to your Tailscale network for secure remote access from your phone.
                Get an auth key from your Tailscale admin console. You can skip this and configure it later.
              </p>
              <PasswordField
                placeholder="tskey-auth-..."
                value={tsAuthKey}
                onChange={(e) => setTsAuthKey(e.target.value)}
                autoFocus
                autoComplete="off"
                inputClassName="px-4 py-3 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-500 transition text-sm font-mono"
              />
            </div>

            {error && <p className="text-red-400 text-sm">{error}</p>}

            <div className="flex gap-3">
              <button
                onClick={() => setStep('soulseek')}
                className="px-5 py-3 rounded-lg border border-zinc-800 text-zinc-400 text-sm font-medium hover:border-zinc-600 transition"
              >
                Back
              </button>
              <button
                onClick={handleTailscaleNext}
                disabled={loading}
                className="flex-1 py-3 rounded-lg bg-zinc-100 text-zinc-900 font-semibold hover:bg-zinc-200 transition disabled:opacity-50"
              >
                {loading ? 'Setting up...' : tsAuthKey.trim() ? 'Connect & Complete' : 'Skip & Complete'}
              </button>
            </div>
          </div>
        )}

        {/* Done */}
        {step === 'done' && (
          <div className="space-y-4">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 text-center">
              <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto mb-4">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-400">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-zinc-100 mb-1">Setup Complete</h2>
              <p className="text-sm text-zinc-500">Your NicotinD instance is ready.</p>

              {tsHostname && (
                <div className="mt-4 p-3 rounded-lg bg-zinc-800/50 border border-zinc-700/50">
                  <p className="text-xs text-zinc-500 mb-1">Tailscale Address</p>
                  <p className="text-sm text-zinc-200 font-mono">{tsHostname}</p>
                  {tsIp && <p className="text-xs text-zinc-500 mt-0.5">{tsIp}</p>}
                </div>
              )}
            </div>

            <button
              onClick={() => window.location.reload()}
              className="w-full py-3 rounded-lg bg-zinc-100 text-zinc-900 font-semibold hover:bg-zinc-200 transition"
            >
              Get Started
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
