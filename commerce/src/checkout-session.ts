// Checkout sessions, intents and resuming a purchase (Track A / A2b-11, A2b-12 for TOUR-28/99;
// migration 0023; OWNER v1.9.1 §9).
//
//   * openCheckoutSession: a random token for the HttpOnly `__Host-` cookie, set before the purchase
//     request so the purchase is found after a lost response. Only its SHA-256 reaches the database.
//     It proves the earlier browser session, not the buyer's identity;
//   * issueCheckoutIntent: the server-side intent of one checkout attempt, with a stable idempotency
//     key (stored as SHA-256); reserveNativePurchase consumes it once, a repeat gets the same purchase;
//   * resumeView / sessionPurchases: the return dialog from server state only, never personal data;
//   * issueResumeCode / verifyResumeCode: another device, by a one-time code to the buyer's email. The
//     six-digit code is stored only as HMAC-SHA256 under a server key that never enters PostgreSQL
//     (CHECKOUT_RESUME_CODE_KEY, Coolify env when TOUR-28/99 wire the route): a read of the database
//     alone cannot brute-force the million codes offline.
//
// Nothing here sets a cookie or serves a route: wiring the public checkout is TOUR-28's, after the
// acceptance in the contract (§15). Delivery of the code by email is TOUR-99's OTP mechanics.

import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';

import type pg from 'pg';

import { normalizeEmail } from './orders.js';

export const CHECKOUT_SESSION_COOKIE = '__Host-mikluha-checkout';
/** The database ends a session after 30 days (migration 0023). */
export const CHECKOUT_SESSION_MAX_AGE_SECONDS = 30 * 24 * 3600;

export const newSecretToken = () => randomBytes(32).toString('base64url');
export const tokenSha256 = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/** The Set-Cookie value for a session token: host-only, HTTPS-only, invisible to scripts. */
export function checkoutSessionCookie(token: string): string {
  if (!/^[A-Za-z0-9_-]{32,200}$/.test(token)) throw new Error('CHECKOUT_SESSION_INVALID');
  return `${CHECKOUT_SESSION_COOKIE}=${token}; Path=/; Max-Age=${CHECKOUT_SESSION_MAX_AGE_SECONDS}; Secure; HttpOnly; SameSite=Lax`;
}

export async function openCheckoutSession(pool: pg.Pool | pg.PoolClient): Promise<{ token: string; sessionRef: string }> {
  const token = newSecretToken();
  const sessionRef = (await pool.query<{ r: string }>('SELECT fn_checkout_session_open($1) AS r', [tokenSha256(token)])).rows[0]!.r;
  return { token, sessionRef };
}

export type IntentRefusal = 'CHECKOUT_SESSION_INVALID' | 'CHECKOUT_INTENT_INVALID' | 'CHECKOUT_INTENT_LIMIT';
const INTENT_REFUSALS = ['CHECKOUT_SESSION_INVALID', 'CHECKOUT_INTENT_INVALID', 'CHECKOUT_INTENT_LIMIT'] as const satisfies readonly IntentRefusal[];

/** The intent of one checkout attempt of this session; the same key returns the same intent. */
export async function issueCheckoutIntent(pool: pg.Pool | pg.PoolClient, sessionToken: string, key: string = newSecretToken()):
  Promise<{ ok: true; checkoutIntentRef: string; key: string } | { ok: false; refusal: IntentRefusal }> {
  try {
    const ref = (await pool.query<{ r: string }>('SELECT fn_checkout_intent_issue($1, $2) AS r',
      [tokenSha256(sessionToken), tokenSha256(key)])).rows[0]!.r;
    return { ok: true, checkoutIntentRef: ref, key };
  } catch (e) {
    const refusal = INTENT_REFUSALS.find((c) => (e as Error).message === c);
    if (refusal === undefined) throw e;
    return { ok: false, refusal };
  }
}

export type ResumeState = 'HOLD_ACTIVE' | 'PAYMENT_IN_PROGRESS' | 'RELEASED' | 'CLOSED' | 'PAID';

/**
 * v1.9.1 §9 п.4: what the return dialog says about seats, by server state. One generic phrase for every
 * state («Места не забронированы») is not allowed: during a hold and a registered payment the seats are held.
 */
export function resumeSeatMessage(state: ResumeState, holdExpiresAt: Date | null, timezone = 'Asia/Krasnoyarsk'): string | null {
  switch (state) {
    case 'HOLD_ACTIVE': {
      const at = holdExpiresAt === null ? '' : ` до ${holdExpiresAt.toLocaleTimeString('ru-RU', { timeZone: timezone, hour: '2-digit', minute: '2-digit' })}`;
      return `Места временно удерживаются${at}.`;
    }
    case 'PAYMENT_IN_PROGRESS': return 'Места защищены на время обработки платежа. Проверяем статус.';
    case 'RELEASED': return 'Места больше не удерживаются. Проверим наличие перед повторной оплатой.';
    case 'CLOSED': return 'Срок оформления истёк.';
    case 'PAID': return null;
  }
}

export interface ResumeView {
  readonly purchaseRef: string; readonly documentOrderRef: string; readonly departureSlug: string;
  readonly tickets: { readonly adults: number; readonly teens: number; readonly children: number };
  readonly totalKopecks: number; readonly state: ResumeState; readonly holdExpiresAt: Date | null;
  /** The earlier of 24 hours after the purchase and T−24 (OWNER 1A); not extended by resuming. */
  readonly retryUntil: Date;
  /** Whether a new payment attempt may still start later (the window above, an open purchase). A hold
   *  created just before the window ends keeps the seats past it: state stays HOLD_ACTIVE meanwhile. */
  readonly newAttemptAllowed: boolean;
  readonly promptDue: boolean;
}

