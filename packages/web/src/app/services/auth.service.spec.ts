import { AuthService } from './auth.service';

describe('AuthService', () => {
  beforeEach(() => localStorage.clear());

  describe('setToken (sliding-session renewal)', () => {
    it('updates the token signal and localStorage', () => {
      const auth = new AuthService();
      auth.setToken('fresh-token');

      expect(auth.token()).toBe('fresh-token');
      expect(localStorage.getItem('nicotind_token')).toBe('fresh-token');
    });

    it('leaves the cached username and role untouched', () => {
      localStorage.setItem('nicotind_token', 'old-token');
      localStorage.setItem('nicotind_username', 'alice');
      localStorage.setItem('nicotind_role', 'admin');
      const auth = new AuthService();

      auth.setToken('renewed-token');

      expect(auth.username()).toBe('alice');
      expect(auth.role()).toBe('admin');
      expect(localStorage.getItem('nicotind_username')).toBe('alice');
      expect(localStorage.getItem('nicotind_role')).toBe('admin');
      expect(auth.isAuthenticated()).toBe(true);
    });
  });

  it('login then setToken keeps identity but swaps the token', () => {
    const auth = new AuthService();
    auth.login('t1', 'bob', 'user');
    auth.setToken('t2');

    expect(auth.token()).toBe('t2');
    expect(auth.username()).toBe('bob');
    expect(auth.role()).toBe('user');
  });
});
