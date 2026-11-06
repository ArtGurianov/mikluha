// Merchant-native bank operations (Track A / A2b-1 for TOUR-77, migration 0022): the database half.
//
//   * openCollection records the operation and fences the purchase's open payment cycle before
//     anything is sent to the bank; calling it again for the same cycle returns the same operation;
//   * recordBankEvidence stores one authenticated answer of the bank (registration response, callback,
//     read-back, or a transport error as UNKNOWN). The database matches it with the operation and only
//     then applies the outcome to the seats; the money fact stays even when no seat may change, and a
//     settlement case for TOUR-27 is opened once;
//   * the payload is identified by its SHA-256 only: no provider payload or personal data is stored.
//
// The provider transport (Alfa registration, signature checks, read-back scheduling) is TOUR-77's;
// provider qualification is TOUR-83's. Nothing here is qualified for real money.

import { createHash } from 'node:crypto';

import type pg from 'pg';

import { tokenSha256 } from './checkout-session.js';

export type EvidenceSource = 'REGISTRATION_RESPONSE' | 'CALLBACK' | 'READ_BACK' | 'DISPATCH_ERROR';
export type BankStatus = 'INTENDED' | 'REGISTERED' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED';
export type SeatEffect = 'SEATS_CONFIRMED' | 'SEATS_RELEASED' | 'LATE_CONFIRMED' | 'PAID_NO_SEAT'
  | 'PURCHASE_CLOSED_LATE_PAYMENT' | 'NEWER_CYCLE_EXISTS' | 'NONE';

/** One answer about one operation, already authenticated by the caller (signature, TLS read-back). */
export interface BankEvidence {
  readonly source: EvidenceSource;
  readonly observed: 'REGISTERED' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  readonly provider?: string;
  readonly merchantAccount?: string;
  readonly providerOperationId?: string;
  readonly amountKopecks?: number;
  readonly currency?: string;
  readonly providerEventId?: string;
  /** The raw authenticated payload (or the local transport error); only its hash is kept. */
  readonly payload: string | Uint8Array;
}

export interface RecordedEvidence {
  readonly status: BankStatus;
  readonly effect: 'STATUS_CHANGED' | 'NO_CHANGE' | 'EVIDENCE_MISMATCH' | 'CONTRADICTORY';
  readonly seatEffect: SeatEffect | null;
  readonly confirmed: number;
  readonly noSeat: number;
  readonly settlementCaseRef: string | null;
  /** The same evidence was recorded before; nothing changed. */
  readonly replayed: boolean;
  /** The outcome is final but its seat application failed unexpectedly; maintain() retries it. */
  readonly applicationPending: boolean;
}

export type OpenRefusal = 'HOLD_NOT_OPEN' | 'HOLD_EXPIRED' | 'HOLD_ALREADY_FENCED' | 'PURCHASE_CLOSED' | 'PURCHASE_UNKNOWN' | 'PURCHASE_NOT_OWNED'
  | 'DEPARTURE_CHANGED' | 'LEGAL_TERMS_CHANGED' | 'DEPOSIT_WINDOW_CLOSED' | 'DEPOSIT_NOT_AVAILABLE' | 'BALANCE_WINDOW_CLOSED'
  | 'NOTHING_DUE' | 'BALANCE_PAYMENT_IN_FLIGHT' | 'BALANCE_APPLICATION_PENDING' | 'BALANCE_SETTLEMENT_PENDING';
const OPEN_REFUSALS = ['HOLD_NOT_OPEN', 'HOLD_EXPIRED', 'HOLD_ALREADY_FENCED', 'PURCHASE_CLOSED', 'PURCHASE_UNKNOWN',
  'PURCHASE_NOT_OWNED', 'DEPARTURE_CHANGED', 'LEGAL_TERMS_CHANGED', 'DEPOSIT_WINDOW_CLOSED', 'DEPOSIT_NOT_AVAILABLE',
  'BALANCE_WINDOW_CLOSED', 'NOTHING_DUE', 'BALANCE_PAYMENT_IN_FLIGHT', 'BALANCE_APPLICATION_PENDING',
  'BALANCE_SETTLEMENT_PENDING'] as const satisfies readonly OpenRefusal[];

