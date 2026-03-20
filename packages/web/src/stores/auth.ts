import { create } from 'zustand';

interface AuthState {
  token: string | null;
  username: string | null;
  isAuthenticated: boolean;
  login: (token: string, username: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: localStorage.getItem('nicotind_token'),
  username: localStorage.getItem('nicotind_username'),
  isAuthenticated: !!localStorage.getItem('nicotind_token'),
  login: (token, username) => {
    localStorage.setItem('nicotind_token', token);
    localStorage.setItem('nicotind_username', username);
    set({ token, username, isAuthenticated: true });
  },
  logout: () => {
    localStorage.removeItem('nicotind_token');
    localStorage.removeItem('nicotind_username');
    set({ token: null, username: null, isAuthenticated: false });
  },
}));
