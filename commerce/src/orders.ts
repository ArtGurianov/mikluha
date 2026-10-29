// Orders: reserving seats, letting unpaid reservations go, and erasing personal data on time.
//
// Owner decisions (Linear ART-47, 2026-10-04):
//   * the customer pays the full departure price online, for every seat;
//   * the customer (Заказчик) is tourist №1, plus a phone and an email: a customer who does not
//     travel would need their own document, address and authority in ЕИС, which v1 does not take;
//   * every tourist = what ЕИС «Электронная путёвка» requires (ПП №417): full name, date of birth,
//     citizenship, identity document (type, series where it has one, number). Nothing more;
//   * adults only in v1: the booker confirms it and every date of birth proves it;
//   * personal data never goes to logs (or to Refref, except the receipt email in a later slice);
//   * an unpaid order's personal data is erased within 24 hours of it ending; a trip's within
//     90 days after it ends, unless the order is under a legal hold or its money is unresolved.

import { randomBytes } from 'node:crypto';

import type pg from 'pg';

import { bookingCutoff } from './booking-window.js';

import { type Catalog, type NotBookable } from './catalog.js';
import { buildContractSnapshot, contractSnapshotHash } from './contract-snapshot.js';
import type { Logger } from './log.js';
import { bookablePublished } from './public-content.js';
import type { LegalReleaseAdmission } from './legal-admission.js';

export const MAX_SEATS_PER_ORDER = 6;
export const RESERVATION_MINUTES = 30;
export const UNPAID_PD_RETENTION_HOURS = 24;
export const TRIP_PD_RETENTION_DAYS = 90;
/**
 * ПП РФ №748: what a tourist contract contains is kept 3 years from the END OF THE CONTRACT: for a
 * FULFILLED order the trip's end, for a REFUNDED one the refund (closed_at). A PAID order has not
 * ended, so its contract is never erased, however old the trip.
 */
export const CONTRACT_RETENTION_YEARS = 3;
export const ADULT_AGE = 18;

/** States whose seats are taken. PAYMENT_PENDING and HELD never free seats on a timer. */
export const TAKEN = ['RESERVED', 'PAYMENT_PENDING', 'PAID', 'FULFILLED', 'HELD'] as const;

export type DocumentType = 'RU_PASSPORT' | 'RU_INTERNATIONAL_PASSPORT' | 'FOREIGN_DOCUMENT';

export interface TouristInput {
  readonly fullName: string;
  readonly dateOfBirth: string;
  /** ISO 3166-1 alpha-2, e.g. RU. */
  readonly citizenship: string;
  readonly document: { readonly type: string; readonly series?: string; readonly number: string };
}

export interface Tourist {
  readonly fullName: string; readonly dateOfBirth: string; readonly citizenship: string;
  readonly documentType: DocumentType; readonly documentSeries: string | null; readonly documentNumber: string;
}

/** Codes that name a country (Intl knows its name), not a region or a placeholder. */
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'ZZ', 'QO', 'XA', 'XB', 'AQ']);
const regionNames = new Intl.DisplayNames('ru', { type: 'region' });
export function countryName(code: string): string | null {
  if (!/^[A-Z]{2}$/.test(code) || NOT_COUNTRIES.has(code)) return null;
  const n = regionNames.of(code);
  return n === undefined || n === code ? null : n;
}

/** The document, normalised (digits and Latin capitals only), or null if it is not one we accept. */
export function normalizeDocument(citizenship: string, d: TouristInput['document']):
  { type: DocumentType; series: string | null; number: string } | null {
  const clean = (v: string | undefined) => (v ?? '').toUpperCase().replace(/[\s№-]/g, '');
  const series = clean(d.series);
  const number = clean(d.number);
  if (d.type === 'RU_PASSPORT' && citizenship === 'RU' && /^\d{4}$/.test(series) && /^\d{6}$/.test(number)) return { type: d.type, series, number };
  if (d.type === 'RU_INTERNATIONAL_PASSPORT' && citizenship === 'RU' && /^\d{2}$/.test(series) && /^\d{7}$/.test(number)) return { type: d.type, series, number };
  if (d.type === 'FOREIGN_DOCUMENT' && citizenship !== 'RU' && /^[0-9A-Z]{0,10}$/.test(series) && /^[0-9A-Z]{1,20}$/.test(number)) {
    return { type: d.type, series: series === '' ? null : series, number };
  }
  return null;
}

