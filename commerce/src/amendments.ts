// Purchase amendments (Track A / A2b-3a for TOUR-79, migration 0027; contract
// docs/plans/2026-11-07-a2b-3-purchase-amendments-contract.md, OWNER decisions Q2–Q6 of 07.11.2026).
//
//   * staff propose a TICKET_TYPE_CORRECTION or a PARTICIPANT_REPLACEMENT; the buyer consents to the candidate
//     hash the database recomputes (own session or the one-time amendment link) and the revision is written
//     atomically; staff record a PARTIAL_CANCELLATION / FULL_TERMINATION, effective at once;
//   * refusals that close a proposal (STALE, EXPIRED) come back as values: the closing is kept;
//   * money: cancelled seats' money goes to a lot-based settlement case, executed by refunds through the source
//     collection and OWNER retentions; a contradicted refund is resolved by its exact split.
//
// No personal data: refs, hashes and amounts only. The database decides; these wrappers name its answers.

import type pg from 'pg';

import { tokenSha256 } from './checkout-session.js';

export type TicketType = 'AGE_0_13' | 'AGE_14_17' | 'AGE_18_PLUS';
export type AmendmentRefusal = 'AMENDMENT_INVALID' | 'AMENDMENT_ALREADY_OPEN' | 'AMENDMENT_SEAT_NOT_ELIGIBLE' | 'AMENDMENT_NO_CHANGE'
  | 'AMENDMENT_PURCHASE_NOT_CONFIRMED' | 'AMENDMENT_PURCHASE_TERMINATED' | 'AMENDMENT_PAYMENT_IN_FLIGHT' | 'AMENDMENT_SETTLEMENT_PENDING'
  | 'REFUND_CONTRADICTION_PENDING' | 'SERVICE_PERIOD_ENDED' | 'REPLACEMENT_NOT_NEEDED' | 'MINORS_NOT_ALLOWED' | 'TICKET_TYPE_NOT_ALLOWED'
  | 'IDEMPOTENCY_CONFLICT' | 'PURCHASE_CLOSED' | 'PURCHASE_UNKNOWN' | 'AMENDMENT_UNKNOWN' | 'AMENDMENT_NOT_OPEN' | 'PURCHASE_NOT_OWNED';
const REFUSALS: readonly AmendmentRefusal[] = ['AMENDMENT_INVALID', 'AMENDMENT_ALREADY_OPEN', 'AMENDMENT_SEAT_NOT_ELIGIBLE',
  'AMENDMENT_NO_CHANGE', 'AMENDMENT_PURCHASE_NOT_CONFIRMED', 'AMENDMENT_PURCHASE_TERMINATED', 'AMENDMENT_PAYMENT_IN_FLIGHT',
  'AMENDMENT_SETTLEMENT_PENDING', 'REFUND_CONTRADICTION_PENDING', 'SERVICE_PERIOD_ENDED', 'REPLACEMENT_NOT_NEEDED', 'MINORS_NOT_ALLOWED',
  'TICKET_TYPE_NOT_ALLOWED', 'IDEMPOTENCY_CONFLICT', 'PURCHASE_CLOSED', 'PURCHASE_UNKNOWN', 'AMENDMENT_UNKNOWN', 'AMENDMENT_NOT_OPEN',
  'PURCHASE_NOT_OWNED'];

async function refusing<T>(run: () => Promise<T>): Promise<T | { readonly ok: false; readonly refusal: AmendmentRefusal }> {
  try { return await run(); } catch (e) {
    const refusal = REFUSALS.find((r) => (e as Error).message === r);
    if (refusal === undefined) throw e;
    return { ok: false, refusal };
  }
}

export interface Proposal { readonly ok: true; readonly amendmentRef: string; readonly candidateHash: string; readonly expiresAt: Date; readonly replayed: boolean }
type ProposalRow = { amendment_ref: string; candidate_hash: string; expires_at: Date; replayed: boolean };
const proposal = (r: ProposalRow): Proposal =>
  ({ ok: true, amendmentRef: r.amendment_ref, candidateHash: r.candidate_hash, expiresAt: r.expires_at, replayed: r.replayed });

/** Staff (amendment.record) propose a category correction; the buyer must consent (OWNER Q2). */
export const proposeTicketTypeCorrection = (admin: pg.Pool | pg.PoolClient, adminId: string, purchaseRef: string,
  changes: readonly { seatSlotRef: string; ticketType: TicketType }[], o: { linkToken?: string; reason: string; evidenceRef?: string; idempotencyKey: string }) =>
  refusing(async () => proposal((await admin.query<ProposalRow>('SELECT * FROM fn_amendment_propose_correction($1, $2, $3, $4, $5, $6, $7)',
    [adminId, purchaseRef, JSON.stringify(changes), o.linkToken === undefined ? null : tokenSha256(o.linkToken), o.reason, o.evidenceRef ?? null,
      o.idempotencyKey])).rows[0]!));

/** Staff (amendment.record) propose replacing the person of a seat; the buyer must consent. */
export const proposeParticipantReplacement = (admin: pg.Pool | pg.PoolClient, adminId: string, purchaseRef: string, seatSlotRef: string,
  o: { linkToken?: string; reason: string; evidenceRef?: string; idempotencyKey: string }) =>
  refusing(async () => proposal((await admin.query<ProposalRow>('SELECT * FROM fn_amendment_propose_replacement($1, $2, $3, $4, $5, $6, $7)',
    [adminId, purchaseRef, seatSlotRef, o.linkToken === undefined ? null : tokenSha256(o.linkToken), o.reason, o.evidenceRef ?? null,
      o.idempotencyKey])).rows[0]!));

