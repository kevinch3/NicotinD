import { createHash, randomBytes } from 'node:crypto';

/**
 * Generate Subsonic API auth token: md5(password + salt)
 */
export function subsonicToken(password: string, salt: string): string {
  return createHash('md5')
    .update(password + salt)
    .digest('hex');
}

export function generateSalt(length = 16): string {
  return randomBytes(length).toString('hex');
}

export function generateSecret(length = 32): string {
  return randomBytes(length).toString('hex');
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'bcrypt', cost: 10 });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}