export interface BookingRequest {
  readonly departureSlug: string;
  /** Only after the HTTP handler verifies ownership of the old order. */
  readonly replacementOrderRef?: string;
  /** The customer's phone and email. The customer is passengers[0]. */
  readonly contact: { readonly phone: string; readonly email: string };
  readonly passengers: readonly TouristInput[];
  readonly adultsOnlyConfirmed: boolean;
  readonly termsRef: string;
  readonly termsHash: string;
  readonly pdConsentConfirmed: boolean;
  readonly pdConsentRef: string;
  readonly pdConsentHash: string;
}

export type BookingRefusal =
  | NotBookable | 'REPLACEMENT_NOT_AVAILABLE' | 'SALES_CLOSED' | 'TERMS_NOT_CURRENT' | 'PD_CONSENT_NOT_CURRENT'
  | 'PD_CONSENT_NOT_CONFIRMED' | 'ADULTS_ONLY_NOT_CONFIRMED'
  | 'SEATS_INVALID' | 'NOT_ENOUGH_SEATS' | 'CONTACT_PHONE_INVALID'
  | 'CONTACT_EMAIL_INVALID' | 'PASSENGER_NAME_INVALID' | 'DATE_OF_BIRTH_INVALID' | 'PASSENGER_NOT_ADULT'
  | 'CITIZENSHIP_INVALID' | 'DOCUMENT_INVALID' | 'LEGAL_RELEASE_NOT_ADMITTED';

export type BookingResult =
  | { readonly ok: true; readonly orderRef: string; readonly amountKopecks: number; readonly reservedUntil: Date }
  | { readonly ok: false; readonly refusal: BookingRefusal };

/** purchaseRef is null for an order outside any purchase (its profile provenance is unresolved). */
export type NativeBookingResult =
  | { readonly ok: true; readonly orderRef: string; readonly amountKopecks: number; readonly reservedUntil: Date;
      readonly purchaseRef: string | null; readonly revision: number | null }
  | { readonly ok: false; readonly refusal: BookingRefusal };

const NAME = /^[\p{L}][\p{L}\p{M} .'’-]{1,199}$/u;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const name = (s: string): string | null => {
  const t = s.normalize('NFC').trim().replace(/\s+/g, ' ');
  return NAME.test(t) ? t : null;
};

/** A Russian mobile or landline number as +7XXXXXXXXXX; anything else is refused. */
export function normalizePhone(s: string): string | null {
  const digits = s.replace(/[\s()-]/g, '');
  const m = /^(?:\+7|8|7)(\d{10})$/.exec(digits);
  return m ? `+7${m[1]}` : null;
}

function realDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