export interface RecordedCancellation {
  readonly ok: true; readonly amendmentRef: string; readonly basis: 'PARTIAL_CANCELLATION' | 'FULL_TERMINATION'; readonly revision: number;
  readonly caseRef: string | null; readonly replayed: boolean;
}
/** Staff (amendment.record) record a cancellation of seats (all active seats: a full termination), effective at once. */
export const recordCancellation = (admin: pg.Pool | pg.PoolClient, adminId: string, purchaseRef: string, seatSlotRefs: readonly string[],
  o: { initiator: 'BUYER' | 'ORGANIZER'; reason: string; evidenceRef?: string; idempotencyKey: string }) =>
  refusing(async (): Promise<RecordedCancellation> => {
    const r = (await admin.query<{ amendment_ref: string; basis: RecordedCancellation['basis']; revision: number; case_ref: string | null; replayed: boolean }>(
      'SELECT * FROM fn_amendment_record_cancellation($1, $2, $3, $4, $5, $6, $7)',
      [adminId, purchaseRef, seatSlotRefs, o.initiator, o.reason, o.evidenceRef ?? null, o.idempotencyKey])).rows[0]!;
    return { ok: true, amendmentRef: r.amendment_ref, basis: r.basis, revision: r.revision, caseRef: r.case_ref, replayed: r.replayed };
  });

export type ConsentResult = 'COMMITTED' | 'REPLAYED' | 'STALE' | 'EXPIRED' | 'NOT_OPEN';
/** The buyer's consent to the hash they saw. STALE / EXPIRED close the proposal and are kept (§2.4). */
export const consentToAmendment = (pool: pg.Pool | pg.PoolClient, amendmentRef: string, candidateHash: string,
  by: { sessionToken: string } | { linkToken: string }) =>
  refusing(async () => {
    const r = (await pool.query<{ result: ConsentResult; consent_ref: string | null; revision: number | null }>(
      'SELECT * FROM fn_amendment_consent($1, $2, $3, $4)', [amendmentRef, candidateHash,
        'sessionToken' in by ? tokenSha256(by.sessionToken) : null, 'linkToken' in by ? tokenSha256(by.linkToken) : null])).rows[0]!;
    return { ok: true as const, result: r.result, consentRef: r.consent_ref, revision: r.revision };
  });

export const rejectAmendment = (pool: pg.Pool | pg.PoolClient, amendmentRef: string, by: { sessionToken: string } | { linkToken: string }) =>
  refusing(async () => ({ ok: true as const, result: (await pool.query<{ r: 'REJECTED' | 'NOT_OPEN' }>('SELECT fn_amendment_reject($1, $2, $3) AS r',
    [amendmentRef, 'sessionToken' in by ? tokenSha256(by.sessionToken) : null, 'linkToken' in by ? tokenSha256(by.linkToken) : null])).rows[0]!.r }));

export const withdrawAmendment = (admin: pg.Pool | pg.PoolClient, adminId: string, amendmentRef: string, reason: string) =>
  refusing(async () => { await admin.query('SELECT fn_amendment_withdraw($1, $2, $3)', [adminId, amendmentRef, reason]); return { ok: true as const }; });

/** maintain(): proposals past their time close EXPIRED. */
export async function closeDueAmendments(pool: pg.Pool | pg.PoolClient): Promise<number> {
  return (await pool.query<{ n: number }>('SELECT fn_amendments_close_due() AS n')).rows[0]!.n;
}

/** OWNER (refund.execute): a refund of a lot-based case through one of its source collections. */
export async function openSettlementRefund(admin: pg.Pool | pg.PoolClient, adminId: string, caseRef: string, collectionRef: string,
  amountKopecks: number, reason: string): Promise<string> {
  return (await admin.query<{ r: string }>('SELECT fn_settlement_refund_open($1, $2, $3, $4, $5) AS r',
    [adminId, caseRef, collectionRef, amountKopecks, reason])).rows[0]!.r;
}

/** OWNER (refund.execute): a retention on a lot with its legal basis and evidence; true when the case closed. */
export async function retainSettlementLot(admin: pg.Pool | pg.PoolClient, adminId: string, caseRef: string, lotId: number, amountKopecks: number,
  legalBasis: string, evidenceRef: string): Promise<boolean> {
  return (await admin.query<{ r: boolean }>('SELECT fn_settlement_lot_retain($1, $2, $3, $4, $5, $6) AS r',
    [adminId, caseRef, lotId, amountKopecks, legalBasis, evidenceRef])).rows[0]!.r;
}

/** OWNER (refund.execute): the split of a contradicted refund (to the lot, reversed retentions, over-refund). */
export async function resolveRefundContradiction(admin: pg.Pool | pg.PoolClient, adminId: string, caseRef: string, reason: string,
  decision?: 'CLAIM' | 'WRITE_OFF'): Promise<{ toLot: number; retentionReversed: number; overRefund: number }> {
  const r = (await admin.query<{ to_lot: string; retention_reversed: string; over_refund: string }>(
    'SELECT * FROM fn_refund_contradiction_resolve($1, $2, $3, $4)', [adminId, caseRef, reason, decision ?? null])).rows[0]!;
  return { toLot: Number(r.to_lot), retentionReversed: Number(r.retention_reversed), overRefund: Number(r.over_refund) };
}
