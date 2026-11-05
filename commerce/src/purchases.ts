// Purchases (TOUR-76 / N2): a stable economic purchase with append-only accepted revisions and a
// lifecycle profile the database assigns once, when the purchase is created (migration 0017).
//
//   * a new purchase is NATIVE_NO_REFERRAL with payment owner MIKLUHA_NATIVE: no attribution, no
//     BOUND, no Refref resolution, checkout attempt or payment, ever (fn_purchase_order_guard);
//   * no request field, promo/query value, worker or migration retry chooses or changes the profile;
//   * an order outside any purchase keeps its own history and owner; its profile provenance is
//     UNRESOLVED, never read as NATIVE_NO_REFERRAL.
//
// Since migration 0021 (Track A / TOUR-76 A2) the native checkout entry is reserveNativePurchase:
// the buyer chooses only how many seats of three ticket types (0–13, 14–17, 18+) and gives their own
// contact; no tourist data, no "buyer = tourist №1", no adults-only rule and no limit of six. Tourists
// are personalized later through invitations (TOUR-99/100). The database prices every seat from one
// frozen pricing basis, applies the minors rules and puts the purchase in a purchase group.
//
// Opening a native purchase is not wired to a public route: switching new sales to it is the
// separately authorized cutover, after native payment operations (TOUR-77) exist.

import { createHash } from 'node:crypto';

import type pg from 'pg';

import { bookingCutoff } from './booking-window.js';
import { buildContractSnapshot, contractSnapshotHash } from './contract-snapshot.js';
import {
  MAX_SEATS_PER_REQUEST, newOrderRef, normalizeEmail, normalizePersonName, normalizePhone, reserveOrder,
  type BookingRefusal, type BookingRequest, type NativeBookingResult, type OrderDeps,
} from './orders.js';
import type { NotBookable } from './catalog.js';
import { bookablePublished } from './public-content.js';

export const NATIVE_PROFILE = 'NATIVE_NO_REFERRAL';
export const NATIVE_PAYMENT_OWNER = 'MIKLUHA_NATIVE';
/** OWNER 2A (04.11.2026): a provisional hold lasts at most five minutes until the bank registration. */
export const SEAT_HOLD_MINUTES = 5;

/**
 * The 0017 UNIFORM model (buyer = tourist №1, passports in the order, adults only), kept only for
 * the purchases it already describes and their tests; no route reaches it. Removal: contract A2b-9.
 */
export function reserveUniformNativePurchase(deps: OrderDeps, req: BookingRequest): Promise<NativeBookingResult> {
  return reserveOrder(deps, req, true);
}

export interface NativePurchaseRequest {
  readonly departureSlug: string;
  /** The buyer's own data for the contract, receipt and contact. Never a tourist's. */
  readonly buyer: { readonly fullName: string; readonly phone: string; readonly email: string };
  readonly tickets: { readonly adults: number; readonly teens: number; readonly children: number };
  /** «Возраст участников соответствует ограничениям выезда» (v1.8.2 §2.1 п.2). */
  readonly ageTermsConfirmed: boolean;
  readonly termsRef: string;
  readonly termsHash: string;
  readonly pdConsentConfirmed: boolean;
  readonly pdConsentRef: string;
  readonly pdConsentHash: string;
  /**
   * A manager's group link (TOUR-90): the opaque token and the checkout attempt's idempotency key.
   * The tickets must be exactly the ones the manager put on the link.
   */
  readonly groupLink?: { readonly token: string; readonly idempotencyKey: string };
}

export type NativePurchaseRefusal = Exclude<BookingRefusal, 'ADULTS_ONLY_NOT_CONFIRMED' | 'PASSENGER_NAME_INVALID'
  | 'DATE_OF_BIRTH_INVALID' | 'PASSENGER_NOT_ADULT' | 'CITIZENSHIP_INVALID' | 'DOCUMENT_INVALID' | 'REPLACEMENT_NOT_AVAILABLE'>
  | 'AGE_TERMS_NOT_CONFIRMED' | 'BUYER_NAME_INVALID' | 'BOOKING_CUTOFF_REACHED' | 'MINORS_NOT_ALLOWED' | 'MINOR_SALES_PAUSED'
  | 'TICKET_TYPE_NOT_ALLOWED' | 'MINORS_WITHOUT_ADULT' | 'GROUP_LINK_INVALID' | 'GROUP_LINK_DEPARTURE_MISMATCH'
  | 'GROUP_LINK_TICKETS_MISMATCH' | 'IDEMPOTENCY_CONFLICT';

