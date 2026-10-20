// Admin TOTP (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits, ±1 step), the second factor of every
// Admin login (ADR v2.3 §7; adman-vps-infrastructure runbooks/application-standards.md §1). Copied,
// not shared, with the same RFC test vectors as Flexperiment and Refref. The seed is stored only
// encrypted (AES-256-GCM under ADMIN_TOTP_KEY, bound to the account id); which steps were spent is
// the database's business (fn_admin_totp_accept). No recovery codes: a lost device is
// `admin-operator totp reset` over SSH.

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Clock drift tolerated on either side of the current step. */
export const TOTP_DRIFT_STEPS = 1;
const ISSUER = 'Mikluha';
const AAD = 'mikluha.admin-totp/1';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff; bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const char of text.replace(/=+$/, '')) {
    const i = BASE32.indexOf(char);
    if (i < 0) throw new Error('TOTP_BASE32_INVALID');
    value = ((value << 5) | i) & 0xffff; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP with HMAC-SHA1 and dynamic truncation. */
export function hotp(seed: Buffer, counter: number, digits = TOTP_DIGITS): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('TOTP_COUNTER_INVALID');
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', seed).update(message).digest();
  const offset = mac[mac.length - 1]! & 15;
  const binary = ((mac[offset]! & 127) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export const totpStep = (at: Date) => Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);
export const totp = (seed: Buffer, at: Date, digits = TOTP_DIGITS) => hotp(seed, totpStep(at), digits);

/** The step a code matches within ±1 of `at`, or undefined. Same work for every candidate. */
export function matchingStep(seed: Buffer, code: unknown, at: Date): number | undefined {
  if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) return undefined;
  const now = totpStep(at);
  let found: number | undefined;
  for (let step = now - TOTP_DRIFT_STEPS; step <= now + TOTP_DRIFT_STEPS; step += 1) {
    if (timingSafeEqual(Buffer.from(hotp(seed, step)), Buffer.from(code)) && found === undefined) found = step;
  }
  return found;
}

/** A 32-byte AES key, canonical base64url, from the environment; anything else is a configuration error. */
export function parseTotpKey(value: string | undefined): Buffer {
  const key = Buffer.from(value ?? '', 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== value) throw new Error('CONFIG_INVALID: ADMIN_TOTP_KEY');
  return key;
}

export function encryptSeed(key: Buffer, adminId: string, seed: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${AAD}:${adminId}`));
  const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSeed(key: Buffer, adminId: string, encoded: string): Buffer {
  const [version, iv, tag, ciphertext, ...rest] = encoded.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext || rest.length) throw new Error('TOTP_SEED_INVALID');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(`${AAD}:${adminId}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]);
  } catch { throw new Error('TOTP_SEED_INVALID'); }
}

/** A fresh 160-bit seed, its base32 secret and the otpauth URI the QR code carries. */
export function newSeed(login: string): { seed: Buffer; secret: string; otpauthUri: string } {
  const seed = randomBytes(20);
  const secret = base32Encode(seed);
  const label = encodeURIComponent(`${ISSUER}:${login}`);
  return { seed, secret,
    otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=${ISSUER}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}` };
}