/** Age in whole years on `on` (both YYYY-MM-DD). */
export function ageOn(dateOfBirth: string, on: string): number {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [y, m, d] = on.split('-').map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

const newOrderRef = () => {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  return `mk-${[...randomBytes(12)].map((b) => alphabet[b % 36]).join('')}`;
};

export interface OrderDeps {
  readonly pool: pg.Pool;
  readonly catalog: Catalog;
  readonly log: Logger;
  readonly allowDemo: boolean;
  readonly legalAdmission?: LegalReleaseAdmission;
  readonly now?: () => Date;
}

export async function salesOpen(pool: pg.Pool): Promise<boolean> {
  const { rows } = await pool.query<{ open: boolean }>('SELECT open FROM sales_switch');
  return rows[0]?.open === true;
}

export async function setSalesOpen(pool: pg.Pool, open: boolean, by: string, reason: string): Promise<void> {
  await pool.query('SELECT fn_set_sales_open($1, $2, $3)', [open, by, reason]);
}

/**
 * Reserve from the live published row, under the same row/advisory locks as editorial changes.
 * No YAML price or contract can admit a booking; two customers cannot take the last seat.
 */
export async function reserve(deps: OrderDeps, req: BookingRequest): Promise<BookingResult> {
  const r = await reserveOrder(deps, req, false);
  return r.ok ? { ok: true, orderRef: r.orderRef, amountKopecks: r.amountKopecks, reservedUntil: r.reservedUntil } : r;
}

/** `native` opens the order as a purchase in the same transaction (purchases.ts); callers decide it, never the request. */
export async function reserveOrder(deps: OrderDeps, req: BookingRequest, native: boolean): Promise<NativeBookingResult> {
  const refuse = (refusal: BookingRefusal): NativeBookingResult => {
    deps.log('booking_refused', { departure: req.departureSlug, refusal });
    return { ok: false, refusal };
  };

  if (req.termsRef !== deps.catalog.terms.ref || req.termsHash !== deps.catalog.terms.hash) return refuse('TERMS_NOT_CURRENT');
  if (req.pdConsentRef !== deps.catalog.pdConsent.ref || req.pdConsentHash !== deps.catalog.pdConsent.hash) {
    return refuse('PD_CONSENT_NOT_CURRENT');
  }
  if (req.pdConsentConfirmed !== true) return refuse('PD_CONSENT_NOT_CONFIRMED');
  if (req.adultsOnlyConfirmed !== true) return refuse('ADULTS_ONLY_NOT_CONFIRMED');
  const seats = req.passengers.length;
  if (seats < 1 || seats > MAX_SEATS_PER_ORDER) return refuse('SEATS_INVALID');

  const phone = normalizePhone(req.contact.phone);
  if (phone === null) return refuse('CONTACT_PHONE_INVALID');
  const email = req.contact.email.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) return refuse('CONTACT_EMAIL_INVALID');

  const passengers: Tourist[] = [];
  for (const p of req.passengers) {
    const n = name(p.fullName);
    if (n === null) return refuse('PASSENGER_NAME_INVALID');
    if (!realDate(p.dateOfBirth)) return refuse('DATE_OF_BIRTH_INVALID');
    const citizenship = p.citizenship.trim().toUpperCase();
    if (countryName(citizenship) === null) return refuse('CITIZENSHIP_INVALID');
    const doc = normalizeDocument(citizenship, p.document);
    if (doc === null) return refuse('DOCUMENT_INVALID');
    passengers.push({ fullName: n, dateOfBirth: p.dateOfBirth, citizenship,
      documentType: doc.type, documentSeries: doc.series, documentNumber: doc.number });
  }

  if (deps.legalAdmission !== undefined) {
    try { await deps.legalAdmission.verify(); }
    catch { return refuse('LEGAL_RELEASE_NOT_ADMITTED'); }
  }

  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    const open = await client.query<{ open: boolean }>('SELECT fn_sales_open_for_sale() AS open');
    if (open.rows[0]?.open !== true) return refuse('SALES_CLOSED');
    const departureId = (await client.query<{ id: string | null }>('SELECT fn_lock_checkout_departure($1) AS id', [req.departureSlug])).rows[0]!.id;
    let now = (deps.now ?? (() => new Date()))();
    const departure=await bookablePublished(client,deps.catalog,req.departureSlug,now,deps.allowDemo);
    if (typeof departure==='string') return refuse(departure);
    for (const p of passengers) {
      if (p.dateOfBirth >= departure.startsOn) return refuse('DATE_OF_BIRTH_INVALID');
      if (ageOn(p.dateOfBirth,departure.startsOn)<ADULT_AGE) return refuse('PASSENGER_NOT_ADULT');
    }
    let replacedId:string|null=null;
    if (req.replacementOrderRef !== undefined) {
      // A replacement never changes profile: a purchase continues only as a purchase, an order
      // outside one only outside one.
      const prior=(await client.query<{id:string}>(`SELECT id FROM orders WHERE order_ref=$1 AND departure_slug=$2
        AND status='RESERVED' AND (quote_expires_at IS NULL OR quote_expires_at <= $3)
        AND snapshot IS NULL AND checkout_attempt_id IS NULL AND payment_pending_since IS NULL
        AND resolution_operation_id IS NULL
        AND ${native ? '' : 'NOT '}EXISTS (SELECT 1 FROM purchase_revision r JOIN purchase p ON p.id = r.purchase_id
          WHERE r.document_order_id = orders.id AND r.revision = p.current_revision) FOR UPDATE OF orders`,
        [req.replacementOrderRef,req.departureSlug,now])).rows[0];
      if (!prior) return refuse('REPLACEMENT_NOT_AVAILABLE');
      replacedId=prior.id;
      await client.query("UPDATE orders SET status='CANCELLED',closed_at=$2 WHERE id=$1",[prior.id,now]);
      await client.query("INSERT INTO order_event(order_id,at,event,detail) VALUES ($1,$2,'CANCELLED','QUOTE_REPLACED')",[prior.id,now]);
    }

    const taken = await client.query<{ seats: string }>('SELECT fn_departure_taken_seats($1, $2) AS seats', [departure.slug, now]);
    if (Number(taken.rows[0]!.seats) + seats > departure.capacity) {
      await client.query('ROLLBACK');
      return refuse('NOT_ENOUGH_SEATS');
    }
    // Recheck after the awaited capacity/replacement reads, before creating the hold.
    now = (deps.now ?? (()=>new Date()))();
    const cutoff=bookingCutoff(departure.startsOn,departure.contract.departure.departureTime,departure.timezone);
    if (cutoff<=now) return refuse('BOOKING_CUTOFF_REACHED');
    const orderRef = newOrderRef();
    const reservedUntil = new Date(Math.min(now.getTime() + RESERVATION_MINUTES * 60_000,
      cutoff.getTime()));
    const amount = departure.priceKopecks * seats;
    // The buyer's contract, as resolved now: later edits of the departure never reach this order.
    const contract = buildContractSnapshot(departure, departure.timezone);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO orders (order_ref, departure_slug, trip_starts_on, trip_ends_on, seats, unit_price_kopecks,
                           amount_kopecks, status, reserved_until, legal_release_ref, legal_release_hash, legal_release_content,
                           pd_consent_ref, pd_consent_hash, pd_consent_content, pd_consent_accepted_at,
                           adults_only_confirmed, created_at, trip_departure_time, trip_return_time, trip_timezone,
                           contract_snapshot, contract_snapshot_sha256, departure_id, accepted_departure_version, attempt_creation_state, replaces_order_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'RESERVED', $8, $9, $10, $11, $12, $13, $14, $15, true, $15, $16, $17, $18, $19, $20, $21, $22, 'NOT_STARTED', $23) RETURNING id`,
      [orderRef, departure.slug, departure.startsOn, departure.endsOn, seats, departure.priceKopecks, amount,
        reservedUntil, req.termsRef, req.termsHash, deps.catalog.terms.text, deps.catalog.pdConsent.ref,
        deps.catalog.pdConsent.hash, deps.catalog.pdConsent.text, now,
        departure.contract.departure.departureTime, departure.contract.departure.returnTime, departure.timezone,
        contract, contractSnapshotHash(contract), departureId, departure.publishedVersion, replacedId]);
    const id = inserted.rows[0]!.id;
    // The customer is tourist №1: their name is that tourist's, by construction.
    await client.query('INSERT INTO order_contact (order_id, full_name, phone, email) VALUES ($1, $2, $3, $4)',
      [id, passengers[0]!.fullName, phone, email]);
    for (const [i, p] of passengers.entries()) {
      await client.query(`INSERT INTO order_passenger (order_id, position, full_name, date_of_birth, citizenship,
          document_type, document_series, document_number) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, i + 1, p.fullName, p.dateOfBirth, p.citizenship, p.documentType, p.documentSeries, p.documentNumber]);
    }
    await client.query(`INSERT INTO order_event (order_id, at, event, detail) VALUES ($1, $2, 'RESERVED', $3)`,
      [id, now, `seats:${seats}`]);
    const purchase = native ? (await client.query<{ purchase_ref: string; revision: number }>(
      'SELECT purchase_ref, revision FROM fn_open_native_purchase($1)', [id])).rows[0]! : null;
    await client.query('COMMIT');
    if (replacedId !== null) deps.log('order_cancelled',{orderRef:req.replacementOrderRef!,reason:'QUOTE_REPLACED'});
    deps.log('booking_reserved', { orderRef, departure: departure.slug, seats, amountKopecks: amount,
      ...(purchase ? { purchaseRef: purchase.purchase_ref, revision: purchase.revision } : {}) });
    return { ok: true, orderRef, amountKopecks: amount, reservedUntil,
      purchaseRef: purchase?.purchase_ref ?? null, revision: purchase?.revision ?? null };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/**
 * Housekeeping, run every minute: reservations past their time end as EXPIRED (their seats are
 * free again), then personal data past its retention is erased. Returns what it did, as counts.
 */