/** The purchase as this session may see it; null when the session does not own it (G-RESUME-02). */
export async function resumeView(pool: pg.Pool | pg.PoolClient, purchaseRef: string, sessionToken: string): Promise<ResumeView | null> {
  try {
    const r = (await pool.query<{ purchase_ref: string; document_order_ref: string; departure_slug: string; adults: number; teens: number;
      children: number; total_kopecks: string; state: ResumeState; hold_expires_at: Date | null; retry_until: Date;
      new_attempt_allowed: boolean; prompt_due: boolean }>(
      'SELECT * FROM fn_purchase_resume_view($1, $2)', [purchaseRef, tokenSha256(sessionToken)])).rows[0]!;
    return { purchaseRef: r.purchase_ref, documentOrderRef: r.document_order_ref, departureSlug: r.departure_slug,
      tickets: { adults: r.adults, teens: r.teens, children: r.children }, totalKopecks: Number(r.total_kopecks), state: r.state,
      holdExpiresAt: r.hold_expires_at, retryUntil: r.retry_until, newAttemptAllowed: r.new_attempt_allowed, promptDue: r.prompt_due };
  } catch (e) {
    if ((e as Error).message === 'PURCHASE_NOT_OWNED') return null;
    throw e;
  }
}

/** The purchases this browser session may return to, newest first. */
export async function sessionPurchases(pool: pg.Pool | pg.PoolClient, sessionToken: string):
  Promise<{ purchaseRef: string; promptDue: boolean }[]> {
  const { rows } = await pool.query<{ purchase_ref: string; prompt_due: boolean }>(
    'SELECT purchase_ref, prompt_due FROM fn_checkout_session_purchases($1)', [tokenSha256(sessionToken)]);
  return rows.map((r) => ({ purchaseRef: r.purchase_ref, promptDue: r.prompt_due }));
}

/** The return dialog was shown: true only the first time. «Не сейчас» cancels nothing. */
export async function markResumePrompted(pool: pg.Pool | pg.PoolClient, purchaseRef: string, sessionToken: string): Promise<boolean> {
  return (await pool.query<{ r: boolean }>('SELECT fn_purchase_resume_prompted($1, $2) AS r', [purchaseRef, tokenSha256(sessionToken)])).rows[0]!.r;
}

/** «Забыть на этом устройстве»: only this session's link to the purchase ends. */
export async function forgetPurchaseOnDevice(pool: pg.Pool | pg.PoolClient, purchaseRef: string, sessionToken: string): Promise<void> {
  await pool.query('SELECT fn_purchase_session_forget($1, $2)', [purchaseRef, tokenSha256(sessionToken)]);
}

/** The environment variable that carries the resume-code key (base64, at least 32 random bytes). */
export const RESUME_CODE_KEY_ENV = 'CHECKOUT_RESUME_CODE_KEY';

/** The server key for resume codes, from its base64 form; refuses a short or malformed key. */
export function resumeCodeKey(base64: string | undefined): Buffer {
  const key = typeof base64 === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(base64) ? Buffer.from(base64, 'base64') : Buffer.alloc(0);
  if (key.length < 32) throw new Error(`RESUME_CODE_KEY_INVALID: ${RESUME_CODE_KEY_ENV} must be base64 of at least 32 random bytes`);
  return key;
}

/** HMAC-SHA256 of the code, bound to the email it was sent to. */
export function resumeCodeHmac(key: Uint8Array, email: string, code: string): string {
  if (key.length < 32) throw new Error('RESUME_CODE_KEY_INVALID');
  return createHmac('sha256', key).update(`mikluha-resume-code:v1\n${email}\n${code}`, 'utf8').digest('hex');
}

/**
 * A one-time six-digit code for every purchase of this email, to send by email (TOUR-99). The caller
 * answers the same way whether or not anything was found: orderIds are for delivery only. The public
 * route adds its own request rate limit (TOUR-99) on top of the database's three codes per hour.
 */
export async function issueResumeCode(pool: pg.Pool | pg.PoolClient, email: string, key: Uint8Array): Promise<{ code: string; orderIds: string[] }> {
  const normalized = normalizeEmail(email);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  if (normalized === null) return { code, orderIds: [] };
  const { rows } = await pool.query<{ order_id: string }>('SELECT order_id FROM fn_purchase_resume_code_issue($1, $2)',
    [normalized, resumeCodeHmac(key, normalized, code)]);
  return { code, orderIds: rows.map((r) => r.order_id) };
}

/** Binds this session to the email's purchases whose live code matches; [] for a wrong or dead code. */
export async function verifyResumeCode(pool: pg.Pool | pg.PoolClient, email: string, code: string, sessionToken: string,
  key: Uint8Array): Promise<string[]> {
  const normalized = normalizeEmail(email);
  if (normalized === null || !/^[0-9]{6}$/.test(code)) return [];
  const { rows } = await pool.query<{ purchase_ref: string }>('SELECT purchase_ref FROM fn_purchase_resume_code_verify($1, $2, $3)',
    [normalized, resumeCodeHmac(key, normalized, code), tokenSha256(sessionToken)]);
  return rows.map((r) => r.purchase_ref);
}
