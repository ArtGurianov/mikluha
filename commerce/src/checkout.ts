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

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type pg from 'pg';

import { bookingCutoff, bookingCutoffAt } from './booking-window.js';

import { contractSnapshotIntact, type ContractSnapshot } from './contract-snapshot.js';
import { refundWorkflowQualified, type Catalog } from './catalog.js';
import type { Logger } from './log.js';
import type { LegalReleaseAdmission } from './legal-admission.js';
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
  /** Bounded separate pool for the mandatory stop barrier around mutating Refref calls. */
  readonly initiationPool?: pg.Pool;
  readonly catalog: Catalog;
  readonly refref: RefrefClient;
  readonly merchant: Merchant;
  readonly log: Logger;
  readonly legalAdmission?: LegalReleaseAdmission;
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
  trip_departure_time: string | null; trip_return_time: string | null; trip_timezone: string | null;
  amount_kopecks: string; status: string; reserved_until: Date; legal_release_ref: string; legal_release_hash: string;
  legal_release_content: string | null;
  pd_consent_ref: string; pd_consent_hash: string; pd_consent_content: string; pd_consent_accepted_at: Date;
  state_hash: string | null; referral_resolution_id: string | null; terms_version_id: string | null;
  resolution_expires_at: Date | null; discount_kopecks: string | null; payable_kopecks: string | null;
  contract_snapshot: ContractSnapshot | null; contract_snapshot_sha256: string | null;
  quote_issued_at: Date | null; quote_expires_at: Date | null;
  snapshot: Record<string, Json> | null; snapshot_hash: string | null; payment_pending_since: Date | null;
  resolution_operation_id: string | null; resolution_started_at: Date | null;
  attempt_creation_state: 'NOT_STARTED' | 'STARTED' | 'UNKNOWN';
  checkout_attempt_id: string | null; last_session: string | null;
}

const ORDER_COLUMNS = `id, order_ref, departure_slug, to_char(trip_starts_on, 'YYYY-MM-DD') AS trip_starts_on,
  to_char(trip_ends_on, 'YYYY-MM-DD') AS trip_ends_on, trip_departure_time, trip_return_time, trip_timezone, seats, amount_kopecks, status, reserved_until,
  legal_release_ref, legal_release_hash, legal_release_content, pd_consent_ref, pd_consent_hash, pd_consent_content, pd_consent_accepted_at,
  state_hash, referral_resolution_id, terms_version_id, resolution_expires_at,
  contract_snapshot, contract_snapshot_sha256, quote_issued_at, quote_expires_at,
  discount_kopecks, payable_kopecks, snapshot, snapshot_hash, payment_pending_since, resolution_operation_id, resolution_started_at, attempt_creation_state, checkout_attempt_id, last_session`;