export async function maintain(pool: pg.Pool, log: Logger, now: Date = new Date()): Promise<{ expired: number; erased: number; contractsErased: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A crashed read-only resolve can be retried with the same handoff identity (Refref docs/28 §5).
    const stale = await client.query<{ id: string }>(`UPDATE orders SET resolution_operation_id=NULL, resolution_started_at=NULL
      WHERE status='RESERVED' AND snapshot IS NULL AND checkout_attempt_id IS NULL AND payment_pending_since IS NULL
        AND resolution_operation_id IS NOT NULL AND (resolution_started_at IS NULL OR resolution_started_at <= $1::timestamptz - interval '2 minutes')
      RETURNING id`, [now]);
    for (const r of stale.rows) await client.query("INSERT INTO order_event(order_id,at,event) VALUES ($1,$2,'RESOLUTION_LEASE_EXPIRED')", [r.id,now]);
    // Resolution has no payment authority. Revoke its token atomically before releasing an
    // overdue unpaid order; its callback must match that token and RESERVED before applying.
    // Frozen/started/uncertain payments never enter this branch.
    const expired = await client.query<{ id: string }>(
      `UPDATE orders SET status = 'EXPIRED', closed_at = $1, resolution_operation_id = NULL, resolution_started_at = NULL
        WHERE status = 'RESERVED' AND reserved_until <= $1 AND snapshot IS NULL
          AND checkout_attempt_id IS NULL AND payment_pending_since IS NULL RETURNING id`, [now]);
    for (const r of expired.rows) {
      await client.query(`INSERT INTO order_event (order_id, at, event) VALUES ($1, $2, 'EXPIRED')`, [r.id, now]);
    }
    // Unpaid and over: 24 hours; no contract was concluded, so the Заявка goes too. A trip: the
    // operational personal data 90 days after it ends, once its money is settled (paid, fulfilled or
    // refunded; never pending or held); the Заявка, which is then the contract, stays (below).
    // A legal hold stops all of it. A purchase order also waits for the database clock (migration 0017).
    const erasable = await client.query<{ id: string; unpaid: boolean }>(
      `SELECT id, status IN ('EXPIRED','CANCELLED') AS unpaid FROM orders
        WHERE pd_erased_at IS NULL AND NOT legal_hold AND fn_purchase_pd_retention_due(id) AND (
              (status IN ('EXPIRED','CANCELLED') AND closed_at <= $1::timestamptz - make_interval(hours => $2))
           OR (status IN ('PAID','FULFILLED','REFUNDED')
               AND trip_ends_on + $3::int < ($1::timestamptz AT TIME ZONE 'UTC')::date))
        FOR UPDATE`, [now, UNPAID_PD_RETENTION_HOURS, TRIP_PD_RETENTION_DAYS]);
    for (const r of erasable.rows) {
      // Mark the scheduled retention operation before deleting tourist/contact rows. The EIS
      // material-change triggers then distinguish erasure from a factual correction.
      await client.query('UPDATE orders SET pd_erased_at = $2 WHERE id = $1', [r.id, now]);
      if (r.unpaid) await client.query('UPDATE order_document SET content = NULL WHERE order_id = $1', [r.id]);
      await client.query('DELETE FROM order_passenger WHERE order_id = $1', [r.id]);
      await client.query('DELETE FROM order_contact WHERE order_id = $1', [r.id]);
      await client.query('UPDATE email_outbox SET recipient_email = NULL WHERE order_id = $1', [r.id]);
      await client.query(`INSERT INTO order_event (order_id, at, event) VALUES ($1, $2, 'PD_ERASED')`, [r.id, now]);
    }
    // The contract (a paid order's Заявка): 3 years after the contract ended, unless held.
    const contracts = await client.query<{ order_id: string }>(
      `UPDATE order_document d SET content = NULL FROM orders o
        WHERE o.id = d.order_id AND d.content IS NOT NULL AND NOT o.legal_hold
          AND ((o.status = 'FULFILLED'
                AND o.trip_ends_on + make_interval(years => $2) < ($1::timestamptz AT TIME ZONE 'UTC')::date)
            OR (o.status = 'REFUNDED' AND o.closed_at + make_interval(years => $2) < $1::timestamptz))
        RETURNING d.order_id`, [now, CONTRACT_RETENTION_YEARS]);
    for (const r of contracts.rows) {
      await client.query(`INSERT INTO order_event (order_id, at, event) VALUES ($1, $2, 'CONTRACT_ERASED')`, [r.order_id, now]);
    }
    await client.query('COMMIT');
    const contractsErased = contracts.rowCount ?? 0;
    if (expired.rowCount || erasable.rowCount || contractsErased) {
      log('maintenance', { expired: expired.rowCount ?? 0, erased: erasable.rowCount ?? 0, contractsErased });
    }
    return { expired: expired.rowCount ?? 0, erased: erasable.rowCount ?? 0, contractsErased };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
