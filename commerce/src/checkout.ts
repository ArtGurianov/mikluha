// An order's Refref checkout (refref docs/28 §2): handoff → resolution → the customer accepts the
// final price → one frozen attempt → the PROVIDER payment session → Refref's read-back decides.
//
// Money rules (Linear ART-47):
//   * Only Refref's read-back makes an order PAID: the obligation SATISFIED by a SUCCEEDED Payment of
//     exactly the payable amount. The customer coming back from the bank decides nothing.
//   * One checkout attempt per order, created with one fixed Idempotency-Key; an unanswered request
//     is repeated identically, never replaced. A payment session is only ever re-requested on that
//     attempt, where Refref replays a live initiation and starts a new one only after a definitive
//     failure. So an ambiguous payment is never followed by a second one.
//   * Seats of a pending payment are freed only when Refref confirms the attempt can no longer
//     settle (cancel answered CANCELLED, or the attempt read back CANCELLED/EXPIRED without money).
//     Anything inconsistent is HELD for a person, seats kept.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type pg from 'pg';

import type { Catalog } from './catalog.js';
import type { Logger } from './log.js';
import { errorCode, type CheckoutAttempt, type RefrefClient, type ResolvedResolution } from './refref.js';
import { contractHash, renderZayavka, sha256Hex } from './zayavka.js';
import type { Tourist } from './orders.js';
import { buildSnapshot, LINE_REF, OBLIGATION_REF, orderLine, resolutionInputHash, snapshotDigest, type Json, type OrderDeal } from './snapshot.js';

export interface Merchant {
  /** Refref Business id and slug. */
  readonly businessId: string;
  readonly businessSlug: string;
  /** e.g. https://checkout.refref.ru — where the attribution handoff and customer actions live. */
  readonly checkoutOrigin: string;
  /** This service's public origin; /return and /orders/ must be authorized destinations of the Business. */
  readonly origin: string;
  /** The public site's origin, where the offer and the other legal pages are published. */
  readonly siteOrigin: string;
}

export interface CheckoutDeps {
  readonly pool: pg.Pool;
  readonly catalog: Catalog;
  readonly refref: RefrefClient;
  readonly merchant: Merchant;
  readonly log: Logger;
  readonly now?: () => Date;
}

/** An attempt still OUTSTANDING this long after the customer chose to pay is abandoned: cancel it. */
export const ABANDON_AFTER_MINUTES = 60;
/** Attempt creation still unanswered this long after freezing: a person looks. */
export const ATTEMPT_UNCONFIRMED_AFTER_MINUTES = 60;

/** Refusals of createCheckoutAttempt after which no attempt exists (docs/28 §8): the order can end. */
const ATTEMPT_NOT_CREATED = new Set(['SNAPSHOT_HASH_MISMATCH', 'SNAPSHOT_INVALID', 'REFERRAL_RESOLUTION_NOT_USABLE',
  'REFERRAL_RESOLUTION_MISMATCH', 'UNSUPPORTED_OBLIGATION_KIND', 'FISCAL_PROFILE_UNSUPPORTED']);

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

interface OrderRow {
  id: string; order_ref: string; departure_slug: string; trip_starts_on: string; trip_ends_on: string; seats: number;
  amount_kopecks: string; status: string; reserved_until: Date; legal_release_ref: string; legal_release_hash: string;
  legal_release_content: string | null;
  pd_consent_ref: string; pd_consent_hash: string; pd_consent_content: string; pd_consent_accepted_at: Date;
  state_hash: string | null; referral_resolution_id: string | null; terms_version_id: string | null;
  resolution_expires_at: Date | null; discount_kopecks: string | null; payable_kopecks: string | null;
  snapshot: Record<string, Json> | null; snapshot_hash: string | null; payment_pending_since: Date | null;
  checkout_attempt_id: string | null; last_session: string | null;
}