async function loadOrder(pool: pg.Pool | pg.PoolClient, orderRef: string, lock = false): Promise<OrderRow | null> {
  const { rows } = await pool.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE order_ref = $1${lock ? ' FOR UPDATE' : ''}`, [orderRef]);
  return rows[0] ?? null;
}

function deal(o: OrderRow): OrderDeal {
  const c = o.contract_snapshot!;
  return { orderRef: o.order_ref, tourSlug: c.tourSlug, tourTitle: c.tourTitle,
    departureSlug: c.departureSlug, startsOn: c.startsOn, endsOn: c.endsOn, seats: o.seats,
    startsTime: c.contract.departure.departureTime, endsTime: c.contract.departure.returnTime,
    amountKopecks: Number(o.amount_kopecks), timezone: c.timezone };
}

/** Compare-and-set on the order's state: a concurrent change makes it a no-op. */
async function transition(pool: pg.Pool, o: OrderRow, from: string, set: Record<string, unknown>, event: string, detail: string | null, now: Date): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const changed = await transitionLocked(client, o, from, set, event, detail, now);
    await client.query('COMMIT');
    return changed;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** The caller holds the order row; dispatch/read-back must not open a second transaction. */
async function transitionLocked(client: pg.PoolClient, o: OrderRow, from: string, set: Record<string, unknown>,
  event: string, detail: string | null, now: Date): Promise<boolean> {
  const cols = Object.keys(set);
  const r = await client.query(`UPDATE orders SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}
    WHERE id = $1 AND status = $2`, [o.id, from, ...cols.map(c => set[c])]);
  if (r.rowCount !== 1) return false;
  await client.query('INSERT INTO order_event (order_id, at, event, detail) VALUES ($1,$2,$3,$4)', [o.id,now,event,detail]);
  return true;
}

const hold = async (deps: CheckoutDeps, o: OrderRow, from: string, reason: string, now: Date) => {
  const changed = await transition(deps.pool, o, from, { status: 'HELD', hold_reason: reason }, 'HELD', reason, now);
  if (changed) deps.log('order_held', { orderRef: o.order_ref, reason });
  return changed;
};

const cancel = async (deps: CheckoutDeps, o: OrderRow, from: string, reason: string, now: Date) => {
  const changed = await transition(deps.pool, o, from, { status: 'CANCELLED', closed_at: now }, 'CANCELLED', reason, now);
  if (changed) deps.log('order_cancelled', { orderRef: o.order_ref, reason });
  return changed;
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

// Duplicate tabs share bounded work rather than queuing transactions/connections behind HTTP.
const activeWork=new WeakMap<pg.Pool,Map<string,Promise<unknown>>>();
function singleFlight<T>(pool:pg.Pool,key:string,work:()=>Promise<T>):Promise<T> {
  let running=activeWork.get(pool);
  if (!running) { running=new Map(); activeWork.set(pool,running); }
  const existing=running.get(key); if (existing) return existing as Promise<T>;
  const promise=work(); running.set(key,promise);
  const clear=()=>{ if (running!.get(key)===promise) running!.delete(key); };
  void promise.then(clear,clear);
  return promise;
}

interface DepartureState { booking_status:string; cancellation_requested_at:Date|null }
async function departureRefusal(pool:pg.Pool|pg.PoolClient,slug:string,requireOpen=false):Promise<string|null> {
  const d=(await pool.query<DepartureState>('SELECT booking_status,cancellation_requested_at FROM departure WHERE slug=$1',[slug])).rows[0];
  if (!d) return 'DEPARTURE_UNKNOWN';
  if (d.booking_status==='CANCELLED' || d.cancellation_requested_at!==null) return 'DEPARTURE_CANCELLED';
  return requireOpen && d.booking_status!=='OPEN' ? 'DEPARTURE_NOT_OPEN' : null;
}

async function withQuoteLock<T extends OrderRow|ReturnOutcome>(deps:CheckoutDeps,ref:string,slug:string,
  work:(client:pg.PoolClient,o:OrderRow|null,blocked:string|null)=>Promise<T>):Promise<T> {
  const client=await deps.pool.connect();
  try {
    await client.query('BEGIN');
    const open=(await client.query<{open:boolean}>('SELECT fn_sales_open_for_sale() AS open')).rows[0]?.open===true;
    await client.query('SELECT fn_lock_checkout_departure($1)',[slug]);
    const o=await loadOrder(client,ref,true);
    const blocked=!open ? 'SALES_CLOSED' : await departureRefusal(client,slug,true)
      ?? (o && orderBookingCutoff(o) <= (deps.now ?? (()=>new Date()))() ? 'BOOKING_CUTOFF_REACHED' : null);
    const result=await work(client,o,blocked);
    await client.query('kind' in result && result.kind==='REFUSED' ? 'ROLLBACK' : 'COMMIT');
    return result;
  } finally { await client.query('ROLLBACK').catch(()=>undefined); client.release(); }
}

/** Verify browser ownership before sharing an order's resolution work. */
export async function onReturn(deps:CheckoutDeps,q:{rt:string|null;state:string|null;cookieState:(ref:string)=>string|undefined}):Promise<ReturnOutcome> {
  if (!q.rt || !q.state) return {kind:'REFUSED',code:'RETURN_INCOMPLETE'};
  const owned=(await deps.pool.query<OrderRow>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE state_hash=$1`,[sha256(q.state)])).rows[0];
  const cookie=owned ? q.cookieState(owned.order_ref) : undefined;
  if (!owned || !cookie || !sameSecret(cookie,q.state)) return {kind:'REFUSED',code:'STATE_MISMATCH'};
  return singleFlight(deps.pool,`resolve:${owned.id}`,async()=>{
    const token=randomUUID();
    const prepared=await withQuoteLock(deps,owned.order_ref,owned.departure_slug,async(client,current,blocked):Promise<OrderRow|ReturnOutcome>=>{
      if (!current) return {kind:'REFUSED',code:'UNKNOWN_ORDER'};
      if (current.status!=='RESERVED' || current.quote_issued_at!==null) return {kind:'CONFIRM',orderRef:current.order_ref};
      if (!contractSnapshotIntact(current.contract_snapshot,current.contract_snapshot_sha256)) return {kind:'REFUSED',code:'ORDER_CONTRACT_INVALID',orderRef:current.order_ref};
      if (!current.trip_departure_time || !current.trip_return_time || !current.trip_timezone) return {kind:'REFUSED',code:'TRIP_SCHEDULE_MISSING',orderRef:current.order_ref};
      if (await zayavkaOf(client,current.order_ref)!==null) return {kind:'REFUSED',code:'QUOTE_REQUIRES_REBOOK',orderRef:current.order_ref};
      if (blocked) return {kind:'REFUSED',code:blocked,orderRef:current.order_ref};
      if (current.reserved_until<=(deps.now??(()=>new Date()))()) return {kind:'REFUSED',code:'RESERVATION_EXPIRED',orderRef:current.order_ref};
      if (current.resolution_operation_id!==null) return {kind:'REFUSED',code:'RESOLUTION_IN_PROGRESS',orderRef:current.order_ref};
      await client.query('UPDATE orders SET resolution_operation_id=$2,resolution_started_at=$3 WHERE id=$1',[current.id,token,(deps.now??(()=>new Date()))()]);
      return current;
    });
    if ('kind' in prepared) return prepared;
    const o=prepared;
    try {
      const line=orderLine(deal(o));
      // No database connection, transaction or broad departure lock is held over this HTTP call.
      const r=await deps.refref.resolve({handoffToken:q.rt!,merchantOrderRef:o.order_ref,currency:'RUB',lines:[line]});
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

      const outcome=await withQuoteLock(deps,o.order_ref,o.departure_slug,async(client,current,blocked):Promise<ReturnOutcome>=>{
        if (!current || current.status!=='RESERVED' || current.resolution_operation_id!==token) return {kind:'REFUSED',code:'ORDER_NOT_PAYABLE',orderRef:o.order_ref};
        if (blocked) return {kind:'REFUSED',code:blocked,orderRef:o.order_ref};
        if (!current.resolution_started_at || current.resolution_started_at.getTime()+120_000 <= (deps.now??(()=>new Date()))().getTime()) return {kind:'REFUSED',code:'RESOLUTION_LEASE_EXPIRED',orderRef:o.order_ref};
        const issuedAt = (deps.now ?? (() => new Date()))();
        const expiresAt = new Date(Math.min(issuedAt.getTime() + 15 * 60_000, o.reserved_until.getTime(),
          orderBookingCutoff(o).getTime(),
          Date.parse(res.expiresAt)));
        if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= issuedAt) return { kind: 'REFUSED', code: 'QUOTE_EXPIRED', orderRef: o.order_ref };
        await client.query(`UPDATE orders SET referral_resolution_id=$2, terms_version_id=$3, attribution_source=$4,
          resolution_expires_at=$5, discount_kopecks=$6, payable_kopecks=amount_kopecks-$6,
          quote_issued_at=$7, quote_expires_at=$8 WHERE id=$1`,
          [o.id, res.referralResolutionId, res.termsVersionId, res.attributionSource, new Date(res.expiresAt), discount, issuedAt, expiresAt]);
        await client.query(`INSERT INTO order_event(order_id, at, event, detail) VALUES ($1,$2,'RESOLVED',$3)`, [o.id, issuedAt, res.attributionSource.replace(/[^A-Z_]/g,'').slice(0,100) || 'UNKNOWN']);
        if (!(await writeZayavka(client, (await loadOrder(client, o.order_ref))!, issuedAt))) return { kind: 'REFUSED', code: 'ORDER_CONTRACT_INVALID', orderRef: o.order_ref };

        return {kind:'CONFIRM',orderRef:o.order_ref};
      });
      if (outcome.kind==='CONFIRM') deps.log('resolved',{orderRef:o.order_ref,attribution:res.attributionSource,discountKopecks:discount});
      return outcome;
    } finally {
      // Clear only our token. Expiry may already have fenced this read-only callback.
      await deps.pool.query('UPDATE orders SET resolution_operation_id=NULL,resolution_started_at=NULL WHERE id=$1 AND resolution_operation_id=$2',[o.id,token]);
    }
  });
}

