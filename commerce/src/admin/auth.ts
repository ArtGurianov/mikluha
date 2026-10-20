// Admin accounts, the login throttle, sessions and audit (migration 0011). Every write here runs as
// the Admin API's own login (admin_app); the database refuses what this module should never do.

import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';

import type pg from 'pg';

export type Role = 'OWNER' | 'EDITOR';

/** Who may do what. Publishing anything public or legal is the OWNER's alone (ADR v2.3 §6–§7). */
export const PERMISSIONS = {
  'editorial.read': ['OWNER', 'EDITOR'],
  'editorial.draft': ['OWNER', 'EDITOR'],
  'editorial.publish': ['OWNER'],
  // Offer terms, privacy, refund/payment policy and PD consent releases (ART-358 adds their rows).
  'legal.publish': ['OWNER'],
  'audit.read': ['OWNER'],
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;
export const allowed = (role: Role, permission: Permission) => (PERMISSIONS[permission] as readonly Role[]).includes(role);

export const SESSION_IDLE_MS = 30 * 60_000;
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60_000;

/** One limit for password and code attempts together, per trusted client source and per account. */
export const THROTTLE_WINDOW_MS = 15 * 60_000;
export const THROTTLE_SOURCE_LIMIT = 10;
export const THROTTLE_ACCOUNT_LIMIT = 20;

export const tokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/** Throttle buckets are keyed hashes: the table never holds an address or a login. */
export function throttleKey(totpKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', totpKey, Buffer.alloc(0), 'mikluha.admin-throttle/1', 32));
}

export class RateLimited extends Error {
  constructor(readonly retryAfterSeconds: number) { super('RATE_LIMITED'); }
}

/** Counts one attempt in every bucket before anything is verified; refuses once any is over. */
export async function consumeLoginAttempt(pool: pg.Pool, key: Buffer, input: { source: string | null; login: string }, now: Date): Promise<void> {
  const window = new Date(Math.floor(now.getTime() / THROTTLE_WINDOW_MS) * THROTTLE_WINDOW_MS);
  const keyed = (kind: string, value: string) => `${kind}:${createHmac('sha256', key).update(`${kind}\0${value}`).digest('hex')}`;
  // An untrusted or missing source shares one bucket: it can never be split into fresh ones.
  const buckets: [string, number][] = [
    [keyed('source', input.source ?? 'untrusted'), THROTTLE_SOURCE_LIMIT],
    [keyed('account', input.login.trim().toLowerCase()), THROTTLE_ACCOUNT_LIMIT],
  ];
  let over = false;
  for (const [bucket, limit] of buckets) {
    const { rows } = await pool.query<{ attempts: number }>(`INSERT INTO admin_login_throttle (bucket, window_start, attempts)
      VALUES ($1, $2, 1) ON CONFLICT (bucket, window_start) DO UPDATE SET attempts = admin_login_throttle.attempts + 1
      RETURNING attempts`, [bucket, window]);
    if (rows[0]!.attempts > limit) over = true;
  }
  await pool.query('DELETE FROM admin_login_throttle WHERE window_start < $1', [new Date(window.getTime() - 24 * 60 * 60_000)]);
  if (over) throw new RateLimited(Math.max(1, Math.ceil((window.getTime() + THROTTLE_WINDOW_MS - now.getTime()) / 1000)));
}

export interface AuditEntry {
  readonly adminId?: string | null;
  readonly actor: string;
  readonly action: string;
  readonly outcome: 'OK' | 'REFUSED';
  readonly entityType?: string;
  readonly entityId?: string;
  readonly details?: Record<string, string | number | boolean | null>;
}

/** Never a password, code, seed, token or cookie: the keys say so, and the values are closed types. */
const SECRET_KEY = /password|code|seed|secret|token|cookie|authorization/i;

export async function audit(db: pg.Pool | pg.PoolClient, e: AuditEntry): Promise<void> {
  const details = Object.fromEntries(Object.entries(e.details ?? {}).map(([k, v]) => [k, SECRET_KEY.test(k) ? '[REDACTED]' : v]));
  await db.query(`INSERT INTO admin_audit (admin_id, actor, action, outcome, entity_type, entity_id, details)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`,
  [e.adminId ?? null, e.actor, e.action, e.outcome, e.entityType ?? null, e.entityId ?? null, details]);
}

export interface Account {
  readonly id: string;
  readonly login: string;
  readonly role: Role;
  readonly passwordScrypt: string;
  readonly disabled: boolean;
}

export async function findAccount(pool: pg.Pool, login: string): Promise<Account | undefined> {
  const { rows } = await pool.query<{ id: string; login: string; role: Role; password_scrypt: string; disabled_at: Date | null }>(
    'SELECT id, login, role, password_scrypt, disabled_at FROM admin_user WHERE login = $1', [login.trim().toLowerCase()]);
  const r = rows[0];
  return r && { id: r.id, login: r.login, role: r.role, passwordScrypt: r.password_scrypt, disabled: r.disabled_at !== null };
}

export interface Session {
  readonly id: string;
  readonly adminId: string;
  readonly login: string;
  readonly role: Role;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  /** The AUTH.LOGIN audit row of the password + TOTP login that admitted this session. */
  readonly authAuditId: number;
}

export interface IssuedSession { readonly token: string; readonly session: Session }

type SessionRow = { out_session_id: string; out_auth_audit_id: string; out_idle_expires_at: Date; out_absolute_expires_at: Date };
const issued = (account: Pick<Account, 'id' | 'login' | 'role'>, token: string, r: SessionRow): IssuedSession => ({ token,
  session: { id: r.out_session_id, adminId: account.id, login: account.login, role: account.role, authAuditId: Number(r.out_auth_audit_id),
    idleExpiresAt: r.out_idle_expires_at, absoluteExpiresAt: r.out_absolute_expires_at } });

/**
 * Spends the matched TOTP step, writes AUTH.LOGIN and opens the session, in one database call
 * (fn_admin_login). Undefined when the step was already spent. A random 256-bit token; the database
 * keeps only its SHA-256.
 */
export async function login(pool: pg.Pool, account: Pick<Account, 'id' | 'login' | 'role'>, step: number, confirming: boolean,
  now: Date): Promise<IssuedSession | undefined> {
  const token = randomBytes(32).toString('base64url');
  const { rows } = await pool.query<SessionRow>('SELECT * FROM fn_admin_login($1, $2, $3, $4, $5, $6)',
    [account.id, step, confirming, tokenHash(token), now, SESSION_IDLE_MS / 1000]);
  return rows[0] && issued(account, token, rows[0]);
}

/** The live session a token names, its idle expiry moved forward; undefined for anything else. */
export async function touchSession(pool: pg.Pool, token: string, now: Date): Promise<Session | undefined> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  const { rows } = await pool.query<{ id: string; admin_id: string; login: string; role: Role; idle_expires_at: Date;
    absolute_expires_at: Date; auth_audit_id: string }>(
    `UPDATE admin_session s SET last_seen_at = $2,
       idle_expires_at = least($2::timestamptz + make_interval(secs => $3), s.absolute_expires_at)
     FROM admin_user u
     WHERE s.token_sha256 = $1 AND u.id = s.admin_id AND u.disabled_at IS NULL AND s.revoked_at IS NULL
       AND s.idle_expires_at > $2 AND s.absolute_expires_at > $2
     RETURNING s.id, s.admin_id, u.login, u.role, s.idle_expires_at, s.absolute_expires_at, s.auth_audit_id`,
  [tokenHash(token), now, SESSION_IDLE_MS / 1000]);
  const r = rows[0];
  return r && { id: r.id, adminId: r.admin_id, login: r.login, role: r.role, idleExpiresAt: r.idle_expires_at,
    absoluteExpiresAt: r.absolute_expires_at, authAuditId: Number(r.auth_audit_id) };
}

