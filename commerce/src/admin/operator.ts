// Admin account operations for an OPERATOR over SSH (migration 0011, admin_operator). Never the Admin
// API's login: the database refuses a login that belongs to admin_app or to commerce. Every command
// is audited by the database itself.

import type pg from 'pg';

import { hashPassword } from './password.js';

export async function createUser(pool: pg.Pool, login: string, role: 'OWNER' | 'EDITOR', password: string, by: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT fn_admin_create_user($1, $2, $3, $4) AS id',
    [login, role, await hashPassword(password), by]);
  return rows[0]!.id;
}

export async function setPassword(pool: pg.Pool, login: string, password: string, by: string): Promise<number> {
  return (await pool.query<{ n: number }>('SELECT fn_admin_set_password($1, $2, $3) AS n', [login, await hashPassword(password), by])).rows[0]!.n;
}

/** The lost-device path: no seed, no session, a new 24-hour enrolment window. */
export async function resetTotp(pool: pg.Pool, login: string, by: string, reason: string): Promise<number> {
  return (await pool.query<{ n: number }>('SELECT fn_admin_reset_totp($1, $2, $3) AS n', [login, by, reason])).rows[0]!.n;
}

export async function setDisabled(pool: pg.Pool, login: string, disabled: boolean, by: string, reason: string): Promise<number> {
  return (await pool.query<{ n: number }>('SELECT fn_admin_set_disabled($1, $2, $3, $4) AS n', [login, disabled, by, reason])).rows[0]!.n;
}

export async function revokeSessions(pool: pg.Pool, login: string, by: string, reason: string): Promise<number> {
  return (await pool.query<{ n: number }>('SELECT fn_admin_revoke_sessions($1, $2, $3) AS n', [login, by, reason])).rows[0]!.n;
}

export async function clearThrottle(pool: pg.Pool, by: string, reason: string): Promise<number> {
  return (await pool.query<{ n: number }>('SELECT fn_admin_clear_throttle($1, $2) AS n', [by, reason])).rows[0]!.n;
}

export async function status(pool: pg.Pool) {
  const { rows } = await pool.query<{ login: string; role: string; disabled: boolean; totp: string; enrolment_until: Date | null; sessions: number }>(
    `SELECT u.login, u.role, u.disabled_at IS NOT NULL AS disabled,
       CASE WHEN t.confirmed_at IS NOT NULL THEN 'ENROLLED' WHEN t.admin_id IS NOT NULL THEN 'PENDING' ELSE 'NONE' END AS totp,
       u.totp_enrollment_until AS enrolment_until,
       (SELECT count(*)::int FROM admin_session s WHERE s.admin_id = u.id AND s.revoked_at IS NULL
          AND s.idle_expires_at > now() AND s.absolute_expires_at > now()) AS sessions
     FROM admin_user u LEFT JOIN admin_totp t ON t.admin_id = u.id ORDER BY u.login`);
  return rows;
}