/**
 * Write once from the verified order snapshot and quoted price, inside the order lock.
 * A repeated return reuses these exact bytes; neither catalogue edits nor a clock tick reach it.
 */
async function writeZayavka(pool: pg.PoolClient, o: OrderRow, now: Date): Promise<boolean> {
  if (o.status !== 'RESERVED' || o.payable_kopecks === null || !contractSnapshotIntact(o.contract_snapshot, o.contract_snapshot_sha256)) return false;
  const c = o.contract_snapshot;
  const contact = (await pool.query<{ full_name: string; phone: string; email: string }>(
    'SELECT full_name, phone, email FROM order_contact WHERE order_id = $1', [o.id])).rows[0];
  if (contact === undefined) return false;
  const tourists = (await pool.query<{ full_name: string; dob: string; citizenship: string; document_type: Tourist['documentType'];
    document_series: string | null; document_number: string }>(
    `SELECT full_name, to_char(date_of_birth, 'YYYY-MM-DD') AS dob, citizenship, document_type, document_series, document_number
       FROM order_passenger WHERE order_id = $1 ORDER BY position`, [o.id])).rows
    .map((t) => ({ fullName: t.full_name, dateOfBirth: t.dob, citizenship: t.citizenship, documentType: t.document_type,
      documentSeries: t.document_series, documentNumber: t.document_number }));
  const formedAt = new Intl.DateTimeFormat('ru-RU', { timeZone: c.timezone, dateStyle: 'short', timeStyle: 'short' }).format(now);
  const content = renderZayavka({
    orderRef: o.order_ref, formedAt, timezone: c.timezone, offerRef: o.legal_release_ref,
    quoteExpiresAt: o.quote_expires_at!.toISOString(),
    departure: { slug: c.departureSlug, tourSlug: c.tourSlug, tourTitle: c.tourTitle,
      startsOn: c.startsOn, endsOn: c.endsOn, contract: c.contract },
    contact: { fullName: contact.full_name, phone: contact.phone, email: contact.email },
    tourists, amountKopecks: Number(o.amount_kopecks), discountKopecks: Number(o.discount_kopecks),
  });
  await pool.query(`INSERT INTO order_document (order_id, kind, content, sha256, created_at) VALUES ($1, 'ZAYAVKA', $2, $3, $4)
    ON CONFLICT (order_id, kind) DO NOTHING`,
  [o.id, content, sha256Hex(content), now]);
  return true;
}