const ORDER_COLUMNS = `id, order_ref, departure_slug, to_char(trip_starts_on, 'YYYY-MM-DD') AS trip_starts_on,
  to_char(trip_ends_on, 'YYYY-MM-DD') AS trip_ends_on, seats, amount_kopecks, status, reserved_until,
  legal_release_ref, legal_release_hash, legal_release_content, pd_consent_ref, pd_consent_hash, pd_consent_content, pd_consent_accepted_at,
  state_hash, referral_resolution_id, terms_version_id, resolution_expires_at,
  discount_kopecks, payable_kopecks, snapshot, snapshot_hash, payment_pending_since, checkout_attempt_id, last_session`;

async function loadOrder(pool: pg.Pool, orderRef: string): Promise<OrderRow | null> {
  const { rows } = await pool.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE order_ref = $1`, [orderRef]);
  return rows[0] ?? null;
}

function deal(deps: CheckoutDeps, o: OrderRow): OrderDeal {
  const d = deps.catalog.departures.get(o.departure_slug);
  // Built from the order's own frozen facts; the catalog supplies only names.
  return { orderRef: o.order_ref, tourSlug: d?.tourSlug ?? 'unknown', tourTitle: d?.tourTitle ?? o.departure_slug,
    departureSlug: o.departure_slug, startsOn: o.trip_starts_on, endsOn: o.trip_ends_on, seats: o.seats,
    amountKopecks: Number(o.amount_kopecks), timezone: deps.catalog.timezone };
}

/** Compare-and-set on the order's state: a concurrent change makes it a no-op. */
async function transition(pool: pg.Pool, o: OrderRow, from: string, set: Record<string, unknown>, event: string, detail: string | null, now: Date): Promise<boolean> {
  const cols = Object.keys(set);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`UPDATE orders SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}
      WHERE id = $1 AND status = $2`, [o.id, from, ...cols.map((c) => set[c])]);
    if (r.rowCount !== 1) { await client.query('ROLLBACK'); return false; }
    await client.query('INSERT INTO order_event (order_id, at, event, detail) VALUES ($1, $2, $3, $4)', [o.id, now, event, detail]);
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

const hold = (deps: CheckoutDeps, o: OrderRow, from: string, reason: string, now: Date) => {
  deps.log('order_held', { orderRef: o.order_ref, reason });
  return transition(deps.pool, o, from, { status: 'HELD', hold_reason: reason }, 'HELD', reason, now);
};

const cancel = (deps: CheckoutDeps, o: OrderRow, from: string, reason: string, now: Date) => {
  deps.log('order_cancelled', { orderRef: o.order_ref, reason });
  return transition(deps.pool, o, from, { status: 'CANCELLED', closed_at: now }, 'CANCELLED', reason, now);
};

// ---------------------------------------------------------------------------------------------
// Handoff and resolution

/** The URL that sends the customer through Refref's attribution handoff, and back to /return. */
export function handoffUrl(merchant: Merchant, orderRef: string, state: string): string {
  const u = new URL('/v1-rc/public/attribution-handoff', merchant.checkoutOrigin);
  u.searchParams.set('merchant', merchant.businessSlug);
  u.searchParams.set('merchantOrderRef', orderRef);
  u.searchParams.set('returnUrl', `${merchant.origin}/return`);
  u.searchParams.set('state', state);
  return u.toString();
}

/**
 * The secret that ties the handoff's return to this customer's browser (docs/28 §12, session swap).
 * Only its hash is stored; the browser keeps it in a cookie.
 */
export async function issueState(pool: pg.Pool, orderRef: string): Promise<string | null> {
  const state = randomBytes(24).toString('base64url');
  const r = await pool.query(`UPDATE orders SET state_hash = $2 WHERE order_ref = $1 AND status = 'RESERVED' AND state_hash IS NULL`,
    [orderRef, sha256(state)]);
  return r.rowCount === 1 ? state : null;
}

/** Whether the browser holding `cookieState` is the one that started this order. */
export async function ownsOrder(pool: pg.Pool, orderRef: string, cookieState: string | undefined): Promise<boolean> {
  if (cookieState === undefined || cookieState === '') return false;
  const { rows } = await pool.query<{ state_hash: string | null }>('SELECT state_hash FROM orders WHERE order_ref = $1', [orderRef]);
  const h = rows[0]?.state_hash;
  return typeof h === 'string' && sameSecret(h, sha256(cookieState));
}

export type ReturnOutcome =
  | { readonly kind: 'CONFIRM'; readonly orderRef: string }
  | { readonly kind: 'REDIRECT'; readonly url: string }
  | { readonly kind: 'REFUSED'; readonly code: string; readonly orderRef?: string };

/** GET /return?rt=&state=: verify state against the browser's own, then resolve the referral. */
export async function onReturn(deps: CheckoutDeps, q: { rt: string | null; state: string | null; cookieState: (orderRef: string) => string | undefined }): Promise<ReturnOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  if (!q.rt || !q.state) return { kind: 'REFUSED', code: 'RETURN_INCOMPLETE' };
  const { rows } = await deps.pool.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE state_hash = $1`, [sha256(q.state)]);
  const o = rows[0];
  // The state names the order, and the browser must hold the same state for it.
  const cookie = o === undefined ? undefined : q.cookieState(o.order_ref);
  if (o === undefined || cookie === undefined || !sameSecret(cookie, q.state)) return { kind: 'REFUSED', code: 'STATE_MISMATCH' };
  if (o.status !== 'RESERVED') return { kind: 'CONFIRM', orderRef: o.order_ref };
  if (o.reserved_until <= now) return { kind: 'REFUSED', code: 'RESERVATION_EXPIRED', orderRef: o.order_ref };

  const d = deal(deps, o);
  const line = orderLine(d);
  const r = await deps.refref.resolve({ handoffToken: q.rt, merchantOrderRef: o.order_ref, currency: 'RUB', lines: [line] });
  if (r.kind === 'UNKNOWN') return { kind: 'REFUSED', code: 'REFREF_UNAVAILABLE', orderRef: o.order_ref };
  if (r.status >= 300) {
    deps.log('resolution_refused', { orderRef: o.order_ref, status: r.status, code: errorCode(r.body) });
    return { kind: 'REFUSED', code: errorCode(r.body), orderRef: o.order_ref };
  }
  if (r.body.status === 'CUSTOMER_ACTION_REQUIRED') {
    const url = new URL(r.body.customerActionUrl);
    if (url.origin !== new URL(deps.merchant.checkoutOrigin).origin) return { kind: 'REFUSED', code: 'CUSTOMER_ACTION_URL_FOREIGN' };
    return { kind: 'REDIRECT', url: url.toString() };
  }
  const res: ResolvedResolution = r.body;
  const discount = res.lines.find((l) => l.lineRef === LINE_REF)?.referralDiscountAmountKopecks;
  // Refref must have priced exactly our line: the input hash we compute ourselves.
  if (res.status !== 'RESOLVED' || res.merchantOrderRef !== o.order_ref || discount === undefined
    || !Number.isSafeInteger(discount) || discount < 0 || discount >= Number(o.amount_kopecks)
    || res.inputHash !== resolutionInputHash(deps.merchant.businessId, o.order_ref, [line])) {
    deps.log('resolution_unusable', { orderRef: o.order_ref });
    return { kind: 'REFUSED', code: 'RESOLUTION_UNUSABLE', orderRef: o.order_ref };
  }
  await transition(deps.pool, o, 'RESERVED', {
    referral_resolution_id: res.referralResolutionId, terms_version_id: res.termsVersionId,
    attribution_source: res.attributionSource, resolution_expires_at: new Date(res.expiresAt),
    discount_kopecks: discount, payable_kopecks: Number(o.amount_kopecks) - discount,
  }, 'RESOLVED', res.attributionSource.replace(/[^A-Z_]/g, ''), now);
  deps.log('resolved', { orderRef: o.order_ref, attribution: res.attributionSource, discountKopecks: discount });
  if (!(await writeZayavka(deps, o.order_ref, now))) return { kind: 'REFUSED', code: 'DEPARTURE_NO_CONTRACT', orderRef: o.order_ref };
  return { kind: 'CONFIRM', orderRef: o.order_ref };
}