export type RevokeReason = 'LOGOUT' | 'REVOKED';

/** Revokes a live session of this account; false if there was none to revoke. */
export async function revokeSession(db: pg.Pool | pg.PoolClient, adminId: string, sessionId: string, reason: RevokeReason, now: Date): Promise<boolean> {
  const { rowCount } = await db.query(`UPDATE admin_session SET revoked_at = $3, revoked_reason = $4
    WHERE id = $1 AND admin_id = $2 AND revoked_at IS NULL`, [sessionId, adminId, now, reason]);
  return rowCount === 1;
}

/** A new token for the same session lifetime and authentication; the old one stops working at once. */
export async function rotateSession(pool: pg.Pool, token: string, current: Session, now: Date): Promise<IssuedSession | undefined> {
  const fresh = randomBytes(32).toString('base64url');
  const { rows } = await pool.query<SessionRow>('SELECT * FROM fn_admin_session_rotate($1, $2, $3, $4)',
    [tokenHash(token), tokenHash(fresh), now, SESSION_IDLE_MS / 1000]);
  return rows[0] && issued({ id: current.adminId, login: current.login, role: current.role }, fresh, rows[0]);
}

export async function liveSessions(pool: pg.Pool, adminId: string, now: Date) {
  const { rows } = await pool.query<{ id: string; created_at: Date; last_seen_at: Date; idle_expires_at: Date; absolute_expires_at: Date }>(
    `SELECT id, created_at, last_seen_at, idle_expires_at, absolute_expires_at FROM admin_session
     WHERE admin_id = $1 AND revoked_at IS NULL AND idle_expires_at > $2 AND absolute_expires_at > $2 ORDER BY created_at DESC`,
  [adminId, now]);
  return rows.map(r => ({ id: r.id, createdAt: r.created_at.toISOString(), lastSeenAt: r.last_seen_at.toISOString(),
    idleExpiresAt: r.idle_expires_at.toISOString(), absoluteExpiresAt: r.absolute_expires_at.toISOString() }));
}