/** The order's Заявка as stored: what the customer is shown, and what they accept by paying. */
export async function zayavkaOf(pool: pg.Pool | pg.PoolClient, orderRef: string): Promise<{ content: string | null; sha256: string } | null> {
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
export async function pay(deps:CheckoutDeps,orderRef:string,acceptedZayavka:string):Promise<PayOutcome> {
  return singleFlight(deps.pool,`pay:${orderRef}:${acceptedZayavka}`,()=>payOnce(deps,orderRef,acceptedZayavka))
    .catch(e=> { if (e instanceof PaymentPoolBusy) return {kind:'STATUS',code:'PAYMENT_TEMPORARILY_BUSY'}; throw e; });
}

async function payOnce(deps: CheckoutDeps, orderRef: string, acceptedZayavka: string): Promise<PayOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  let o = await loadOrder(deps.pool, orderRef);
  if (o === null) return { kind: 'STATUS', code: 'UNKNOWN_ORDER' };

  // Stops any new payment initiation, including a previously reserved/frozen order. Read-back,
  // fulfillment and cancellation remain available through their independent paths.
  if (!refundWorkflowQualified(deps.catalog)) return { kind: 'STATUS', code: 'REFUND_WORKFLOW_UNQUALIFIED' };

  if (o.status==='RESERVED' && deps.legalAdmission!==undefined) {
    try { await deps.legalAdmission.verify(); }
    catch { return {kind:'STATUS',code:'LEGAL_RELEASE_NOT_ADMITTED'}; }
  }
  const freeze = await deps.pool.connect();
  try {
    await freeze.query('BEGIN');
    const open = (await freeze.query<{ open: boolean }>('SELECT fn_sales_open_for_sale() AS open')).rows[0]?.open;
    await freeze.query('SELECT fn_lock_checkout_departure($1)', [o.departure_slug]);
    o = (await loadOrder(freeze, orderRef, true))!;
    let checkedAt = (deps.now ?? (() => new Date()))();
    if (o.status==='RESERVED') {
      if (o.trip_departure_time===null || o.trip_return_time===null || o.trip_timezone===null) return {kind:'STATUS',code:'TRIP_SCHEDULE_MISSING'};
      if (!contractSnapshotIntact(o.contract_snapshot,o.contract_snapshot_sha256)) return {kind:'STATUS',code:'ORDER_CONTRACT_INVALID'};
    }
    if (o.status === 'RESERVED' || o.status === 'PAYMENT_PENDING') {
      if (!open) return { kind: 'STATUS', code: 'SALES_CLOSED' };
      if (orderBookingCutoff(o)<=checkedAt) return {kind:'STATUS',code:'BOOKING_CUTOFF_REACHED'};
      const blocked=await departureRefusal(freeze,o.departure_slug);
      if (blocked) return {kind:'STATUS',code:blocked};
    }
    if (o.status === 'RESERVED') {
      checkedAt = (deps.now ?? (() => new Date()))();
      if (o.legal_release_content === null || o.legal_release_hash !== `sha256:${sha256(o.legal_release_content)}`
        || o.legal_release_ref.trim() === '') {
        return { kind: 'STATUS', code: 'LEGAL_RELEASE_INVALID' };
      }
      if (o.pd_consent_hash !== `sha256:${sha256(o.pd_consent_content)}` || o.pd_consent_ref.trim() === '') {
        return { kind: 'STATUS', code: 'PD_CONSENT_INVALID' };
      }
      if (o.referral_resolution_id === null) return { kind: 'STATUS', code: 'NOT_RESOLVED' };
      if (o.reserved_until <= checkedAt || o.resolution_expires_at! <= checkedAt) return { kind: 'STATUS', code: 'RESERVATION_EXPIRED' };
      if (o.quote_issued_at === null) return { kind: 'STATUS', code: 'QUOTE_REQUIRES_REBOOK' };
      if (o.quote_expires_at === null || o.quote_expires_at <= checkedAt) return { kind: 'STATUS', code: 'QUOTE_EXPIRED' };
      const zayavka = await zayavkaOf(freeze, orderRef);
      if (zayavka === null || zayavka.content === null || sha256Hex(zayavka.content) !== zayavka.sha256) return { kind: 'STATUS', code: 'NOT_RESOLVED' };
      if (zayavka.sha256 !== acceptedZayavka) return { kind: 'STATUS', code: 'DOCUMENT_CHANGED' };
      const snapshot = buildSnapshot(deal(o), { merchantId: deps.merchant.businessId,
        referralResolutionId: o.referral_resolution_id, termsVersionId: o.terms_version_id, discountKopecks: Number(o.discount_kopecks) },
      { ref: o.legal_release_ref, hash: contractHash(o.legal_release_ref, o.legal_release_hash, zayavka.sha256) });
      const hash = snapshotDigest(snapshot);
      const r = await freeze.query(`UPDATE orders SET status = 'PAYMENT_PENDING', snapshot = $2, snapshot_hash = $3,
        payment_pending_since = $4 WHERE id = $1 AND status = 'RESERVED' AND reserved_until > $4 AND quote_expires_at > $4`, [o.id, snapshot, hash, checkedAt]);
      if (r.rowCount !== 1) return { kind: 'STATUS', code: 'QUOTE_EXPIRED' };
      await freeze.query(`INSERT INTO order_event (order_id, at, event) VALUES ($1, $2, 'FROZEN')`, [o.id, checkedAt]);
      await freeze.query('COMMIT');
      deps.log('frozen', { orderRef, payableKopecks: Number(o.payable_kopecks) });
    }
  } finally {
    await freeze.query('ROLLBACK').catch(() => undefined);
    freeze.release();
  }
  // Read the committed state only after releasing the preparation connection.
  o = (await loadOrder(deps.pool, orderRef))!;
  if (o.status !== 'PAYMENT_PENDING') return { kind: 'STATUS' };
  const attemptId = o.checkout_attempt_id ?? await ensureAttempt(deps, o, now);
  if (attemptId === null) return { kind: 'STATUS' };

  const contact = await deps.pool.query<{ email: string }>('SELECT email FROM order_contact WHERE order_id = $1', [o.id]);
  const email = contact.rows[0]?.email;
  if (email === undefined) { await hold(deps, o, 'PAYMENT_PENDING', 'CONTACT_MISSING', now); return { kind: 'STATUS' }; }
  const s = await underOpenSwitch(deps, o, () => deps.refref.paymentSession(orderRef, attemptId, OBLIGATION_REF,
    { successUrl: `${deps.merchant.origin}/orders/${orderRef}`, receiptContact: { email } }));
  if (typeof s === 'string') return { kind: 'STATUS', code: s };
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
class PaymentPoolBusy extends Error {}
async function initiationClient(deps: CheckoutDeps): Promise<pg.PoolClient> {
  try { return await (deps.initiationPool ?? deps.pool).connect(); }
  catch (e) {
    if (e instanceof Error && /timeout exceeded when trying to connect|connection timeout/i.test(e.message)) throw new PaymentPoolBusy();
    throw e;
  }
}

async function underOpenSwitch<T>(deps: CheckoutDeps, order: OrderRow, start: () => Promise<T>): Promise<T | string> {
  const client = await initiationClient(deps);
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ open: boolean }>('SELECT fn_sales_open_for_sale() AS open');
    if (rows[0]?.open !== true) return 'SALES_CLOSED';
    await client.query('SELECT fn_lock_departure_initiation($1)',[order.departure_slug]);
    const blocked=await departureRefusal(client,order.departure_slug);
    if (blocked) return blocked;
    const locked=(await client.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[`payment:${order.order_ref}`])).rows[0]?.locked;
    if (!locked) return 'PAYMENT_IN_PROGRESS';
    const current=await loadOrder(client,order.order_ref);
    if (current?.status!=='PAYMENT_PENDING') return 'ORDER_NOT_PAYABLE';
    if (orderBookingCutoff(current)<=(deps.now??(()=>new Date()))()) return 'BOOKING_CUTOFF_REACHED';
    if (paymentDeadline(current)<=(deps.now??(()=>new Date()))()) return current.quote_expires_at===null ? 'RESERVATION_EXPIRED' : 'QUOTE_EXPIRED';
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
type PaymentEvidence = Pick<OrderRow,'snapshot'|'snapshot_hash'> & Partial<Pick<OrderRow,'contract_snapshot'|'contract_snapshot_sha256'>>;
export function orderBookingCutoff(o: PaymentEvidence): Date {
  try {
    if (o.snapshot) {
      if (snapshotDigest(o.snapshot)!==o.snapshot_hash) return new Date(0);
      const cutoff=bookingCutoffAt(String((o.snapshot.lines as Record<string,Json>[])[0]!.serviceStartsAt));
      return Number.isFinite(cutoff.getTime()) ? cutoff : new Date(0);
    }
    if (contractSnapshotIntact(o.contract_snapshot ?? null,o.contract_snapshot_sha256 ?? null)) {
      const c=o.contract_snapshot!;
      return bookingCutoff(c.startsOn,c.contract.departure.departureTime,c.timezone);
    }
  } catch { /* Corrupt evidence never authorizes a payment. */ }
  return new Date(0);
}
export function paymentDeadline(o:Pick<OrderRow,'quote_expires_at'|'reserved_until'|'resolution_expires_at'> & PaymentEvidence):Date {
  if (o.quote_expires_at!==null) return new Date(Math.min(o.quote_expires_at.getTime(),orderBookingCutoff(o).getTime()));
  // Compatibility only for an already frozen legacy payment. Never invent quote evidence.
  try {
    if (!o.snapshot || snapshotDigest(o.snapshot)!==o.snapshot_hash) return new Date(0);
    const end=Math.min(o.reserved_until.getTime(),o.resolution_expires_at?.getTime()??0,orderBookingCutoff(o).getTime());
    return new Date(Number.isFinite(end)?end:0);
  } catch { return new Date(0); }
}

