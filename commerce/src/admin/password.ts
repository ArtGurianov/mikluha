// Admin passwords: scrypt (N=16384, r=8, p=1), a 16-byte salt and a 64-byte key, both base64url.
// The same encoding the database checks (migration 0011, admin_user.password_scrypt).

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const PARAMS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

const derive = (password: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, PARAMS, (e, key) => (e ? reject(e) : resolve(key)));
});

export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) throw new Error('PASSWORD_LENGTH');
  const salt = randomBytes(16);
  return `scrypt:v1:16384:8:1:${salt.toString('base64url')}:${(await derive(password, salt)).toString('base64url')}`;
}

/** A hash no account has: verifying against it costs the same as a real one, so an unknown login
 *  answers no faster than a wrong password. */
export const UNKNOWN_ACCOUNT_HASH = `scrypt:v1:16384:8:1:${Buffer.alloc(16).toString('base64url')}:${Buffer.alloc(64).toString('base64url')}`;

export async function verifyPassword(password: unknown, encoded: string): Promise<boolean> {
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return false;
  const [algorithm, version, n, r, p, salt, key, ...rest] = encoded.split(':');
  if (rest.length || algorithm !== 'scrypt' || version !== 'v1' || n !== '16384' || r !== '8' || p !== '1' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  if (expected.length !== 64) return false;
  try {
    return timingSafeEqual(await derive(password, Buffer.from(salt, 'base64url')), expected);
  } catch { return false; }
}