/**
 * What a payment pays (migration 0026, MK-C01): FULL the whole purchase and DEPOSIT the seats' deposits
 * (min(nominal, price) each; only before T−72, and only when less than the whole price), both on the
 * open payment cycle; BALANCE what is still owed on confirmed seats, without a cycle, before T−24.
 */
export type PaymentPurpose = 'FULL' | 'DEPOSIT' | 'BALANCE';

/**
 * The offer and PD consent releases published now (code-owned until TOUR-59). The database compares them
 * with the purchase's current revision before any payment starts (migration 0025).
 */
export interface CurrentTerms {
  readonly termsRef: string; readonly termsHash: string; readonly pdConsentRef: string; readonly pdConsentHash: string;
}
export const currentTermsOf = (catalog: { terms: { ref: string; hash: string }; pdConsent: { ref: string; hash: string } }): CurrentTerms =>
  ({ termsRef: catalog.terms.ref, termsHash: catalog.terms.hash, pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash });
const termsArgs = (t: CurrentTerms) => [t.termsRef, t.termsHash, t.pdConsentRef, t.pdConsentHash];

export const payloadSha256 = (payload: string | Uint8Array) => createHash('sha256').update(payload).digest('hex');

/**
 * Record the collection of the purchase's open payment cycle, before the bank registration. The
 * returned reference is the operation's identity towards the bank (its order number). Only a browser
 * session bound to the purchase may start it (migration 0023, G-RESUME-02). An operation already
 * registered on the cycle is returned as is; a new one is refused once the departure, offer or PD consent
 * has a newer release than the purchase's current revision (migration 0025, OWNER A2b-10 decision).
 */