interface AttemptAdmission { readonly order: OrderRow | null; readonly blocked: string | null }

/** Same serialization as sessions, but read-back remains available when admission is closed. */
async function lockAttempt(deps: CheckoutDeps, client: pg.PoolClient, ref: string, slug: string, preparing=false): Promise<AttemptAdmission> {
  const open = (await client.query<{ open: boolean }>('SELECT fn_sales_open_for_sale() AS open')).rows[0]?.open === true;
  await client.query('SELECT fn_lock_departure_initiation($1)',[slug]);
  const order=await loadOrder(client,ref,preparing);
  const departure=await departureRefusal(client,slug);
  const blocked=departure ?? (!open ? 'SALES_CLOSED'
    : !refundWorkflowQualified(deps.catalog) ? 'REFUND_WORKFLOW_UNQUALIFIED'
    : order && orderBookingCutoff(order)<=(deps.now??(()=>new Date()))() ? 'BOOKING_CUTOFF_REACHED'
    : !order || paymentDeadline(order)<=(deps.now??(()=>new Date()))() ? (order?.quote_expires_at===null?'RESERVATION_EXPIRED':'QUOTE_EXPIRED') : null);
  return { order, blocked };
}

async function ensureAttempt(deps:CheckoutDeps,previous:OrderRow,now:Date):Promise<string|null> {
  return singleFlight(deps.pool,`attempt:${previous.id}`,()=>ensureAttemptOnce(deps,previous,now));
}

