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
import { tokenSha256 } from './checkout-session.js';
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
  /**
   * The browser checkout session (its `__Host-` cookie token, migration 0023): the purchase is bound to
   * it, and only a bound session may resume or pay it later (A2b-12, G-RESUME-02).
   */
  readonly session: { readonly token: string };
  /**
   * The server-issued checkout intent of this attempt (A2b-11): required for an ordinary purchase. A
   * repeat with the same key returns the purchase it created; another request is IDEMPOTENCY_CONFLICT.
   */
  readonly checkoutIntent?: { readonly key: string };
}

export type NativePurchaseRefusal = Exclude<BookingRefusal, 'ADULTS_ONLY_NOT_CONFIRMED' | 'PASSENGER_NAME_INVALID'
  | 'DATE_OF_BIRTH_INVALID' | 'PASSENGER_NOT_ADULT' | 'CITIZENSHIP_INVALID' | 'DOCUMENT_INVALID' | 'REPLACEMENT_NOT_AVAILABLE'>
  | 'AGE_TERMS_NOT_CONFIRMED' | 'BUYER_NAME_INVALID' | 'BOOKING_CUTOFF_REACHED' | 'MINORS_NOT_ALLOWED' | 'MINOR_SALES_PAUSED'
  | 'TICKET_TYPE_NOT_ALLOWED' | 'MINORS_WITHOUT_ADULT' | 'GROUP_LINK_INVALID' | 'GROUP_LINK_DEPARTURE_MISMATCH'
  | 'GROUP_LINK_TICKETS_MISMATCH' | 'IDEMPOTENCY_CONFLICT' | 'CHECKOUT_SESSION_INVALID' | 'CHECKOUT_INTENT_INVALID'
  | 'CHECKOUT_INTENT_REQUIRED';

export type NativePurchaseResult =
  | { readonly ok: true; readonly replayed: boolean; readonly orderRef: string; readonly purchaseRef: string;
      readonly purchaseGroupRef: string; readonly amountKopecks: number; readonly reservedUntil: Date }
  | { readonly ok: false; readonly refusal: NativePurchaseRefusal };

/** Refusals the database decides (migration 0021), mapped from their exception codes. */
const DATABASE_REFUSALS = ['MINORS_NOT_ALLOWED', 'MINOR_SALES_PAUSED', 'TICKET_TYPE_NOT_ALLOWED', 'MINORS_WITHOUT_ADULT',
  'GROUP_LINK_INVALID', 'GROUP_LINK_DEPARTURE_MISMATCH', 'GROUP_LINK_TICKETS_MISMATCH', 'SALES_CLOSED', 'NOT_ENOUGH_SEATS',
  'BOOKING_CUTOFF_REACHED', 'DEPARTURE_NOT_OPEN', 'DEPARTURE_NOT_LISTED', 'CHECKOUT_SESSION_INVALID',
  'CHECKOUT_INTENT_INVALID'] as const satisfies readonly NativePurchaseRefusal[];

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const count = (n: unknown) => (Number.isSafeInteger(n) && (n as number) >= 0 ? (n as number) : null);

/**
 * Reserve priced seats and open a native purchase in one transaction, before any payment
 * opportunity. An ordinary purchase consumes its checkout intent; a group link joins the manager's
 * group. A repeat with the same intent or link key returns the purchase it created instead of a
 * second one (v1.9.0 §2 п.1, v1.9.1 §9 п.7). The purchase is bound to the browser session.
 */