export async function openCollection(pool: pg.Pool | pg.PoolClient, purchaseRef: string, sessionToken: string, provider: string,
  merchantAccount: string, terms: CurrentTerms, purpose: PaymentPurpose = 'FULL'):
  Promise<{ readonly ok: true; readonly bankOperationRef: string; readonly holdRef: string | null; readonly amountKopecks: number;
            readonly currency: string; readonly replayed: boolean } | { readonly ok: false; readonly refusal: OpenRefusal }> {
  try {
    const r = (await pool.query<{ bank_operation_ref: string; hold_ref: string | null; amount_kopecks: string; currency: string; replayed: boolean }>(
      'SELECT * FROM fn_bank_operation_open_payment($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [purchaseRef, tokenSha256(sessionToken), provider, merchantAccount, ...termsArgs(terms), purpose])).rows[0]!;
    return { ok: true, bankOperationRef: r.bank_operation_ref, holdRef: r.hold_ref, amountKopecks: Number(r.amount_kopecks),
      currency: r.currency, replayed: r.replayed };
  } catch (e) {
    const refusal = OPEN_REFUSALS.find((c) => (e as Error).message === c);
    if (refusal === undefined) throw e;
    return { ok: false, refusal };
  }
}

/**
 * After DEPARTURE_CHANGED or LEGAL_TERMS_CHANGED: release the live, unfenced hold at once instead of
 * waiting out its five minutes. Idempotent; false when there is nothing to release (no open hold, an
 * operation already registered, or the terms are current after all).
 */
export async function releaseStaleHold(pool: pg.Pool | pg.PoolClient, purchaseRef: string, sessionToken: string, terms: CurrentTerms): Promise<boolean> {
  return (await pool.query<{ r: boolean }>('SELECT fn_purchase_hold_release_stale($1, $2, $3, $4, $5, $6) AS r',
    [purchaseRef, tokenSha256(sessionToken), ...termsArgs(terms)])).rows[0]!.r;
}

/** Record one piece of evidence about an operation; the database decides what it changes. */
export async function recordBankEvidence(pool: pg.Pool | pg.PoolClient, bankOperationRef: string, ev: BankEvidence): Promise<RecordedEvidence> {
  const r = (await pool.query<{ status: BankStatus; effect: RecordedEvidence['effect']; seat_effect: SeatEffect | null; confirmed: number;
    no_seat: number; settlement_case_ref: string | null; replayed: boolean; application_pending: boolean }>(
    'SELECT * FROM fn_bank_operation_record($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
    [bankOperationRef, ev.source, ev.observed, ev.provider ?? null, ev.merchantAccount ?? null, ev.providerOperationId ?? null,
      ev.amountKopecks ?? null, ev.currency ?? null, ev.providerEventId ?? null, payloadSha256(ev.payload)])).rows[0]!;
  return { status: r.status, effect: r.effect, seatEffect: r.seat_effect, confirmed: r.confirmed, noSeat: r.no_seat,
    settlementCaseRef: r.settlement_case_ref, replayed: r.replayed, applicationPending: r.application_pending };
}

export interface PurchaseMoney {
  readonly totalKopecks: number; readonly depositTotalKopecks: number; readonly paidKopecks: number; readonly refundedKopecks: number;
  readonly balanceDueKopecks: number; readonly depositUntil: Date; readonly balanceDueAt: Date; readonly depositOffered: boolean;
}

/** The purchase's money by the ledger (migration 0026): no personal data. */
export async function purchaseMoney(pool: pg.Pool | pg.PoolClient, purchaseRef: string): Promise<PurchaseMoney | null> {
  const r = (await pool.query<{ total_kopecks: string; deposit_total_kopecks: string; paid_kopecks: string; refunded_kopecks: string;
    balance_due_kopecks: string; deposit_until: Date; balance_due_at: Date; deposit_offered: boolean }>(
    'SELECT * FROM purchase_money WHERE purchase_ref = $1', [purchaseRef])).rows[0];
  return r === undefined ? null : { totalKopecks: Number(r.total_kopecks), depositTotalKopecks: Number(r.deposit_total_kopecks),
    paidKopecks: Number(r.paid_kopecks), refundedKopecks: Number(r.refunded_kopecks), balanceDueKopecks: Number(r.balance_due_kopecks),
    depositUntil: r.deposit_until, balanceDueAt: r.balance_due_at, depositOffered: r.deposit_offered };
}

/** Retry seat applications that failed unexpectedly (maintain()). */
export async function applyDueBankOperations(pool: pg.Pool | pg.PoolClient): Promise<number> {
  return (await pool.query<{ n: number }>('SELECT fn_bank_operations_apply_due() AS n')).rows[0]!.n;
}

export interface PendingOperation {
  readonly bankOperationRef: string; readonly kind: 'COLLECTION' | 'REFUND'; readonly purchaseRef: string;
  readonly provider: string; readonly providerOperationId: string | null; readonly status: BankStatus;
  readonly bankExpiresAt: Date | null; readonly readBackDue: boolean;
}

/** Operations the read-back worker must ask the bank about (never charge again blindly). */
export async function pendingBankOperations(pool: pg.Pool | pg.PoolClient): Promise<PendingOperation[]> {
  const { rows } = await pool.query<{ bank_operation_ref: string; kind: 'COLLECTION' | 'REFUND'; purchase_ref: string; provider: string;
    provider_operation_id: string | null; status: BankStatus; bank_expires_at: Date | null; read_back_due: boolean }>(
    `SELECT bank_operation_ref, kind, purchase_ref, provider, provider_operation_id, status, bank_expires_at, read_back_due
       FROM bank_operation_pending ORDER BY created_at`);
  return rows.map((r) => ({ bankOperationRef: r.bank_operation_ref, kind: r.kind, purchaseRef: r.purchase_ref, provider: r.provider,
    providerOperationId: r.provider_operation_id, status: r.status, bankExpiresAt: r.bank_expires_at, readBackDue: r.read_back_due }));
}