async function ensureAttemptOnce(deps:CheckoutDeps,previous:OrderRow,now:Date):Promise<string|null> {
  // The short preparation transaction proves whether this is a first dispatch. All reads of
  // Refref below run after releasing its connection. A first POST needs no recovery permission.
  const prepared=await (async()=>{
    const client=await deps.pool.connect();
    try {
      await client.query('BEGIN');
      const admission=await lockAttempt(deps,client,previous.order_ref,previous.departure_slug,true);
      const o=admission.order;
      if (!o || o.status!=='PAYMENT_PENDING') return null;
      if (o.checkout_attempt_id!==null) return {o,fresh:false};
      const fresh=o.attempt_creation_state==='NOT_STARTED';
      if (fresh && admission.blocked!==null) {
        if (admission.blocked==='DEPARTURE_CANCELLED' || admission.blocked==='QUOTE_EXPIRED' || admission.blocked==='RESERVATION_EXPIRED' || admission.blocked==='BOOKING_CUTOFF_REACHED') {
          const changed=await transitionLocked(client,o,'PAYMENT_PENDING',{status:'CANCELLED',closed_at:now},'CANCELLED','ATTEMPT_NOT_STARTED',now);
          await client.query('COMMIT');
          if (changed) deps.log('order_cancelled',{orderRef:o.order_ref,reason:'ATTEMPT_NOT_STARTED'});
        }
        return null;
      }
      await client.query('COMMIT');
      return {o,fresh};
    } finally { await client.query('ROLLBACK').catch(()=>undefined); client.release(); }
  })();
  if (!prepared) return null;
  const {o,fresh}=prepared;
  if (o.checkout_attempt_id!==null) return o.checkout_attempt_id;
  if (!fresh) {
    const recovered=await recoverAttempt(deps,o,now);
    if (recovered!==undefined) return recovered;
  }
  const result=await (async()=>{
    const client=await initiationClient(deps);
    try {
      // A fresh order stays NOT_STARTED if pool acquisition fails. Persist its marker only
      // after acquiring its bounded connection, then release every row lock before HTTP.
      await client.query('BEGIN');
      const preparation=await lockAttempt(deps,client,o.order_ref,o.departure_slug,true);
      const ready=preparation.order;
      if (!ready || ready.status!=='PAYMENT_PENDING') return {kind:'BLOCKED'} as const;
      if (ready.checkout_attempt_id!==null) return {kind:'EXISTING',id:ready.checkout_attempt_id} as const;
      // Another worker may have armed while we waited. Recover outside this connection.
      if (fresh && ready.attempt_creation_state!=='NOT_STARTED') return {kind:'RECHECK',order:ready} as const;
      if (preparation.blocked!==null) return {kind:'BLOCKED'} as const;
      if (ready.attempt_creation_state!=='STARTED') {
        await client.query("UPDATE orders SET attempt_creation_state='STARTED' WHERE id=$1",[ready.id]);
        await client.query("INSERT INTO order_event(order_id,at,event) VALUES ($1,$2,'ATTEMPT_DISPATCH_ARMED')",[ready.id,now]);
      }
      await client.query('COMMIT');
      await client.query('BEGIN');
      const admission=await lockAttempt(deps,client,o.order_ref,o.departure_slug);
      const current=admission.order;
      if (!current || current.status!=='PAYMENT_PENDING') return {kind:'BLOCKED'} as const;
      if (current.checkout_attempt_id!==null) return {kind:'EXISTING',id:current.checkout_attempt_id} as const;
      if (admission.blocked!==null) return {kind:'BLOCKED'} as const;
      const locked=(await client.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[`attempt:${o.order_ref}`])).rows[0]?.locked;
      if (!locked) return {kind:'BUSY'} as const;
      // Recheck after the last awaited lock: a wait must not cross the wall-clock deadline.
      if (paymentDeadline(current)<=(deps.now??(()=>new Date()))()) return {kind:'BLOCKED'} as const;
      // Only shared initiation barriers and this order's advisory key survive the bounded POST.
      const reply=await deps.refref.createAttempt(o.order_ref,
        {referralResolutionId:o.referral_resolution_id!,snapshot:o.snapshot,snapshotHash:o.snapshot_hash!},`mk-attempt:${o.order_ref}`);
      return {kind:'REPLY',reply} as const;
    } finally { await client.query('ROLLBACK').catch(()=>undefined); client.release(); }
  })();
  if (result.kind==='RECHECK') return ensureAttemptOnce(deps,result.order,now);
  if (result.kind==='EXISTING') return result.id;
  if (result.kind==='BUSY') return null;
  if (result.kind==='BLOCKED') { await holdUnconfirmed(deps,o,now); return null; }
  const r=result.reply;
  if (r.kind==='UNKNOWN') {
    const recovered=await recoverAttempt(deps,o,now);
    if (recovered!==undefined) return recovered;
    await holdUnconfirmed(deps,o,now); return null;
  }
  if (r.status>=300) {
    const code=errorCode(r.body);
    if (ATTEMPT_NOT_CREATED.has(code)) await cancel(deps,o,'PAYMENT_PENDING',`ATTEMPT_REFUSED:${code}`,now);
    else await hold(deps,o,'PAYMENT_PENDING',`ATTEMPT_REFUSED:${code}`,now);
    return null;
  }
  if (r.body.snapshotHash!==o.snapshot_hash) { await hold(deps,o,'PAYMENT_PENDING','SNAPSHOT_DIVERGED',now); return null; }
  return persistAttempt(deps.pool,o,r.body.checkoutAttemptId,now,'ATTEMPT_CREATED');
}