export type NativePurchaseResult =
  | { readonly ok: true; readonly replayed: boolean; readonly orderRef: string; readonly purchaseRef: string;
      readonly purchaseGroupRef: string; readonly amountKopecks: number; readonly reservedUntil: Date }
  | { readonly ok: false; readonly refusal: NativePurchaseRefusal };

/** Refusals the database decides (migration 0021), mapped from their exception codes. */
const DATABASE_REFUSALS = ['MINORS_NOT_ALLOWED', 'MINOR_SALES_PAUSED', 'TICKET_TYPE_NOT_ALLOWED', 'MINORS_WITHOUT_ADULT',
  'GROUP_LINK_INVALID', 'GROUP_LINK_DEPARTURE_MISMATCH', 'GROUP_LINK_TICKETS_MISMATCH'] as const satisfies readonly NativePurchaseRefusal[];

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const count = (n: unknown) => (Number.isSafeInteger(n) && (n as number) >= 0 ? (n as number) : null);

/**
 * Reserve priced seats and open a native purchase in one transaction, before any payment
 * opportunity. A group link joins the manager's group; a repeat with the same idempotency key
 * returns the purchase it created instead of a second one (v1.9.0 §2 п.1).
 */
export async function reserveNativePurchase(deps: OrderDeps, req: NativePurchaseRequest): Promise<NativePurchaseResult> {
  const refuse = (refusal: NativePurchaseRefusal): NativePurchaseResult => {
    deps.log('booking_refused', { departure: req.departureSlug, refusal });
    return { ok: false, refusal };
  };
  if (req.termsRef !== deps.catalog.terms.ref || req.termsHash !== deps.catalog.terms.hash) return refuse('TERMS_NOT_CURRENT');
  if (req.pdConsentRef !== deps.catalog.pdConsent.ref || req.pdConsentHash !== deps.catalog.pdConsent.hash) return refuse('PD_CONSENT_NOT_CURRENT');
  if (req.pdConsentConfirmed !== true) return refuse('PD_CONSENT_NOT_CONFIRMED');
  if (req.ageTermsConfirmed !== true) return refuse('AGE_TERMS_NOT_CONFIRMED');
  const adults = count(req.tickets?.adults), teens = count(req.tickets?.teens), children = count(req.tickets?.children);
  if (adults === null || teens === null || children === null) return refuse('SEATS_INVALID');
  const seats = adults + teens + children;
  if (seats < 1 || seats > MAX_SEATS_PER_REQUEST) return refuse('SEATS_INVALID');
  const buyerName = normalizePersonName(req.buyer.fullName);
  if (buyerName === null) return refuse('BUYER_NAME_INVALID');
  const phone = normalizePhone(req.buyer.phone);
  if (phone === null) return refuse('CONTACT_PHONE_INVALID');
  const email = normalizeEmail(req.buyer.email);
  if (email === null) return refuse('CONTACT_EMAIL_INVALID');
  let link: { tokenSha256: string; keySha256: string; requestSha256: string } | null = null;
  if (req.groupLink !== undefined) {
    const { token, idempotencyKey } = req.groupLink;
    if (typeof token !== 'string' || token.length < 16 || token.length > 200
        || typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 200) return refuse('GROUP_LINK_INVALID');
    // The accepted request, without personal data: a repeat of the key with another request is a conflict.
    const requestSha256 = sha256(JSON.stringify([req.departureSlug, adults, teens, children, req.termsHash, req.pdConsentHash]));
    link = { tokenSha256: sha256(token), keySha256: sha256(idempotencyKey), requestSha256 };
  }
  if (deps.legalAdmission !== undefined) {
    try { await deps.legalAdmission.verify(); } catch { return refuse('LEGAL_RELEASE_NOT_ADMITTED'); }
  }

  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    // A repeat of an attempt that already created its purchase only reads that result: it creates no
    // seats, so it is answered even after sales closed (v1.9.0 §2 п.1, lost response).
    if (link !== null) {
      const replay = (await client.query<{ purchase_ref: string; document_order_ref: string; same_request: boolean;
        amount_kopecks: string; reserved_until: Date; purchase_group_ref: string }>(
        `SELECT r.purchase_ref, r.document_order_ref, r.same_request, o.amount_kopecks, o.reserved_until, g.purchase_group_ref
           FROM fn_group_link_replay($1, $2, $3) r JOIN orders o ON o.order_ref = r.document_order_ref
           JOIN purchase p ON p.purchase_ref = r.purchase_ref JOIN purchase_group_member m ON m.purchase_id = p.id
           JOIN purchase_group g ON g.id = m.group_id`, [link.tokenSha256, link.keySha256, link.requestSha256])).rows[0];
      if (replay !== undefined) {
        if (!replay.same_request) return refuse('IDEMPOTENCY_CONFLICT');
        await client.query('COMMIT');
        return { ok: true, replayed: true, orderRef: replay.document_order_ref, purchaseRef: replay.purchase_ref,
          purchaseGroupRef: replay.purchase_group_ref, amountKopecks: Number(replay.amount_kopecks), reservedUntil: replay.reserved_until };
      }
    }
    if ((await client.query<{ open: boolean }>('SELECT fn_sales_open_for_sale() AS open')).rows[0]?.open !== true) return refuse('SALES_CLOSED');
    const departureId = (await client.query<{ id: string | null }>('SELECT fn_lock_checkout_departure($1) AS id', [req.departureSlug])).rows[0]!.id;
    let now = (deps.now ?? (() => new Date()))();
    const departure = await bookablePublished(client, deps.catalog, req.departureSlug, now, deps.allowDemo);
    if (typeof departure === 'string') return refuse(departure);
    const taken = await client.query<{ seats: string }>('SELECT fn_departure_taken_seats($1, $2) AS seats', [departure.slug, now]);
    if (Number(taken.rows[0]!.seats) + seats > departure.capacity) return refuse('NOT_ENOUGH_SEATS');
    now = (deps.now ?? (() => new Date()))();
    const cutoff = bookingCutoff(departure.startsOn, departure.contract.departure.departureTime, departure.timezone);
    if (cutoff <= now) return refuse('BOOKING_CUTOFF_REACHED');
    const childPrice = (await client.query<{ child_price_kopecks: string | null }>(
      'SELECT child_price_kopecks FROM departure WHERE id = $1', [departureId])).rows[0]?.child_price_kopecks;
    const amount = (adults + teens) * departure.priceKopecks + children * (childPrice == null ? departure.priceKopecks : Number(childPrice));
    const reservedUntil = new Date(Math.min(now.getTime() + SEAT_HOLD_MINUTES * 60_000, cutoff.getTime()));
    const orderRef = newOrderRef();
    const contract = buildContractSnapshot(departure, departure.timezone);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO orders (order_ref, departure_slug, trip_starts_on, trip_ends_on, seats, unit_price_kopecks, amount_kopecks, status,
                           reserved_until, legal_release_ref, legal_release_hash, legal_release_content, pd_consent_ref, pd_consent_hash,
                           pd_consent_content, pd_consent_accepted_at, adults_only_confirmed, age_terms_confirmed, seat_model, created_at,
                           trip_departure_time, trip_return_time, trip_timezone, contract_snapshot, contract_snapshot_sha256, departure_id,
                           accepted_departure_version, attempt_creation_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'RESERVED', $8, $9, $10, $11, $12, $13, $14, $15, false, true, 'PRICED_SLOTS', $15,
               $16, $17, $18, $19, $20, $21, $22, 'NOT_STARTED') RETURNING id`,
      [orderRef, departure.slug, departure.startsOn, departure.endsOn, seats, departure.priceKopecks, amount, reservedUntil,
        req.termsRef, req.termsHash, deps.catalog.terms.text, deps.catalog.pdConsent.ref, deps.catalog.pdConsent.hash,
        deps.catalog.pdConsent.text, now, departure.contract.departure.departureTime, departure.contract.departure.returnTime,
        departure.timezone, contract, contractSnapshotHash(contract), departureId, departure.publishedVersion]);
    const id = inserted.rows[0]!.id;
    await client.query('INSERT INTO order_contact (order_id, full_name, phone, email) VALUES ($1, $2, $3, $4)', [id, buyerName, phone, email]);
    await client.query(`INSERT INTO order_event (order_id, at, event, detail) VALUES ($1, $2, 'RESERVED', $3)`, [id, now, `seats:${seats}`]);
    let opened: { purchase_ref: string; purchase_group_ref: string };
    try {
      opened = (await client.query<{ purchase_ref: string; purchase_group_ref: string }>(
        'SELECT purchase_ref, purchase_group_ref FROM fn_open_slotted_purchase($1, $2, $3, $4, $5, $6, $7)',
        [id, adults, teens, children, link?.tokenSha256 ?? null, link?.keySha256 ?? null, link?.requestSha256 ?? null])).rows[0]!;
    } catch (e) {
      const code = DATABASE_REFUSALS.find((c) => (e as Error).message === c);
      if (code === undefined) throw e;
      return refuse(code); // the whole reservation rolls back
    }
    await client.query('COMMIT');
    deps.log('booking_reserved', { orderRef, departure: departure.slug, seats, amountKopecks: amount,
      purchaseRef: opened.purchase_ref, purchaseGroupRef: opened.purchase_group_ref });
    return { ok: true, replayed: false, orderRef, purchaseRef: opened.purchase_ref, purchaseGroupRef: opened.purchase_group_ref,
      amountKopecks: amount, reservedUntil };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

export type PurchaseProfile =
  | { readonly provenance: 'PURCHASE'; readonly purchaseRef: string; readonly revision: number;
      readonly lifecycleProfile: string; readonly paymentOwner: string }
  | { readonly provenance: 'UNRESOLVED' };

/** The order's profile as recorded; null for an unknown order. */
export async function purchaseProfileOf(pool: pg.Pool | pg.PoolClient, orderRef: string): Promise<PurchaseProfile | null> {
  const { rows } = await pool.query<{ provenance: 'PURCHASE' | 'UNRESOLVED'; purchase_ref: string | null; revision: number | null;
    lifecycle_profile: string | null; payment_owner: string | null }>(
    'SELECT provenance, purchase_ref, revision, lifecycle_profile, payment_owner FROM order_purchase_profile WHERE order_ref = $1', [orderRef]);
  const r = rows[0];
  if (r === undefined) return null;
  if (r.provenance === 'UNRESOLVED') return { provenance: 'UNRESOLVED' };
  return { provenance: 'PURCHASE', purchaseRef: r.purchase_ref!, revision: r.revision!,
    lifecycleProfile: r.lifecycle_profile!, paymentOwner: r.payment_owner! };
}

/** Whether the order documents a purchase revision: Refref checkout must never touch it. */
export async function isPurchaseOrder(pool: pg.Pool | pg.PoolClient, orderId: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM purchase_revision WHERE document_order_id = $1', [orderId]);
  return rows.length > 0;
}

export interface CurrentPurchase {
  readonly purchaseRef: string; readonly lifecycleProfile: string; readonly paymentOwner: string;
  readonly revision: number; readonly basis: string; readonly revisionHash: string;
  readonly documentOrderRef: string; readonly documentOrderStatus: string; readonly departureSlug: string;
  readonly seats: number; readonly totalKopecks: number; readonly acceptedAt: Date; readonly effectiveAt: Date;
}

/** The current projection of one purchase, at its current revision. */
export async function currentPurchase(pool: pg.Pool | pg.PoolClient, purchaseRef: string): Promise<CurrentPurchase | null> {
  const { rows } = await pool.query<{ purchase_ref: string; lifecycle_profile: string; payment_owner: string; revision: number;
    basis: string; revision_hash: string; document_order_ref: string; document_order_status: string; departure_slug: string;
    seats: number; total_kopecks: string; accepted_at: Date; effective_at: Date }>(
    `SELECT purchase_ref, lifecycle_profile, payment_owner, revision, basis, revision_hash, document_order_ref,
       document_order_status, departure_slug, seats, total_kopecks, accepted_at, effective_at
       FROM purchase_current WHERE purchase_ref = $1`, [purchaseRef]);
  const r = rows[0];
  return r === undefined ? null : {
    purchaseRef: r.purchase_ref, lifecycleProfile: r.lifecycle_profile, paymentOwner: r.payment_owner, revision: r.revision,
    basis: r.basis, revisionHash: r.revision_hash, documentOrderRef: r.document_order_ref,
    documentOrderStatus: r.document_order_status, departureSlug: r.departure_slug, seats: r.seats,
    totalKopecks: Number(r.total_kopecks), acceptedAt: r.accepted_at, effectiveAt: r.effective_at };
}

export type RetryRefusal = 'SALES_CLOSED' | 'BOOKING_CUTOFF_REACHED' | 'NOT_ENOUGH_SEATS' | 'MINORS_NOT_ALLOWED' | 'MINOR_SALES_PAUSED'
  | 'TICKET_TYPE_NOT_ALLOWED' | 'MINORS_WITHOUT_ADULT' | 'REHOLD_NOT_ALLOWED' | 'PURCHASE_CLOSED' | NotBookable;
const RETRY_REFUSALS = ['NOT_ENOUGH_SEATS', 'MINORS_NOT_ALLOWED', 'MINOR_SALES_PAUSED', 'TICKET_TYPE_NOT_ALLOWED',
  'MINORS_WITHOUT_ADULT', 'REHOLD_NOT_ALLOWED', 'PURCHASE_CLOSED'] as const satisfies readonly RetryRefusal[];

/**
 * A new payment cycle of the same purchase after the bank proved the previous attempt unpaid, or the
 * hold lapsed before any attempt (v1.9.0 §2 п.1): a new five-minute hold of the same seats at their
 * frozen prices, under the general rules (sales switch, T−24, quota, minors). No new purchase, no new
 * group link. The caller has verified that the requester owns the purchase.
 */
export async function retryNativePurchasePayment(deps: OrderDeps, purchaseRef: string):
  Promise<{ readonly ok: true; readonly holdRef: string; readonly reservedUntil: Date } | { readonly ok: false; readonly refusal: RetryRefusal }> {
  const refuse = (refusal: RetryRefusal) => {
    deps.log('payment_retry_refused', { purchaseRef, refusal });
    return { ok: false as const, refusal };
  };
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    if ((await client.query<{ open: boolean }>('SELECT fn_sales_open_for_sale() AS open')).rows[0]?.open !== true) return refuse('SALES_CLOSED');
    const slug = (await client.query<{ slug: string }>(
      'SELECT d.slug FROM purchase_current c JOIN departure d ON d.id = c.departure_id WHERE c.purchase_ref = $1', [purchaseRef])).rows[0]?.slug;
    if (slug === undefined) return refuse('REHOLD_NOT_ALLOWED');
    await client.query('SELECT fn_lock_checkout_departure($1)', [slug]);
    const now = (deps.now ?? (() => new Date()))();
    const departure = await bookablePublished(client, deps.catalog, slug, now, deps.allowDemo);
    if (typeof departure === 'string') return refuse(departure);
    const cutoff = bookingCutoff(departure.startsOn, departure.contract.departure.departureTime, departure.timezone);
    if (cutoff <= now) return refuse('BOOKING_CUTOFF_REACHED');
    const reservedUntil = new Date(Math.min(now.getTime() + SEAT_HOLD_MINUTES * 60_000, cutoff.getTime()));
    let holdRef: string;
    try {
      holdRef = (await client.query<{ ref: string }>('SELECT fn_purchase_rehold($1, $2) AS ref', [purchaseRef, reservedUntil])).rows[0]!.ref;
    } catch (e) {
      const code = RETRY_REFUSALS.find((c) => (e as Error).message === c);
      if (code === undefined) throw e;
      return refuse(code);
    }
    await client.query('COMMIT');
    deps.log('payment_retry_held', { purchaseRef, holdRef });
    return { ok: true, holdRef, reservedUntil };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}