export async function reserveNativePurchase(deps: OrderDeps, req: NativePurchaseRequest): Promise<NativePurchaseResult> {
  const refuse = (refusal: NativePurchaseRefusal): NativePurchaseResult => {
    deps.log('booking_refused', { departure: req.departureSlug, refusal });
    return { ok: false, refusal };
  };
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
  if (typeof req.session?.token !== 'string' || req.session.token.length < 32 || req.session.token.length > 200) {
    return refuse('CHECKOUT_SESSION_INVALID');
  }
  const sessionSha256 = tokenSha256(req.session.token);
  // The accepted request, without personal data: a repeat of the key with another request is a conflict.
  const requestSha256 = sha256(JSON.stringify([req.departureSlug, adults, teens, children, req.termsHash, req.pdConsentHash]));
  let link: { tokenSha256: string; keySha256: string; requestSha256: string } | null = null;
  let intentKeySha256: string | null = null;
  if (req.groupLink !== undefined) {
    const { token, idempotencyKey } = req.groupLink;
    if (typeof token !== 'string' || token.length < 16 || token.length > 200
        || typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 200) return refuse('GROUP_LINK_INVALID');
    link = { tokenSha256: sha256(token), keySha256: sha256(idempotencyKey), requestSha256 };
  } else {
    // A2b-11: an ordinary checkout is idempotent by its server-issued intent, not by a cookie.
    const key = req.checkoutIntent?.key;
    if (key === undefined) return refuse('CHECKOUT_INTENT_REQUIRED');
    if (typeof key !== 'string' || key.length < 32 || key.length > 200) return refuse('CHECKOUT_INTENT_INVALID');
    intentKeySha256 = tokenSha256(key);
  }
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    // A repeat of an attempt that already created its purchase only reads that result: it creates no
    // seats, so it is answered even after sales closed (v1.9.0 §2 п.1, lost response). It is looked up
    // twice: now, and again after the departure lock, under which a concurrent identical request (a
    // double click) creates the purchase; the second then answers with it instead of a refusal.
    // The answer to a repeat of an attempt that created `purchaseRef` (same request and same buyer).
    const replayOf = async (purchaseRef: string, sameRequest: boolean): Promise<NativePurchaseResult> => {
      const replay = (await client.query<{ purchase_ref: string; document_order_ref: string;
        amount_kopecks: string; reserved_until: Date; purchase_group_ref: string; same_buyer: boolean }>(
        // The same buyer: compared with the order's contact inside the database. After decision 8B erased
        // that contact at closure, the repeat is recognised by the browser session bound to the purchase
        // (the intent is that session's; a link replay must come from it too), with the same request.
        `SELECT p.purchase_ref, o.order_ref AS document_order_ref, o.amount_kopecks, h.expires_at AS reserved_until, g.purchase_group_ref,
                CASE WHEN c.order_id IS NOT NULL
                       THEN c.full_name IS NOT DISTINCT FROM $2 AND c.phone IS NOT DISTINCT FROM $3 AND c.email IS NOT DISTINCT FROM $4
                     ELSE o.pd_erased_at IS NOT NULL AND coalesce(fn_purchase_session_owns(p.purchase_ref, $5), false) END AS same_buyer
           FROM purchase p JOIN orders o ON o.id = p.origin_order_id
           LEFT JOIN order_contact c ON c.order_id = o.id
           JOIN purchase_group_member m ON m.purchase_id = p.id
           JOIN purchase_group g ON g.id = m.group_id JOIN seat_hold h ON h.purchase_id = p.id AND h.cycle = 1
          WHERE p.purchase_ref = $1`, [purchaseRef, buyerName, phone, email, sessionSha256])).rows[0]!;
      // The same attempt is the same request by the same buyer: the buyer is compared with the order's
      // own contact inside the trusted database, so no personal data enters the fingerprint.
      if (!sameRequest || !replay.same_buyer) return refuse('IDEMPOTENCY_CONFLICT');
      await client.query('COMMIT');
      return { ok: true, replayed: true, orderRef: replay.document_order_ref, purchaseRef: replay.purchase_ref,
        purchaseGroupRef: replay.purchase_group_ref, amountKopecks: Number(replay.amount_kopecks), reservedUntil: replay.reserved_until };
    };
    const replayed = async (): Promise<NativePurchaseResult | null> => {
      if (link === null) return null;
      const r = (await client.query<{ purchase_ref: string; same_request: boolean }>(
        'SELECT purchase_ref, same_request FROM fn_group_link_replay($1, $2, $3)', [link.tokenSha256, link.keySha256, link.requestSha256])).rows[0];
      return r === undefined ? null : replayOf(r.purchase_ref, r.same_request);
    };
    if (intentKeySha256 !== null) {
      // The intent's row lock: a concurrent repeat (double click, lost response) waits here until this
      // attempt commits or rolls back, then answers with the same purchase.
      let claim: { purchase_ref: string | null; request_sha256: string | null } | undefined;
      try {
        claim = (await client.query<{ purchase_ref: string | null; request_sha256: string | null }>(
          'SELECT purchase_ref, request_sha256 FROM fn_checkout_intent_claim($1, $2)', [intentKeySha256, sessionSha256])).rows[0];
      } catch (e) {
        const m = (e as Error).message;
        if (m === 'CHECKOUT_SESSION_INVALID' || m === 'CHECKOUT_INTENT_INVALID') return refuse(m);
        throw e;
      }
      if (claim?.purchase_ref) return await replayOf(claim.purchase_ref, claim.request_sha256 === requestSha256);
    }
    const early = await replayed();
    if (early !== null) return early;
    // A new purchase accepts only the current terms and consent, under the live legal release. A
    // replay above answers from the accepted history instead, whatever has been published since.
    if (req.termsRef !== deps.catalog.terms.ref || req.termsHash !== deps.catalog.terms.hash) return refuse('TERMS_NOT_CURRENT');
    if (req.pdConsentRef !== deps.catalog.pdConsent.ref || req.pdConsentHash !== deps.catalog.pdConsent.hash) return refuse('PD_CONSENT_NOT_CURRENT');
    if (deps.legalAdmission !== undefined) {
      try { await deps.legalAdmission.verify(); } catch { return refuse('LEGAL_RELEASE_NOT_ADMITTED'); }
    }
    if ((await client.query<{ open: boolean }>('SELECT fn_sales_open_for_sale() AS open')).rows[0]?.open !== true) return refuse('SALES_CLOSED');
    const departureId = (await client.query<{ id: string | null }>('SELECT fn_lock_checkout_departure($1) AS id', [req.departureSlug])).rows[0]!.id;
    const afterLock = await replayed();
    if (afterLock !== null) return afterLock;
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
    let opened: { purchase_ref: string; purchase_group_ref: string; hold_expires_at: Date };
    try {
      opened = (await client.query<{ purchase_ref: string; purchase_group_ref: string; hold_expires_at: Date }>(
        'SELECT purchase_ref, purchase_group_ref, hold_expires_at FROM fn_open_slotted_purchase($1, $2, $3, $4, $5, $6, $7)',
        [id, adults, teens, children, link?.tokenSha256 ?? null, link?.keySha256 ?? null, link?.requestSha256 ?? null])).rows[0]!;
      // Consume the intent and bind the creating session; checked again at commit (migration 0023).
      if (intentKeySha256 !== null) {
        await client.query('SELECT fn_checkout_intent_consume($1, $2, $3)', [intentKeySha256, opened.purchase_ref, requestSha256]);
      } else {
        await client.query('SELECT fn_purchase_session_bind_new($1, $2)', [opened.purchase_ref, sessionSha256]);
      }
    } catch (e) {
      const code = DATABASE_REFUSALS.find((c) => (e as Error).message === c);
      if (code === undefined) throw e;
      return refuse(code); // the whole reservation rolls back
    }
    await client.query('COMMIT');
    deps.log('booking_reserved', { orderRef, departure: departure.slug, seats, amountKopecks: amount,
      purchaseRef: opened.purchase_ref, purchaseGroupRef: opened.purchase_group_ref });
    // The hold's end is the database's (five minutes by its clock, never past T−24).
    return { ok: true, replayed: false, orderRef, purchaseRef: opened.purchase_ref, purchaseGroupRef: opened.purchase_group_ref,
      amountKopecks: amount, reservedUntil: opened.hold_expires_at };
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
  | 'TICKET_TYPE_NOT_ALLOWED' | 'MINORS_WITHOUT_ADULT' | 'REHOLD_NOT_ALLOWED' | 'PURCHASE_CLOSED' | 'RETRY_WINDOW_CLOSED'
  | 'DEPARTURE_CHANGED' | 'LEGAL_TERMS_CHANGED' | 'PURCHASE_NOT_OWNED' | NotBookable;
/** The database enforces every one of these itself (fn_purchase_rehold); the checks above only answer earlier. */
const RETRY_REFUSALS = ['NOT_ENOUGH_SEATS', 'MINORS_NOT_ALLOWED', 'MINOR_SALES_PAUSED', 'TICKET_TYPE_NOT_ALLOWED',
  'MINORS_WITHOUT_ADULT', 'REHOLD_NOT_ALLOWED', 'PURCHASE_CLOSED', 'RETRY_WINDOW_CLOSED', 'SALES_CLOSED', 'BOOKING_CUTOFF_REACHED',
  'DEPARTURE_NOT_OPEN', 'DEPARTURE_NOT_LISTED', 'DEPARTURE_CHANGED', 'PURCHASE_NOT_OWNED'] as const satisfies readonly RetryRefusal[];

/**
 * A new payment cycle of the same purchase after the bank proved the previous attempt unpaid, or the
 * hold lapsed before any attempt (v1.9.0 §2 п.1): a new five-minute hold of the same seats at their
 * frozen prices, under the general rules (sales switch, T−24, quota, minors), until the earlier of 24
 * hours after the purchase and T−24. No new purchase, no new group link. The database enforces all of
 * it, including that the browser session owns the purchase (a purchaseRef alone is not enough,
 * G-RESUME-02, migration 0023).
 */
export async function retryNativePurchasePayment(deps: OrderDeps, purchaseRef: string, sessionToken: string):
  Promise<{ readonly ok: true; readonly holdRef: string; readonly reservedUntil: Date } | { readonly ok: false; readonly refusal: RetryRefusal }> {
  const refuse = (refusal: RetryRefusal) => {
    deps.log('payment_retry_refused', { purchaseRef, refusal });
    return { ok: false as const, refusal };
  };
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    // Ownership first: a stranger learns nothing else about the purchase.
    const owns = (await client.query<{ owns: boolean }>('SELECT fn_purchase_session_owns($1, $2) AS owns',
      [purchaseRef, tokenSha256(String(sessionToken))])).rows[0]?.owns;
    if (owns !== true) return refuse('PURCHASE_NOT_OWNED');
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
    // OWNER decision 2 (06.11.2026, Stage A): no new attempt under an offer or PD consent that has been
    // replaced since the buyer accepted it; the buyer accepts the current terms in a new purchase. The
    // current legal release is code-owned (catalog) until TOUR-59 moves it into the database, so this
    // check is the application's; the departure's own revision is checked by fn_purchase_rehold.
    const accepted = (await client.query<{ legal_release_ref: string; legal_release_hash: string; pd_consent_ref: string; pd_consent_hash: string }>(
      `SELECT o.legal_release_ref, o.legal_release_hash, o.pd_consent_ref, o.pd_consent_hash FROM purchase p
         JOIN orders o ON o.id = p.origin_order_id WHERE p.purchase_ref = $1`, [purchaseRef])).rows[0]!;
    if (accepted.legal_release_ref !== deps.catalog.terms.ref || accepted.legal_release_hash !== deps.catalog.terms.hash
        || accepted.pd_consent_ref !== deps.catalog.pdConsent.ref || accepted.pd_consent_hash !== deps.catalog.pdConsent.hash) {
      return refuse('LEGAL_TERMS_CHANGED');
    }
    let holdRef: string;
    let reservedUntil: Date;
    try {
      const held = (await client.query<{ hold_ref: string; expires_at: Date }>('SELECT hold_ref, expires_at FROM fn_purchase_rehold_owned($1, $2)',
        [purchaseRef, tokenSha256(sessionToken)])).rows[0]!;
      holdRef = held.hold_ref;
      reservedUntil = held.expires_at;
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