async function holdUnconfirmed(deps:CheckoutDeps,o:OrderRow,now:Date):Promise<void> {
  if (o.payment_pending_since!<=new Date(now.getTime()-ATTEMPT_UNCONFIRMED_AFTER_MINUTES*60_000)) {
    await hold(deps,o,'PAYMENT_PENDING','ATTEMPT_UNCONFIRMED',now);
  }
}

/** undefined means not visible yet, never proof that an uncertain POST cannot still commit. */
async function recoverAttempt(deps:CheckoutDeps,o:OrderRow,now:Date):Promise<string|null|undefined> {
  const read=await deps.refref.getMerchantOrder(o.order_ref);
  if (read.kind==='UNKNOWN') { await holdUnconfirmed(deps,o,now); return null; }
  if (read.status===404) return undefined;
  if (read.status!==200) { await hold(deps,o,'PAYMENT_PENDING',`ATTEMPT_RECOVERY_REFUSED:${errorCode(read.body)}`,now); return null; }
  const matches=read.body.checkoutAttempts.filter(a=>a.snapshotHash===o.snapshot_hash && a.referralResolutionId===o.referral_resolution_id);
  if (read.body.merchantOrderId!==o.order_ref || (read.body.checkoutAttempts.length>0 && matches.length!==1)) {
    await hold(deps,o,'PAYMENT_PENDING','ATTEMPT_RECOVERY_MISMATCH',now); return null;
  }
  return matches.length===1 ? persistAttempt(deps.pool,o,matches[0]!.id,now,'ATTEMPT_RECOVERED') : undefined;
}