/**
 * (Re)write the order's Заявка from its frozen facts, its tourists and the departure's contract
 * data. Only while RESERVED: once the customer pays, the database refuses any change.
 */
async function writeZayavka(deps: CheckoutDeps, orderRef: string, now: Date): Promise<boolean> {
  const o = await loadOrder(deps.pool, orderRef);
  if (o === null || o.status !== 'RESERVED' || o.payable_kopecks === null) return false;
  const departure = deps.catalog.departures.get(o.departure_slug);
  if (departure === undefined || departure.contract === null) return false;
  const contact = (await deps.pool.query<{ full_name: string; phone: string; email: string }>(
    'SELECT full_name, phone, email FROM order_contact WHERE order_id = $1', [o.id])).rows[0];
  if (contact === undefined) return false;
  const tourists = (await deps.pool.query<{ full_name: string; dob: string; citizenship: string; document_type: Tourist['documentType'];
    document_series: string | null; document_number: string }>(
    `SELECT full_name, to_char(date_of_birth, 'YYYY-MM-DD') AS dob, citizenship, document_type, document_series, document_number
       FROM order_passenger WHERE order_id = $1 ORDER BY position`, [o.id])).rows
    .map((t) => ({ fullName: t.full_name, dateOfBirth: t.dob, citizenship: t.citizenship, documentType: t.document_type,
      documentSeries: t.document_series, documentNumber: t.document_number }));
  const formedAt = new Intl.DateTimeFormat('ru-RU', { timeZone: deps.catalog.timezone, dateStyle: 'short', timeStyle: 'short' }).format(now);
  const content = renderZayavka({
    orderRef: o.order_ref, formedAt, offerRef: o.legal_release_ref,
    departure: { ...departure, contract: departure.contract, startsOn: o.trip_starts_on, endsOn: o.trip_ends_on },
    contact: { fullName: contact.full_name, phone: contact.phone, email: contact.email },
    tourists, amountKopecks: Number(o.amount_kopecks), discountKopecks: Number(o.discount_kopecks),
  });
  await deps.pool.query(`INSERT INTO order_document (order_id, kind, content, sha256, created_at) VALUES ($1, 'ZAYAVKA', $2, $3, $4)
    ON CONFLICT (order_id, kind) DO UPDATE SET content = EXCLUDED.content, sha256 = EXCLUDED.sha256, created_at = EXCLUDED.created_at`,
  [o.id, content, sha256Hex(content), now]);
  return true;
}

