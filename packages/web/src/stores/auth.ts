import { create } from 'zustand';

interface AuthState {
  token: string | null;
  username: string | null;
  role: string | null;
  isAuthenticated: boolean;
  login: (token: string, username: string, role: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: localStorage.getItem('nicotind_token'),
  username: localStorage.getItem('nicotind_username'),
  role: localStorage.getItem('nicotind_role') ?? 'user',
  isAuthenticated: !!localStorage.getItem('nicotind_token'),
  login: (token, username, role) => {
    localStorage.setItem('nicotind_token', token);
    localStorage.setItem('nicotind_username', username);
    localStorage.setItem('nicotind_role', role);
    set({ token, username, role, isAuthenticated: true });
  },
  logout: () => {
    localStorage.removeItem('nicotind_token');
    localStorage.removeItem('nicotind_username');
    localStorage.removeItem('nicotind_role');
    set({ token: null, username: null, role: null, isAuthenticated: false });
  },
}));