async function persistAttempt(pool: pg.Pool | pg.PoolClient, o: OrderRow, attemptId: string, now: Date,
  event: 'ATTEMPT_CREATED' | 'ATTEMPT_RECOVERED'): Promise<string | null> {
  const set = await pool.query(`UPDATE orders SET checkout_attempt_id = $2 WHERE id = $1 AND checkout_attempt_id IS NULL`,
    [o.id, attemptId]);
  if (set.rowCount === 1) {
    await pool.query('INSERT INTO order_event (order_id, at, event) VALUES ($1, $2, $3)', [o.id, now, event]);
  }
  const { rows } = await pool.query<{ checkout_attempt_id: string | null }>('SELECT checkout_attempt_id FROM orders WHERE id = $1', [o.id]);
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
export async function reconcileOrder(deps:CheckoutDeps,orderRef:string):Promise<void> {
  return singleFlight(deps.pool,`reconcile:${orderRef}`,()=>reconcileOrderOnce(deps,orderRef))
    .catch(e=> { if (!(e instanceof PaymentPoolBusy)) throw e; });
}

async function reconcileOrderOnce(deps: CheckoutDeps, orderRef: string): Promise<void> {
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
    const requested = await departureRefusal(deps.pool,o.departure_slug)==='DEPARTURE_CANCELLED';
    const abandoned = requested || o.payment_pending_since! <= new Date(now.getTime() - ABANDON_AFTER_MINUTES * 60_000);
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
    } else if (v.kind === 'ABANDONED' || (requested && v.kind === 'WAIT')) {
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

/** Refref's 200 must confirm this exact attempt as DELIVERED, not merely accept the HTTP call. */
function deliveredAcknowledgment(body: unknown, attemptId: string): boolean {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    && 'checkoutAttemptId' in body && body.checkoutAttemptId === attemptId
    && 'status' in body && body.status === 'DELIVERED';
}

/** The booking is confirmed: tell Refref (once, idempotently), then fulfil and enqueue locally. */
async function fulfil(deps: CheckoutDeps, o: OrderRow, attemptId: string, now: Date): Promise<void> {
  const ack = await deps.refref.acknowledgeFulfillment(o.order_ref, attemptId, `mk-fulfil:${o.order_ref}`);
  if (ack.kind === 'ANSWERED' && ack.status === 200 && deliveredAcknowledgment(ack.body, attemptId)) {
    if (await markFulfilledAndQueueEmail(deps, o, now)) deps.log('fulfilled', { orderRef: o.order_ref });
  } else if (ack.kind === 'ANSWERED') {
    deps.log('fulfilment_ack_unusable', { orderRef: o.order_ref, status: ack.status });
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