/** The order's Заявка as stored: what the customer is shown, and what they accept by paying. */
export async function zayavkaOf(pool: pg.Pool, orderRef: string): Promise<{ content: string | null; sha256: string } | null> {
  const { rows } = await pool.query<{ content: string | null; sha256: string }>(
    `SELECT d.content, d.sha256 FROM order_document d JOIN orders o ON o.id = d.order_id WHERE o.order_ref = $1 AND d.kind = 'ZAYAVKA'`, [orderRef]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Paying

export type PayOutcome =
  | { readonly kind: 'REDIRECT'; readonly url: string }
  | { readonly kind: 'STATUS'; readonly code?: string };

/**
 * POST /orders/:ref/pay — the customer accepted the final price and the Заявка whose hash the form
 * carried. A Заявка that changed since it was shown (a new resolution in another tab) is refused.
 */
export async function pay(deps: CheckoutDeps, orderRef: string, acceptedZayavka: string): Promise<PayOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  let o = await loadOrder(deps.pool, orderRef);
  if (o === null) return { kind: 'STATUS', code: 'UNKNOWN_ORDER' };

  if (o.status === 'RESERVED') {
    if (o.legal_release_content === null || o.legal_release_hash !== `sha256:${sha256(o.legal_release_content)}`
      || o.legal_release_ref.trim() === '') {
      return { kind: 'STATUS', code: 'LEGAL_RELEASE_INVALID' };
    }
    if (o.pd_consent_hash !== `sha256:${sha256(o.pd_consent_content)}` || o.pd_consent_ref.trim() === '') {
      return { kind: 'STATUS', code: 'PD_CONSENT_INVALID' };
    }
    if (o.referral_resolution_id === null) return { kind: 'STATUS', code: 'NOT_RESOLVED' };
    if (o.reserved_until <= now || o.resolution_expires_at! <= now) return { kind: 'STATUS', code: 'RESERVATION_EXPIRED' };
    const zayavka = await zayavkaOf(deps.pool, orderRef);
    if (zayavka === null) return { kind: 'STATUS', code: 'NOT_RESOLVED' };
    if (zayavka.sha256 !== acceptedZayavka) return { kind: 'STATUS', code: 'DOCUMENT_CHANGED' };
    const snapshot = buildSnapshot(deal(deps, o), { merchantId: deps.merchant.businessId,
      referralResolutionId: o.referral_resolution_id, termsVersionId: o.terms_version_id, discountKopecks: Number(o.discount_kopecks) },
    { ref: o.legal_release_ref, hash: contractHash(o.legal_release_ref, o.legal_release_hash, zayavka.sha256) });
    const hash = snapshotDigest(snapshot);
    // Freeze, under the booking switch: a closed switch stops new payments too.
    const client = await deps.pool.connect();
    try {
      await client.query('BEGIN');
      const open = await client.query<{ open: boolean }>('SELECT fn_sales_open_for_sale() AS open');
      if (open.rows[0]?.open !== true) { await client.query('ROLLBACK'); return { kind: 'STATUS', code: 'SALES_CLOSED' }; }
      const r = await client.query(`UPDATE orders SET status = 'PAYMENT_PENDING', snapshot = $2, snapshot_hash = $3,
          payment_pending_since = $4 WHERE id = $1 AND status = 'RESERVED' AND reserved_until > $4`, [o.id, snapshot, hash, now]);
      if (r.rowCount !== 1) { await client.query('ROLLBACK'); return { kind: 'STATUS', code: 'RESERVATION_EXPIRED' }; }
      await client.query(`INSERT INTO order_event (order_id, at, event) VALUES ($1, $2, 'FROZEN')`, [o.id, now]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    deps.log('frozen', { orderRef, payableKopecks: Number(o.payable_kopecks) });
    o = (await loadOrder(deps.pool, orderRef))!;
  }
  if (o.status !== 'PAYMENT_PENDING') return { kind: 'STATUS' };
  const attemptId = o.checkout_attempt_id ?? await ensureAttempt(deps, o, now);
  if (attemptId === null) return { kind: 'STATUS' };

  const contact = await deps.pool.query<{ email: string }>('SELECT email FROM order_contact WHERE order_id = $1', [o.id]);
  const email = contact.rows[0]?.email;
  if (email === undefined) { await hold(deps, o, 'PAYMENT_PENDING', 'CONTACT_MISSING', now); return { kind: 'STATUS' }; }
  const s = await underOpenSwitch(deps.pool, () => deps.refref.paymentSession(orderRef, attemptId, OBLIGATION_REF,
    { successUrl: `${deps.merchant.origin}/orders/${orderRef}`, receiptContact: { email } }));
  if (s === 'SALES_CLOSED') return { kind: 'STATUS', code: 'SALES_CLOSED' };
  if (s.kind === 'UNKNOWN') {
    await setLastSession(deps.pool, o.id, 'UNKNOWN');
    return { kind: 'STATUS' };
  }
  if (s.status === 409) {
    // OBLIGATION_NOT_PAYABLE: already satisfied or the attempt is no longer open. Read it back.
    await reconcileOrder(deps, orderRef);
    return { kind: 'STATUS' };
  }
  if (s.status >= 300) {
    await hold(deps, o, 'PAYMENT_PENDING', `SESSION_REFUSED:${errorCode(s.body)}`, now);
    return { kind: 'STATUS' };
  }
  const session = s.body;
  await setLastSession(deps.pool, o.id, session.status === 'PAYMENT_FAILED' ? `PAYMENT_FAILED:${session.failureCode ?? 'UNKNOWN'}` : session.status);
  deps.log('payment_session', { orderRef, status: session.status, failureCode: session.failureCode ?? null });
  if (session.status === 'PAYMENT_READY' && session.providerPaymentUrl !== undefined && session.providerPaymentUrl.startsWith('https://')) {
    return { kind: 'REDIRECT', url: session.providerPaymentUrl };
  }
  return { kind: 'STATUS' };
}

/**
 * Start money only while the booking switch is open, and keep it open until the request has been
 * made: the switch's share lock is held across the Refref call itself. An operator's close
 * (fn_set_sales_open, an UPDATE of that row) therefore either commits first, and this sees it
 * closed and sends nothing, or waits until the request already under way has finished. Once a
 * close has committed, no payment session can start (refref ops/runbooks/stop-sales.md). The wait
 * is bounded by the client's timeout.
 */
async function underOpenSwitch<T>(pool: pg.Pool, start: () => Promise<T>): Promise<T | 'SALES_CLOSED'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ open: boolean }>('SELECT fn_sales_open_for_sale() AS open');
    if (rows[0]?.open !== true) return 'SALES_CLOSED';
    return await start();
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function setLastSession(pool: pg.Pool, id: string, value: string): Promise<void> {
  await pool.query(`UPDATE orders SET last_session = $2 WHERE id = $1 AND status = 'PAYMENT_PENDING'`, [id, value]);
}

/**
 * Create the order's one attempt, or learn it was created: the same body and Idempotency-Key every
 * time. Returns the attempt id, or null while unknown or after the order ended.
 */
async function ensureAttempt(deps: CheckoutDeps, o: OrderRow, now: Date): Promise<string | null> {
  const r = await deps.refref.createAttempt(o.order_ref,
    { referralResolutionId: o.referral_resolution_id!, snapshot: o.snapshot, snapshotHash: o.snapshot_hash! }, `mk-attempt:${o.order_ref}`);
  if (r.kind === 'UNKNOWN') {
    if (o.payment_pending_since! <= new Date(now.getTime() - ATTEMPT_UNCONFIRMED_AFTER_MINUTES * 60_000)) {
      await hold(deps, o, 'PAYMENT_PENDING', 'ATTEMPT_UNCONFIRMED', now);
    }
    return null;
  }
  if (r.status >= 300) {
    const code = errorCode(r.body);
    if (ATTEMPT_NOT_CREATED.has(code)) await cancel(deps, o, 'PAYMENT_PENDING', `ATTEMPT_REFUSED:${code}`, now);
    else await hold(deps, o, 'PAYMENT_PENDING', `ATTEMPT_REFUSED:${code}`, now);
    return null;
  }
  if (r.body.snapshotHash !== o.snapshot_hash) {
    await hold(deps, o, 'PAYMENT_PENDING', 'SNAPSHOT_DIVERGED', now);
    return null;
  }
  const set = await deps.pool.query(`UPDATE orders SET checkout_attempt_id = $2 WHERE id = $1 AND checkout_attempt_id IS NULL`,
    [o.id, r.body.checkoutAttemptId]);
  if (set.rowCount === 1) {
    await deps.pool.query(`INSERT INTO order_event (order_id, at, event) VALUES ($1, $2, 'ATTEMPT_CREATED')`, [o.id, now]);
  }
  const { rows } = await deps.pool.query<{ checkout_attempt_id: string | null }>('SELECT checkout_attempt_id FROM orders WHERE id = $1', [o.id]);
  return rows[0]?.checkout_attempt_id ?? null;
}

// ---------------------------------------------------------------------------------------------
// Read-back

/** What Refref's read-back of the attempt means for the order. */
export type Verdict =
  | { readonly kind: 'PAID'; readonly paymentId: string; readonly paidAt: Date }
  | { readonly kind: 'CANCELLED'; readonly reason: string }
  | { readonly kind: 'HELD'; readonly reason: string }
  | { readonly kind: 'ABANDONED' }
  | { readonly kind: 'WAIT' };

export function verdict(attempt: CheckoutAttempt, payableKopecks: number, snapshotHash: string, abandoned: boolean, now: Date): Verdict {
  if (attempt.snapshotHash !== snapshotHash) return { kind: 'HELD', reason: 'SNAPSHOT_DIVERGED' };
  const ob = attempt.obligations.find((x) => x.obligationRef === OBLIGATION_REF);
  if (ob === undefined) return { kind: 'HELD', reason: 'OBLIGATION_MISSING' };
  const p = ob.payment;
  if (ob.status === 'SATISFIED') {
    if (p === null) return { kind: 'HELD', reason: 'SATISFIED_WITHOUT_PAYMENT' };
    if (p.amountKopecks !== payableKopecks) return { kind: 'HELD', reason: 'PAYMENT_AMOUNT_MISMATCH' };
    if (p.status !== 'SUCCEEDED') return { kind: 'HELD', reason: `PAYMENT_${p.status.replace(/[^A-Z_]/g, '')}` };
    return { kind: 'PAID', paymentId: p.id, paidAt: p.succeededAt ? new Date(p.succeededAt) : now };
  }
  if (ob.status === 'LATE_PAYMENT') return { kind: 'HELD', reason: 'LATE_PAYMENT' };
  if (attempt.status === 'CANCELLED' || attempt.status === 'EXPIRED' || ob.status === 'CANCELLED') {
    // Money that moved is never "cancelled" here: a person sees it.
    return p !== null && p.status !== 'FAILED' && p.status !== 'CANCELLED'
      ? { kind: 'HELD', reason: 'ENDED_WITH_PAYMENT' }
      : { kind: 'CANCELLED', reason: `ATTEMPT_${attempt.status}` };
  }
  if (attempt.status === 'SETTLED') return { kind: 'HELD', reason: 'SETTLED_NOT_SATISFIED' };
  if (ob.status === 'OUTSTANDING' && abandoned) return { kind: 'ABANDONED' };
  return { kind: 'WAIT' };
}

/** Bring one order up to date with Refref. Safe to run any number of times, concurrently. */
export async function reconcileOrder(deps: CheckoutDeps, orderRef: string): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const o = await loadOrder(deps.pool, orderRef);
  if (o === null) return;
  if (o.status === 'PAYMENT_PENDING') {
    const attemptId = o.checkout_attempt_id ?? await ensureAttempt(deps, o, now);
    if (attemptId === null) return;
    const read = await deps.refref.getAttempt(o.order_ref, attemptId);
    if (read.kind === 'UNKNOWN') return;
    if (read.status !== 200) { await hold(deps, o, 'PAYMENT_PENDING', `READ_BACK_${read.status}`, now); return; }
    await deps.pool.query('UPDATE orders SET last_reconciled_at = $2 WHERE id = $1', [o.id, now]);
    const abandoned = o.payment_pending_since! <= new Date(now.getTime() - ABANDON_AFTER_MINUTES * 60_000);
    const v = verdict(read.body, Number(o.payable_kopecks), o.snapshot_hash!, abandoned, now);
    if (v.kind === 'PAID') {
      if (await transition(deps.pool, o, 'PAYMENT_PENDING', { status: 'PAID', payment_id: v.paymentId, paid_at: v.paidAt }, 'PAID', null, now)) {
        deps.log('paid', { orderRef: o.order_ref });
        await fulfil(deps, { ...o, status: 'PAID' }, attemptId, now);
      }
    } else if (v.kind === 'CANCELLED') {
      await cancel(deps, o, 'PAYMENT_PENDING', v.reason, now);
    } else if (v.kind === 'HELD') {
      await hold(deps, o, 'PAYMENT_PENDING', v.reason, now);
    } else if (v.kind === 'ABANDONED') {
      // Refref cancels only once the provider can no longer settle; otherwise it refuses (409).
      const c = await deps.refref.cancelAttempt(o.order_ref, attemptId, `mk-cancel:${o.order_ref}`);
      if (c.kind === 'ANSWERED' && c.status === 200 && c.body.status === 'CANCELLED') {
        const after = verdict(c.body, Number(o.payable_kopecks), o.snapshot_hash!, false, now);
        if (after.kind === 'CANCELLED') await cancel(deps, o, 'PAYMENT_PENDING', 'ABANDONED', now);
        else if (after.kind === 'HELD') await hold(deps, o, 'PAYMENT_PENDING', after.reason, now);
      }
    }
  } else if (o.status === 'PAID' && o.checkout_attempt_id !== null) {
    await fulfil(deps, o, o.checkout_attempt_id, now);
  }
}

/** Atomically confirm the order and queue exactly one customer email. */
async function markFulfilledAndQueueEmail(deps: CheckoutDeps, o: OrderRow, now: Date): Promise<boolean> {
  const accessToken = randomBytes(32).toString('base64url');
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    const contact = await client.query<{ email: string }>(
      'SELECT email FROM order_contact WHERE order_id = $1', [o.id]);
    if (contact.rows[0] === undefined) { await client.query('ROLLBACK'); return false; }
    const changed = await client.query(
      `UPDATE orders SET status = 'FULFILLED', fulfilled_at = $3, document_access_hash = $4
        WHERE id = $1 AND status = $2`, [o.id, 'PAID', now, sha256(accessToken)]);
    if (changed.rowCount !== 1) { await client.query('ROLLBACK'); return false; }
    await client.query(`INSERT INTO order_event (order_id, at, event) VALUES ($1, $2, 'FULFILLED')`, [o.id, now]);
    await client.query(`INSERT INTO email_outbox
      (order_id, type, recipient_email, access_token, idempotency_key, state, attempts, next_attempt_at, created_at)
      VALUES ($1, 'BOOKING_CONFIRMATION', $2, $3, $4, 'PENDING', 0, $5, $5)`,
    [o.id, contact.rows[0].email, accessToken, `mk-confirm:${o.order_ref}`, now]);
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** The booking is confirmed: tell Refref (once, idempotently), then fulfil and enqueue locally. */
async function fulfil(deps: CheckoutDeps, o: OrderRow, attemptId: string, now: Date): Promise<void> {
  const ack = await deps.refref.acknowledgeFulfillment(o.order_ref, attemptId, `mk-fulfil:${o.order_ref}`);
  if (ack.kind === 'ANSWERED' && ack.status === 200) {
    if (await markFulfilledAndQueueEmail(deps, o, now)) deps.log('fulfilled', { orderRef: o.order_ref });
  }
}

/** Every order whose money is in motion. Run every minute, beside maintain(). */
export async function reconcileAll(deps: CheckoutDeps): Promise<number> {
  const { rows } = await deps.pool.query<{ order_ref: string }>(
    `SELECT order_ref FROM orders WHERE status IN ('PAYMENT_PENDING', 'PAID') ORDER BY payment_pending_since`);
  for (const r of rows) {
    try {
      await reconcileOrder(deps, r.order_ref);
    } catch (e) {
      deps.log('reconcile_failed', { orderRef: r.order_ref, error: e instanceof Error ? e.name : 'unknown' });
    }
  }
  return rows.length;
}
