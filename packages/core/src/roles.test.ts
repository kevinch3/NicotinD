import { describe, expect, it } from 'bun:test';
import { asRole, canAcquire, canCurate, isAdmin, ROLES, type Role } from './roles.js';

describe('role capabilities', () => {
  const cases: Array<[Role, boolean, boolean, boolean]> = [
    // role,       canAcquire, canCurate, isAdmin
    ['listener', false, false, false],
    ['user', true, false, false],
    ['refiner', true, true, false],
    ['admin', true, true, true],
  ];

  for (const [role, acquire, curate, admin] of cases) {
    it(`${role}: acquire=${acquire} curate=${curate} admin=${admin}`, () => {
      expect(canAcquire(role)).toBe(acquire);
      expect(canCurate(role)).toBe(curate);
      expect(isAdmin(role)).toBe(admin);
    });
  }
});

describe('asRole', () => {
  it('passes through valid roles', () => {
    for (const r of ROLES) expect(asRole(r)).toBe(r);
  });

  it('defaults unknown/missing to user (never elevates)', () => {
    expect(asRole(undefined)).toBe('user');
    expect(asRole(null)).toBe('user');
    expect(asRole('')).toBe('user');
    expect(asRole('superuser')).toBe('user');
  });
});
