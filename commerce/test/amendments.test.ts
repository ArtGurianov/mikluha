// Track A / A2b-3a for TOUR-79 (migration 0027): purchase amendments, money lots, lot-based settlement and
// contradicted refunds. Real PostgreSQL, production roles; synthetic bank evidence only. Acceptance of
// docs/plans/2026-11-07-a2b-3-purchase-amendments-contract.md §10 and OWNER decisions Q2–Q6 of 07.11.2026.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';

import { createUser } from '../src/admin/operator.js';
import { closeDueAmendments, consentToAmendment, openSettlementRefund, proposeParticipantReplacement, proposeTicketTypeCorrection,
  recordCancellation, rejectAmendment, resolveRefundContradiction, retainSettlementLot, withdrawAmendment } from '../src/amendments.js';
import { currentTermsOf, openCollection, purchaseMoney, recordBankEvidence, type PaymentPurpose } from '../src/bank-operations.js';
import type { Catalog } from '../src/catalog.js';
import { issueCheckoutIntent, openCheckoutSession } from '../src/checkout-session.js';
import { maintain, setSalesOpen, type OrderDeps } from '../src/orders.js';
import { reserveNativePurchase } from '../src/purchases.js';
import { fixtureCatalog, freshDb, resetOrders, seedCatalog, type TestDb } from './helpers.js';

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const SLUG = 'altai-amend';
const RUB = 100;
const CHILD = 20_000 * RUB;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(24).toString('base64url');

let db: TestDb;
let catalog: Catalog;
let adult: number;
let departureId: string;
const staff: Record<'owner' | 'manager', string> = { owner: '', manager: '' };
type Tickets = { adults: number; teens: number; children: number };

async function publish(extra: Record<string, unknown>) {
  const draft = (await db.owner.query('SELECT revision, document FROM departure_draft WHERE departure_id = $1', [departureId])).rows[0];
  const document = { ...draft.document, ...extra };
  const revision = (await db.admin.query('SELECT fn_save_departure_draft($1, $2, $3, $4) AS r', [departureId, draft.revision, document, 'fixture'])).rows[0].r;
  const published = (await db.owner.query('SELECT published_version AS v FROM departure WHERE id = $1', [departureId])).rows[0].v;
  await db.publisher.query('SELECT fn_publish_departure($1, $2, $3, $4)', [departureId, revision, published, 'owner-publication']);
}
const deps = (): OrderDeps => ({ pool: db.pool, catalog, log: () => undefined, allowDemo: false });
async function buy(tickets: Tickets = { adults: 2, teens: 0, children: 0 }, groupLink?: { token: string; idempotencyKey: string }) {
  const s = await openCheckoutSession(db.pool);
  const intent = await issueCheckoutIntent(db.pool, s.token);
  assert.ok(intent.ok);
  const r = await reserveNativePurchase(deps(), {
    departureSlug: SLUG, buyer: { fullName: 'Анна Покупатель', phone: '+7 903 907-55-47', email: 'buyer@example.ru' }, tickets,
    ageTermsConfirmed: true, termsRef: catalog.terms.ref, termsHash: catalog.terms.hash, pdConsentConfirmed: true,
    pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash, session: { token: s.token }, checkoutIntent: { key: intent.key },
    ...(groupLink === undefined ? {} : { groupLink }) });
  assert.ok(r.ok, JSON.stringify(r));
  return { ...r, token: s.token };
}
let n = 0;
const bank = (ref: string, amount: number, observed: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED', source: 'CALLBACK' | 'READ_BACK' = 'CALLBACK') =>
  recordBankEvidence(db.pool, ref, { source, observed, provider: 'alfa', merchantAccount: 'mikluha-test',
    providerOperationId: `alfa-${ref}`, amountKopecks: amount, currency: 'RUB', payload: `p-${++n}` });
async function pay(p: { purchaseRef: string; token: string }, purpose: PaymentPurpose) {
  const r = await openCollection(db.pool, p.purchaseRef, p.token, 'alfa', 'mikluha-test', currentTermsOf(catalog), purpose);
  assert.ok(r.ok, JSON.stringify(r));
  const done = await bank(r.bankOperationRef, r.amountKopecks);
  assert.equal(done.status, 'SUCCEEDED');
  return r.bankOperationRef;
}
const seats = async (purchaseRef: string) => (await db.owner.query(`SELECT m.seat_slot_ref, m.state, m.ticket_type, m.line_status,
    m.price_kopecks::bigint AS price, m.net_kopecks::bigint AS net, m.balance_due_kopecks::bigint AS due
    FROM seat_money m JOIN seat_slot s ON s.id = m.seat_slot_id WHERE m.purchase_ref = $1 ORDER BY s.position`, [purchaseRef])).rows
  .map((r) => ({ ...r, price: Number(r.price), net: Number(r.net), due: Number(r.due) }));
const holding = async (seatRef: string, opRef: string) => Number((await db.owner.query(`SELECT fn_seat_lot_holding(s.id, b.id) AS h
  FROM seat_slot s, bank_operation b WHERE s.seat_slot_ref = $1 AND b.bank_operation_ref = $2`, [seatRef, opRef])).rows[0].h);
const revisionOf = async (purchaseRef: string) => (await db.owner.query(`SELECT r.revision, r.basis, r.seats, r.total_kopecks::bigint AS total,
    r.balance_due_at FROM purchase p JOIN purchase_revision r ON r.purchase_id = p.id AND r.revision = p.current_revision
   WHERE p.purchase_ref = $1`, [purchaseRef])).rows[0];
const amendment = async (ref: string) => (await db.owner.query('SELECT state, closed_reason FROM purchase_amendment WHERE amendment_ref = $1', [ref])).rows[0];
const caseOf = async (caseRef: string) => (await db.owner.query(`SELECT k.id, k.reason, k.amount_kopecks::bigint AS amount, k.resolved_at,
    k.resolution, k.retention_allowed FROM bank_settlement_case k WHERE k.case_ref = $1`, [caseRef])).rows[0];
const lotsOf = async (caseRef: string) => (await db.owner.query(`SELECT l.id, s.seat_slot_ref, b.bank_operation_ref, l.amount_kopecks::bigint AS amount
    FROM settlement_case_lot l JOIN bank_settlement_case k ON k.id = l.case_id LEFT JOIN seat_slot s ON s.id = l.seat_slot_id
    JOIN bank_operation b ON b.id = l.source_operation_id WHERE k.case_ref = $1 ORDER BY l.id`, [caseRef])).rows
  .map((r) => ({ ...r, id: Number(r.id), amount: Number(r.amount) }));
const asSuperuser = async (sql: string, args: unknown[] = []) => {
  await db.owner.query('BEGIN');
  try {
    await db.owner.query('SET LOCAL session_replication_role = replica');
    await db.owner.query(sql, args);
    await db.owner.query('COMMIT');
  } catch (e) { await db.owner.query('ROLLBACK'); throw e; }
};
const correction = (a: { purchaseRef: string }, changes: { seatSlotRef: string; ticketType: 'AGE_0_13' | 'AGE_14_17' | 'AGE_18_PLUS' }[], key: string) =>
  proposeTicketTypeCorrection(db.admin, staff.manager, a.purchaseRef, changes, { reason: 'DOB in the questionnaire', idempotencyKey: key });
const cancel = (a: { purchaseRef: string }, refs: string[], key: string, initiator: 'BUYER' | 'ORGANIZER' = 'BUYER') =>
  recordCancellation(db.admin, staff.manager, a.purchaseRef, refs, { initiator, reason: 'buyer asked to cancel', evidenceRef: 'mail-4521', idempotencyKey: key });

/**
 * I-10 for every confirmed collection of the purchase: (А) destination, (Б) refunds, (В) current balance,
 * (Г) non-negativity, with the transient terms explicit.
 */
async function assertI10(purchaseRef: string) {
  const ops = (await db.owner.query(`SELECT b.id, b.bank_operation_ref, b.amount_kopecks::bigint AS amount,
      (b.application_due = 'SUCCEEDED' AND NOT EXISTS (SELECT 1 FROM bank_operation_application x WHERE x.bank_operation_id = b.id
         AND x.outcome = 'SUCCEEDED')) AS pending
    FROM bank_operation b JOIN purchase p ON p.id = b.purchase_id
   WHERE p.purchase_ref = $1 AND b.kind = 'COLLECTION' AND b.status = 'SUCCEEDED'`, [purchaseRef])).rows;
  for (const x of ops) {
    const q = async (sql: string) => Number((await db.owner.query(sql, [x.id])).rows[0].v);
    const amount = Number(x.amount);
    const alloc = await q('SELECT coalesce(sum(amount_kopecks), 0) AS v FROM seat_money_allocation WHERE bank_operation_id = $1');
    const pending = x.pending ? amount : 0;
    const assignedOut = amount - alloc - pending;
    assert.ok(assignedOut >= 0, `(А) ${x.bank_operation_ref}`);
    const refunds = await q(`SELECT coalesce(sum(amount_kopecks), 0) AS v FROM bank_operation WHERE refunds_operation_id = $1 AND status = 'SUCCEEDED'`);
    const rSeats = await q(`SELECT coalesce(sum(a.amount_kopecks), 0) AS v FROM bank_refund_allocation a JOIN bank_operation r ON r.id = a.refund_operation_id
      WHERE r.refunds_operation_id = $1 AND a.seat_slot_id IS NOT NULL`);
    const rOver = await q(`SELECT coalesce(sum(a.amount_kopecks), 0) AS v FROM bank_refund_allocation a JOIN bank_operation r ON r.id = a.refund_operation_id
      JOIN bank_settlement_case k ON k.id = a.settlement_case_id WHERE r.refunds_operation_id = $1 AND k.reason = 'REFUND_CONTRADICTED'`);
    const rOut = await q(`SELECT coalesce(sum(a.amount_kopecks), 0) AS v FROM bank_refund_allocation a JOIN bank_operation r ON r.id = a.refund_operation_id
      JOIN bank_settlement_case k ON k.id = a.settlement_case_id WHERE r.refunds_operation_id = $1 AND k.reason <> 'REFUND_CONTRADICTED'`);
    const rPending = refunds - rSeats - rOut - rOver;
    assert.ok(rPending >= 0, `(Б) ${x.bank_operation_ref}`);
    const holdings = (await db.owner.query(`SELECT fn_seat_lot_holding(s.id, $1) AS h FROM seat_slot s JOIN bank_operation b ON b.purchase_id = s.purchase_id
      WHERE b.id = $1`, [x.id])).rows.map((r) => Number(r.h));
    for (const h of holdings) assert.ok(h >= 0, `(Г) holding ≥ 0 for ${x.bank_operation_ref}`);
    const sumHolding = holdings.reduce((s, h) => s + h, 0);
    assert.equal(amount - refunds, sumHolding + pending + (assignedOut - rOut) - rPending - rOver, `(В) ${x.bank_operation_ref}`);
  }
}

before(async () => {
  db = await freshDb();
  catalog = fixtureCatalog([{ slug: SLUG, startsOn: day(30), endsOn: day(33), capacity: 12 }]);
  await seedCatalog(db, catalog);
  adult = catalog.departures.get(SLUG)!.priceKopecks!;
  departureId = (await db.owner.query('SELECT id FROM departure WHERE slug = $1', [SLUG])).rows[0].id;
  staff.owner = await createUser(db.adminOperator, 'amend-owner', 'OWNER', 'correct horse battery staple 42', 'test');
  staff.manager = await createUser(db.adminOperator, 'amend-manager', 'MANAGER', 'correct horse battery staple 43', 'test');
  await setSalesOpen(db.operator, true, 'test', 'open for the test');
  await publish({ minorTerms: { allowed: true, minAge: null, childPriceKopecks: CHILD } });
});
after(async () => { await db?.drop(); });
beforeEach(async () => { await resetOrders(db.owner); });

describe('Q2: a category correction needs the buyer consent to the recomputed hash', () => {
  test('a price decrease commits only on the buyer POST; overpayment is a lot of the newest collection', async () => {
    const a = await buy({ adults: 2, teens: 0, children: 0 });
    const x = await pay(a, 'FULL');
    const [s1] = await seats(a.purchaseRef);
    const p = await correction(a, [{ seatSlotRef: s1.seat_slot_ref, ticketType: 'AGE_0_13' }], 'corr-0001');
    assert.ok(p.ok);
    assert.equal((await revisionOf(a.purchaseRef)).revision, 1, 'no revision without the buyer');
    assert.deepEqual(await correction(a, [{ seatSlotRef: s1.seat_slot_ref, ticketType: 'AGE_0_13' }], 'corr-0001'), { ...p, replayed: true });
    assert.deepEqual(await correction(a, [{ seatSlotRef: s1.seat_slot_ref, ticketType: 'AGE_14_17' }], 'corr-0001'),
      { ok: false, refusal: 'IDEMPOTENCY_CONFLICT' });
    // Staff have no path to the consent; the service login has no proposal command.
    await assert.rejects(db.admin.query('SELECT * FROM fn_amendment_consent($1, $2, $3, $4)', [p.amendmentRef, p.candidateHash, null, null]),
      /permission denied/);
    await assert.rejects(db.pool.query('SELECT * FROM fn_amendment_propose_correction($1, $2, $3, $4, $5, $6, $7)',
      [staff.owner, a.purchaseRef, '[]', null, 'x', null, 'corr-0002']), /permission denied/);
    // Someone else's session cannot consent.
    const stranger = await openCheckoutSession(db.pool);
    assert.deepEqual(await consentToAmendment(db.pool, p.amendmentRef, p.candidateHash, { sessionToken: stranger.token }),
      { ok: false, refusal: 'PURCHASE_NOT_OWNED' });
    const c = await consentToAmendment(db.pool, p.amendmentRef, p.candidateHash, { sessionToken: a.token });
    assert.ok(c.ok && c.result === 'COMMITTED' && c.revision === 2, JSON.stringify(c));
    assert.deepEqual(await consentToAmendment(db.pool, p.amendmentRef, p.candidateHash, { sessionToken: a.token }),
      { ok: true, result: 'REPLAYED', consentRef: c.consentRef, revision: 2 });
    const rev = await revisionOf(a.purchaseRef);
    assert.deepEqual([rev.basis, rev.seats, Number(rev.total)], ['TICKET_TYPE_CORRECTION', 2, adult + CHILD]);
    const after = await seats(a.purchaseRef);
    assert.deepEqual(after.map((s) => [s.ticket_type, s.price, s.net, s.due]),
      [['AGE_0_13', CHILD, adult, 0], ['AGE_18_PLUS', adult, adult, 0]]);
    const k = (await db.owner.query(`SELECT case_ref FROM bank_settlement_case WHERE reason = 'AMENDMENT_OVERPAYMENT'`)).rows[0].case_ref;
    assert.deepEqual((await lotsOf(k)).map((l) => [l.seat_slot_ref, l.bank_operation_ref, l.amount]), [[s1.seat_slot_ref, x, adult - CHILD]]);
    assert.equal((await caseOf(k)).retention_allowed, false);
    await assertI10(a.purchaseRef);
    // Every revision hash recomputes from its row (0017/0021 unchanged, the amendment one with its new keys).
    const bad = (await db.owner.query(`SELECT r.revision FROM purchase_revision r JOIN purchase p ON p.id = r.purchase_id
      WHERE fn_purchase_revision_hash(p.purchase_ref, r) <> r.revision_hash`)).rows;
    assert.deepEqual(bad, []);
  });

  test('deposit only: a decrease leaves a smaller debt and no case; an increase raises the debt', async () => {
    const a = await buy({ adults: 1, teens: 0, children: 1 });
    await pay(a, 'DEPOSIT');
    const [s1, s2] = await seats(a.purchaseRef);
    const p = await correction(a, [{ seatSlotRef: s2.seat_slot_ref, ticketType: 'AGE_14_17' }], 'corr-up-01');
    assert.ok(p.ok);
    assert.equal((await consentToAmendment(db.pool, p.amendmentRef, p.candidateHash, { sessionToken: a.token })).ok, true);
    assert.deepEqual((await seats(a.purchaseRef)).map((s) => [s.price, s.due]), [[adult, adult - 5_000 * RUB], [adult, adult - 5_000 * RUB]]);
    assert.equal(Number((await db.owner.query(`SELECT count(*) AS n FROM bank_settlement_case`)).rows[0].n), 0);
    assert.equal(s1.ticket_type, 'AGE_18_PLUS');
    await assertI10(a.purchaseRef);
  });

  test('STALE and EXPIRED are returned as values and kept; another connection sees the closing', async () => {
    const a = await buy({ adults: 2, teens: 0, children: 0 });
    await pay(a, 'DEPOSIT');
    const [s1] = await seats(a.purchaseRef);
    const p = await correction(a, [{ seatSlotRef: s1.seat_slot_ref, ticketType: 'AGE_14_17' }], 'corr-stale');
    assert.ok(p.ok);
    // A payment between proposal and consent changes the money snapshot.
    await pay(a, 'BALANCE');
    assert.deepEqual(await consentToAmendment(db.pool, p.amendmentRef, p.candidateHash, { sessionToken: a.token }),
      { ok: true, result: 'STALE', consentRef: null, revision: null });
    assert.deepEqual(await amendment(p.amendmentRef), { state: 'CLOSED', closed_reason: 'STALE' });
    assert.equal((await revisionOf(a.purchaseRef)).revision, 1);
    assert.deepEqual(await consentToAmendment(db.pool, p.amendmentRef, p.candidateHash, { sessionToken: a.token }),
      { ok: true, result: 'NOT_OPEN', consentRef: null, revision: null });
    const q = await correction(a, [{ seatSlotRef: s1.seat_slot_ref, ticketType: 'AGE_14_17' }], 'corr-expire');
    assert.ok(q.ok);
    // Exactly 72 h, never past the planned end.
    const left = (q.expiresAt.getTime() - Date.now()) / 3_600_000;
    assert.ok(left > 71.9 && left <= 72, String(left));
    await asSuperuser(`UPDATE purchase_amendment SET expires_at = clock_timestamp() - interval '1 second' WHERE amendment_ref = $1`, [q.amendmentRef]);
    assert.deepEqual(await consentToAmendment(db.pool, q.amendmentRef, q.candidateHash, { sessionToken: a.token }),
      { ok: true, result: 'EXPIRED', consentRef: null, revision: null });
    assert.deepEqual(await amendment(q.amendmentRef), { state: 'CLOSED', closed_reason: 'EXPIRED' });
    // maintain() closes the next one; rejection and withdrawal close too.
    const r = await correction(a, [{ seatSlotRef: s1.seat_slot_ref, ticketType: 'AGE_14_17' }], 'corr-maint');
    assert.ok(r.ok);
    await asSuperuser(`UPDATE purchase_amendment SET expires_at = clock_timestamp() - interval '1 second' WHERE amendment_ref = $1`, [r.amendmentRef]);
    await maintain(db.pool, () => undefined);
    assert.deepEqual(await amendment(r.amendmentRef), { state: 'CLOSED', closed_reason: 'EXPIRED' });
    assert.equal(await closeDueAmendments(db.pool), 0);
    const w = await correction(a, [{ seatSlotRef: s1.seat_slot_ref, ticketType: 'AGE_14_17' }], 'corr-withd');
    assert.ok(w.ok);
    assert.deepEqual(await correction(a, [{ seatSlotRef: s1.seat_slot_ref, ticketType: 'AGE_14_17' }], 'corr-second'),
      { ok: false, refusal: 'AMENDMENT_ALREADY_OPEN' });
    assert.deepEqual(await withdrawAmendment(db.admin, staff.manager, w.amendmentRef, 'wrong seat'), { ok: true });
    const j = await correction(a, [{ seatSlotRef: s1.seat_slot_ref, ticketType: 'AGE_14_17' }], 'corr-reject');
    assert.ok(j.ok);
    assert.deepEqual(await rejectAmendment(db.pool, j.amendmentRef, { sessionToken: a.token }), { ok: true, result: 'REJECTED' });
    assert.equal((await revisionOf(a.purchaseRef)).revision, 1);
  });

  test('the one-time link consents; money in flight blocks proposal and consent; the minors rules of the departure apply', async () => {
    const a = await buy({ adults: 2, teens: 0, children: 0 });
    await pay(a, 'DEPOSIT');
    const [s1, s2] = await seats(a.purchaseRef);
    const inFlight = await openCollection(db.pool, a.purchaseRef, a.token, 'alfa', 'mikluha-test', currentTermsOf(catalog), 'BALANCE');
    assert.ok(inFlight.ok);
    assert.deepEqual(await correction(a, [{ seatSlotRef: s1.seat_slot_ref, ticketType: 'AGE_14_17' }], 'corr-inflt'),
      { ok: false, refusal: 'AMENDMENT_PAYMENT_IN_FLIGHT' });
    await bank(inFlight.bankOperationRef, inFlight.amountKopecks, 'FAILED');
    const link = token();
    const p = await proposeTicketTypeCorrection(db.admin, staff.manager, a.purchaseRef, [{ seatSlotRef: s2.seat_slot_ref, ticketType: 'AGE_14_17' }],
      { reason: 'DOB', idempotencyKey: 'corr-link1', linkToken: link });
    assert.ok(p.ok);
    const again = await openCollection(db.pool, a.purchaseRef, a.token, 'alfa', 'mikluha-test', currentTermsOf(catalog), 'BALANCE');
    assert.ok(again.ok);
    assert.deepEqual(await consentToAmendment(db.pool, p.amendmentRef, p.candidateHash, { linkToken: link }),
      { ok: false, refusal: 'AMENDMENT_PAYMENT_IN_FLIGHT' });
    assert.equal((await amendment(p.amendmentRef)).state, 'OPEN', 'a refusal that changes nothing keeps the proposal');
    await bank(again.bankOperationRef, again.amountKopecks, 'FAILED');
    assert.deepEqual(await consentToAmendment(db.pool, p.amendmentRef, p.candidateHash, { linkToken: token() }), { ok: false, refusal: 'PURCHASE_NOT_OWNED' });
    assert.equal((await consentToAmendment(db.pool, p.amendmentRef, p.candidateHash, { linkToken: link })).ok, true);
    await publish({ minorTerms: { allowed: true, minAge: 14, childPriceKopecks: null } });
    try {
      assert.deepEqual(await correction(a, [{ seatSlotRef: s1.seat_slot_ref, ticketType: 'AGE_0_13' }], 'corr-minage'),
        { ok: false, refusal: 'TICKET_TYPE_NOT_ALLOWED' });
    } finally { await publish({ minorTerms: { allowed: true, minAge: null, childPriceKopecks: CHILD } }); }
  });
});

describe('§5.8: one purchase from deposit to reconciliation; Q3 no offset of cancelled money', () => {
  test('deposit → balance → correction with a transfer keeping its source → cancellation → refunds and a retention → I-10', async () => {
    const a = await buy({ adults: 2, teens: 0, children: 1 });
    // Positions: A, C adults (1, 2), B child (3).
    const [sa, sc, sb] = await seats(a.purchaseRef);
    assert.deepEqual([sa.ticket_type, sc.ticket_type, sb.ticket_type], ['AGE_18_PLUS', 'AGE_18_PLUS', 'AGE_0_13']);
    const x1 = await pay(a, 'DEPOSIT');
    await assertI10(a.purchaseRef);
    const x2 = await pay(a, 'BALANCE');
    assert.deepEqual((await seats(a.purchaseRef)).map((s) => s.due), [0, 0, 0]);
    await assertI10(a.purchaseRef);
    // B is 15 (adult price), C is 12 (child price): one amendment, the buyer's consent.
    const p = await correction(a, [{ seatSlotRef: sb.seat_slot_ref, ticketType: 'AGE_14_17' }, { seatSlotRef: sc.seat_slot_ref, ticketType: 'AGE_0_13' }],
      'corr-58-01');
    assert.ok(p.ok);
    assert.equal((await consentToAmendment(db.pool, p.amendmentRef, p.candidateHash, { sessionToken: a.token })).ok, true);
    const moved = (await db.owner.query(`SELECT b.bank_operation_ref, f.seat_slot_ref AS f, t.seat_slot_ref AS t, x.amount_kopecks::bigint AS amount
      FROM seat_money_transfer x JOIN bank_operation b ON b.id = x.source_operation_id JOIN seat_slot f ON f.id = x.from_seat_slot_id
      JOIN seat_slot t ON t.id = x.to_seat_slot_id`)).rows.map((r) => [r.bank_operation_ref, r.f, r.t, Number(r.amount)]);
    assert.deepEqual(moved, [[x2, sc.seat_slot_ref, sb.seat_slot_ref, adult - CHILD]], 'from the newest intention, source kept');
    assert.deepEqual((await seats(a.purchaseRef)).map((s) => [s.price, s.net, s.due]), [[adult, adult, 0], [CHILD, CHILD, 0], [adult, adult, 0]]);
    assert.equal(Number((await db.owner.query('SELECT count(*) AS n FROM bank_settlement_case')).rows[0].n), 0, 'no overpayment left');
    await assertI10(a.purchaseRef);

    // Cancellation of C (voluntary): its money goes to CANCELLATION_SETTLEMENT, never to A or B (Q3).
    const c = await cancel(a, [sc.seat_slot_ref], 'cancel-58-1');
    assert.ok(c.ok && c.basis === 'PARTIAL_CANCELLATION' && c.caseRef !== null, JSON.stringify(c));
    const rev = await revisionOf(a.purchaseRef);
    assert.deepEqual([rev.revision, rev.seats, Number(rev.total)], [3, 2, 2 * adult]);
    assert.deepEqual((await seats(a.purchaseRef)).map((s) => [s.state, s.line_status]),
      [['CONFIRMED', 'ACTIVE'], ['CANCELLED', 'CANCELLED'], ['CONFIRMED', 'ACTIVE']]);
    const lots = await lotsOf(c.caseRef!);
    const lotX2 = lots.find((l) => l.bank_operation_ref === x2)!;
    const lotX1 = lots.find((l) => l.bank_operation_ref === x1)!;
    assert.equal(lotX1.amount + lotX2.amount, CHILD);
    assert.equal(lotX1.amount, 5_000 * RUB);
    await assert.rejects(db.owner.query(`INSERT INTO seat_money_transfer (amendment_id, source_operation_id, from_seat_slot_id, to_seat_slot_id, amount_kopecks)
      SELECT a.id, b.id, f.id, t.id, 100 FROM purchase_amendment a, bank_operation b, seat_slot f, seat_slot t
       WHERE a.amendment_ref = $1 AND b.bank_operation_ref = $2 AND f.seat_slot_ref = $3 AND t.seat_slot_ref = $4`,
      [c.amendmentRef, x1, sc.seat_slot_ref, sa.seat_slot_ref]), /SEAT_MONEY_SOURCE_CANCELLED/, 'no offset, even by the schema owner');
    for (const pool of [db.pool, db.admin]) {
      await assert.rejects(pool.query('INSERT INTO seat_money_transfer (amendment_id, source_operation_id, from_seat_slot_id, to_seat_slot_id, amount_kopecks) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1)'),
        /permission denied/);
    }
    // The 0022 commands cannot close or bypass the lots.
    for (const [resolution, refund] of [['OWNER_DECISION', null], ['REFUNDED', 'bo-00000000000000000000']] as const) {
      await assert.rejects(db.admin.query('SELECT fn_bank_settlement_resolve($1, $2, $3, $4, $5)', [staff.owner, c.caseRef, resolution, refund, 'close it']),
        /SETTLEMENT_CASE_LOT_BASED/);
    }
    await assert.rejects(db.owner.query(`UPDATE bank_settlement_case SET resolved_at = now(), resolved_by = 'x', resolution = 'OWNER_DECISION',
      resolution_reason = 'x' WHERE case_ref = $1`, [c.caseRef]), /SETTLEMENT_CASE_NOT_EXECUTED/);
    await assert.rejects(db.admin.query('SELECT fn_bank_refund_open($1, $2, $3, $4)', [staff.owner, x2, 100, 'direct']), /REFUND_SOURCE_UNDER_SETTLEMENT/);
    await assert.rejects(openSettlementRefund(db.admin, staff.manager, c.caseRef!, x2, lotX2.amount, 'refund'), /STAFF_FORBIDDEN/);
    // Limit 3: never beyond the lot.
    await assert.rejects(openSettlementRefund(db.admin, staff.owner, c.caseRef!, x2, lotX2.amount + 1, 'refund'), /REFUND_AMOUNT_INVALID/);
    const r1 = await openSettlementRefund(db.admin, staff.owner, c.caseRef!, x2, lotX2.amount, 'refund of C');
    await assert.rejects(openSettlementRefund(db.admin, staff.owner, c.caseRef!, x2, 1, 'again'), /REFUND_AMOUNT_INVALID/, 'reserved while in flight');
    assert.equal((await bank(r1, lotX2.amount)).status, 'SUCCEEDED');
    assert.equal(await holding(sc.seat_slot_ref, x2), 0);
    await assertI10(a.purchaseRef);
    // Retention 1 000 ₽ by the OWNER only; then the rest refunded; the case closes by itself.
    await assert.rejects(retainSettlementLot(db.admin, staff.manager, c.caseRef!, lotX1.id, 1_000 * RUB, 'expenses', 'act-17'), /STAFF_FORBIDDEN/);
    assert.equal(await retainSettlementLot(db.admin, staff.owner, c.caseRef!, lotX1.id, 1_000 * RUB, 'non-refundable expenses', 'act-17'), false);
    await assert.rejects(openSettlementRefund(db.admin, staff.owner, c.caseRef!, x1, 4_000 * RUB + 1, 'refund'), /REFUND_AMOUNT_INVALID/);
    const r2 = await openSettlementRefund(db.admin, staff.owner, c.caseRef!, x1, 4_000 * RUB, 'refund of C, rest');
    await bank(r2, 4_000 * RUB);
    const k = await caseOf(c.caseRef!);
    assert.ok(k.resolved_at !== null);
    assert.equal(k.resolution, 'OWNER_DECISION');
    assert.equal(await holding(sc.seat_slot_ref, x1), 1_000 * RUB, 'the retained money stays on the cancelled seat');
    const money = (await purchaseMoney(db.pool, a.purchaseRef))!;
    assert.deepEqual([money.totalKopecks, money.balanceDueKopecks], [2 * adult, 0]);
    await assertI10(a.purchaseRef);
  });

  test('a full termination by the organizer: no seats, nothing due, no retention; idempotent record', async () => {
    const a = await buy({ adults: 2, teens: 0, children: 0 });
    await pay(a, 'FULL');
    const refs = (await seats(a.purchaseRef)).map((s) => s.seat_slot_ref);
    const c = await cancel(a, refs, 'term-org-1', 'ORGANIZER');
    assert.ok(c.ok && c.basis === 'FULL_TERMINATION');
    assert.deepEqual(await cancel(a, refs, 'term-org-1', 'ORGANIZER'), { ...c, replayed: true });
    assert.deepEqual(await cancel(a, refs.slice(0, 1), 'term-org-1', 'ORGANIZER'), { ok: false, refusal: 'IDEMPOTENCY_CONFLICT' });
    const rev = await revisionOf(a.purchaseRef);
    assert.deepEqual([rev.basis, rev.seats, Number(rev.total)], ['FULL_TERMINATION', 0, 0]);
    assert.deepEqual(await openCollection(db.pool, a.purchaseRef, a.token, 'alfa', 'mikluha-test', currentTermsOf(catalog), 'BALANCE'),
      { ok: false, refusal: 'BALANCE_SETTLEMENT_PENDING' });
    const [lot] = await lotsOf(c.caseRef!);
    assert.equal((await caseOf(c.caseRef!)).retention_allowed, false);
    await assert.rejects(retainSettlementLot(db.admin, staff.owner, c.caseRef!, lot.id, 100, 'expenses', 'act-1'), /RETENTION_NOT_ALLOWED/);
    assert.deepEqual(await cancel(a, refs, 'term-org-2'), { ok: false, refusal: 'AMENDMENT_PURCHASE_TERMINATED' });
    const occupied = Number((await db.owner.query('SELECT fn_departure_taken_seats($1, now()) AS n', [SLUG])).rows[0].n);
    assert.equal(occupied, 0, 'the seats are free again');
    // A seat is cancelled only by its amendment revision, for every login.
    const b = await buy({ adults: 1, teens: 0, children: 0 });
    await pay(b, 'FULL');
    await assert.rejects(db.owner.query(`UPDATE seat_slot SET state = 'CANCELLED' WHERE purchase_id = (SELECT id FROM purchase WHERE purchase_ref = $1)`,
      [b.purchaseRef]), /SEAT_SLOT_TRANSITION_INVALID/);
  });
});

describe('§4.2: companions lose access on cancellation, role change and replacement', () => {
  test('in a purchase: 18+ → 14–17 revokes the companionship and the adult access; the person stays; 0–13 ↔ 14–17 revokes nothing', async () => {
    const a = await buy({ adults: 1, teens: 0, children: 1 });
    await pay(a, 'FULL');
    const [adultSeat, child] = await seats(a.purchaseRef);
    const companion = (await db.pool.query('SELECT fn_companion_assign_in_purchase($1, $2) AS r', [child.seat_slot_ref, adultSeat.seat_slot_ref])).rows[0].r;
    const participant = (await db.pool.query('SELECT fn_seat_participant_open($1) AS r', [adultSeat.seat_slot_ref])).rows[0].r;
    const self = (await db.pool.query('SELECT fn_seat_invitation_issue($1, $2, $3, $4) AS r', [adultSeat.seat_slot_ref, 'SELF', sha(token()), null])).rows[0].r;
    const p = await correction(a, [{ seatSlotRef: child.seat_slot_ref, ticketType: 'AGE_14_17' }], 'role-none1');
    assert.ok(p.ok);
    await consentToAmendment(db.pool, p.amendmentRef, p.candidateHash, { sessionToken: a.token });
    assert.equal((await db.owner.query('SELECT revoked_at FROM companion_assignment WHERE companion_ref = $1', [companion])).rows[0].revoked_at, null);
    const q = await correction(a, [{ seatSlotRef: adultSeat.seat_slot_ref, ticketType: 'AGE_14_17' }], 'role-lost1');
    assert.ok(q.ok, JSON.stringify(q));
    assert.equal((await consentToAmendment(db.pool, q.amendmentRef, q.candidateHash, { sessionToken: a.token })).ok, true, 'never MINORS_WITHOUT_ADULT');
    assert.equal((await db.owner.query('SELECT revoke_reason FROM companion_assignment WHERE companion_ref = $1', [companion])).rows[0].revoke_reason,
      'COMPANION_ROLE_LOST');
    assert.equal((await db.pool.query('SELECT fn_seat_invitation_live($1) AS ok', [self])).rows[0].ok, false);
    assert.equal((await db.owner.query('SELECT ended_at FROM seat_participant WHERE participant_ref = $1', [participant])).rows[0].ended_at, null,
      'the same person, corrected');
  });

  test('a group: cancelling the companion of another purchase revokes the child access; replacement revokes a buyer assignment', async () => {
    const a = await buy({ adults: 1, teens: 0, children: 0 });
    await pay(a, 'FULL');
    const [adultSeat] = await seats(a.purchaseRef);
    const participant = (await db.pool.query('SELECT fn_seat_participant_open($1) AS r', [adultSeat.seat_slot_ref])).rows[0].r;
    const group = (await db.owner.query(`SELECT g.purchase_group_ref FROM purchase p JOIN purchase_group_member m ON m.purchase_id = p.id
      JOIN purchase_group g ON g.id = m.group_id WHERE p.purchase_ref = $1`, [a.purchaseRef])).rows[0].purchase_group_ref;
    const lt = token();
    await db.admin.query('SELECT fn_group_link_issue($1, $2, $3, $4, $5, $6)', [staff.manager, group, sha(lt), 0, 0, 1]);
    const b = await buy({ adults: 0, teens: 0, children: 1 }, { token: lt, idempotencyKey: 'attempt-0001' });
    await pay(b, 'FULL');
    const [child] = await seats(b.purchaseRef);
    const companion = (await db.admin.query('SELECT fn_companion_assign_staff($1, $2, $3, $4) AS r', [staff.manager, child.seat_slot_ref, participant, 'parent']))
      .rows[0].r;
    const t = token();
    const invitation = (await db.pool.query('SELECT fn_seat_invitation_issue($1, $2, $3, $4) AS r', [child.seat_slot_ref, 'MINOR_VIA_COMPANION', sha(t), companion]))
      .rows[0].r;
    assert.equal((await db.pool.query('SELECT fn_seat_invitation_live($1) AS ok', [invitation])).rows[0].ok, true);
    const c = await cancel(a, [adultSeat.seat_slot_ref], 'cancel-comp');
    assert.ok(c.ok && c.basis === 'FULL_TERMINATION', JSON.stringify(c));
    assert.equal((await db.pool.query('SELECT fn_seat_invitation_live($1) AS ok', [invitation])).rows[0].ok, false);
    assert.equal((await db.pool.query('SELECT * FROM fn_seat_invitation_claimable($1)', [sha(t)])).rows.length, 0);
    assert.deepEqual((await seats(b.purchaseRef)).map((s) => s.state), ['CONFIRMED'], 'the child purchase is not cancelled');

    // Replacement of a companion assigned by the buyer (no participant ref on the assignment).
    const d = await buy({ adults: 1, teens: 0, children: 1 });
    await pay(d, 'FULL');
    const [dAdult, dChild] = await seats(d.purchaseRef);
    const buyerCompanion = (await db.pool.query('SELECT fn_companion_assign_in_purchase($1, $2) AS r', [dChild.seat_slot_ref, dAdult.seat_slot_ref])).rows[0].r;
    assert.deepEqual(await proposeParticipantReplacement(db.admin, staff.manager, d.purchaseRef, dAdult.seat_slot_ref, { reason: 'other parent', idempotencyKey: 'repl-none1' }),
      { ok: false, refusal: 'REPLACEMENT_NOT_NEEDED' });
    const dp = (await db.pool.query('SELECT fn_seat_participant_open($1) AS r', [dAdult.seat_slot_ref])).rows[0].r;
    const r = await proposeParticipantReplacement(db.admin, staff.manager, d.purchaseRef, dAdult.seat_slot_ref, { reason: 'other parent', idempotencyKey: 'repl-0001' });
    assert.ok(r.ok);
    assert.equal((await consentToAmendment(db.pool, r.amendmentRef, r.candidateHash, { sessionToken: d.token })).ok, true);
    assert.equal((await db.owner.query('SELECT end_reason FROM seat_participant WHERE participant_ref = $1', [dp])).rows[0].end_reason, 'REPLACED');
    assert.equal((await db.owner.query('SELECT revoke_reason FROM companion_assignment WHERE companion_ref = $1', [buyerCompanion])).rows[0].revoke_reason,
      'PARTICIPANT_REPLACED');
    assert.equal((await revisionOf(d.purchaseRef)).basis, 'PARTICIPANT_REPLACEMENT');
  });
});

describe('§5.5: contradicted refunds are settled against every recorded outcome of the lot', () => {
  async function cancelledLot() {
    const a = await buy({ adults: 2, teens: 0, children: 0 });
    const x = await pay(a, 'DEPOSIT');
    const [s1] = await seats(a.purchaseRef);
    const c = await cancel(a, [s1.seat_slot_ref], `cancel-${n}`);
    assert.ok(c.ok && c.caseRef !== null);
    const [lot] = await lotsOf(c.caseRef);
    return { a, x, caseRef: c.caseRef, lot };
  }
  const contradictionOf = async (refundRef: string) => (await db.owner.query(`SELECT k.case_ref FROM bank_settlement_case k
    JOIN bank_operation b ON b.id = k.bank_operation_id WHERE b.bank_operation_ref = $1 AND k.reason = 'REFUND_CONTRADICTED'`, [refundRef])).rows[0]?.case_ref;

  test('full retention, then the bank refunds after all: the retention is reversed; wrong splits are refused', async () => {
    const { a, x, caseRef, lot } = await cancelledLot();
    const r1 = await openSettlementRefund(db.admin, staff.owner, caseRef, x, lot.amount, 'refund');
    await bank(r1, lot.amount, 'FAILED');
    // A failure without a read-back still holds the lot.
    await assert.rejects(retainSettlementLot(db.admin, staff.owner, caseRef, lot.id, lot.amount, 'expenses', 'act-2'), /RETENTION_EXCEEDS/);
    await bank(r1, lot.amount, 'FAILED', 'READ_BACK');
    assert.equal(await retainSettlementLot(db.admin, staff.owner, caseRef, lot.id, lot.amount, 'expenses', 'act-2'), true, 'closed by its outcome');
    // The bank now confirms R1; its application fails: the fact, the contradiction case and the freeze all stand.
    await asSuperuser(`CREATE OR REPLACE FUNCTION fn_test_fail_refund_allocation() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$ LANGUAGE plpgsql`);
    await asSuperuser(`CREATE TRIGGER trg_test_fail BEFORE INSERT ON bank_operation_application FOR EACH ROW EXECUTE FUNCTION fn_test_fail_refund_allocation()`);
    let k: string;
    try {
      const late = await bank(r1, lot.amount);
      assert.deepEqual([late.status, late.applicationPending], ['SUCCEEDED', true]);
      k = await contradictionOf(r1);
      assert.ok(k, 'REFUND_CONTRADICTED with the bank fact');
      assert.ok((await caseOf(caseRef)).resolved_at !== null, 'the closed case stays closed');
      await assertI10(a.purchaseRef);
      await assert.rejects(openSettlementRefund(db.admin, staff.owner, caseRef, x, 1, 'again'), /SETTLEMENT_CASE_ALREADY_RESOLVED/);
      await assert.rejects(db.admin.query('SELECT fn_bank_refund_open($1, $2, $3, $4)', [staff.owner, x, 1, 'direct']), /REFUND_SOURCE_UNDER_SETTLEMENT/);
    } finally {
      await asSuperuser('DROP TRIGGER trg_test_fail ON bank_operation_application');
    }
    await maintain(db.pool, () => undefined);
    assert.equal((await db.owner.query('SELECT application_due FROM bank_operation WHERE bank_operation_ref = $1', [r1])).rows[0].application_due, null);
    for (const [resolution, refund] of [['OWNER_DECISION', null], ['REFUNDED', r1]] as const) {
      await assert.rejects(db.admin.query('SELECT fn_bank_settlement_resolve($1, $2, $3, $4, $5)', [staff.owner, k!, resolution, refund, 'close']),
        /REFUND_CONTRADICTED_REQUIRES_SPECIAL_RESOLUTION/);
    }
    await assert.rejects(db.owner.query(`UPDATE bank_settlement_case SET contradiction_to_lot = 0, contradiction_retention_reversed = 0,
      contradiction_over_refund = $2, contradiction_decision = 'WRITE_OFF', resolved_at = now(), resolved_by = 'x', resolution = 'OWNER_DECISION',
      resolution_reason = 'x' WHERE case_ref = $1`, [k!, lot.amount]), /REFUND_CONTRADICTION_OUTCOME_INVALID/, 'right total, wrong parts');
    assert.deepEqual(await resolveRefundContradiction(db.admin, staff.owner, k!, 'bank refunded after all'),
      { toLot: 0, retentionReversed: lot.amount, overRefund: 0 });
    assert.equal(await holding((await lotsOf(caseRef))[0].seat_slot_ref, x), 0);
    await assertI10(a.purchaseRef);
  });

  test('R2 refunded, then the late success of R1: an over-refund on the OWNER decision', async () => {
    const { a, x, caseRef, lot } = await cancelledLot();
    const r1 = await openSettlementRefund(db.admin, staff.owner, caseRef, x, lot.amount, 'refund');
    await bank(r1, lot.amount, 'FAILED', 'READ_BACK');
    const r2 = await openSettlementRefund(db.admin, staff.owner, caseRef, x, lot.amount, 'refund again');
    await bank(r2, lot.amount);
    assert.ok((await caseOf(caseRef)).resolved_at !== null);
    await bank(r1, lot.amount);
    const k = await contradictionOf(r1);
    assert.ok(k);
    await assertI10(a.purchaseRef);
    await assert.rejects(resolveRefundContradiction(db.admin, staff.owner, k, 'double refund'), /REFUND_CONTRADICTION_DECISION_REQUIRED/);
    assert.deepEqual(await resolveRefundContradiction(db.admin, staff.owner, k, 'double refund', 'CLAIM'),
      { toLot: 0, retentionReversed: 0, overRefund: lot.amount });
    await assertI10(a.purchaseRef);
  });
});

describe('§5.6: debt deadlines are frozen in the revision', () => {
  test('moving the departure does not move an accepted purchase deadline; an amendment keeps it', async () => {
    const a = await buy({ adults: 1, teens: 0, children: 0 });
    await pay(a, 'DEPOSIT');
    const before = (await purchaseMoney(db.pool, a.purchaseRef))!.balanceDueAt.getTime();
    await asSuperuser('UPDATE departure SET starts_on = starts_on + 5, ends_on = ends_on + 5 WHERE id = $1', [departureId]);
    try {
      assert.equal((await purchaseMoney(db.pool, a.purchaseRef))!.balanceDueAt.getTime(), before);
    } finally { await asSuperuser('UPDATE departure SET starts_on = starts_on - 5, ends_on = ends_on - 5 WHERE id = $1', [departureId]); }
    const [s1] = await seats(a.purchaseRef);
    const p = await correction(a, [{ seatSlotRef: s1.seat_slot_ref, ticketType: 'AGE_14_17' }], 'dead-0001');
    assert.ok(p.ok);
    await consentToAmendment(db.pool, p.amendmentRef, p.candidateHash, { sessionToken: a.token });
    assert.equal(new Date((await revisionOf(a.purchaseRef)).balance_due_at).getTime(), before);
  });
});

describe('§7.3: concurrency under real locks', () => {
  test('two tabs consent at once: one revision, the other a replay of the same consent', async () => {
    const a = await buy({ adults: 2, teens: 0, children: 0 });
    await pay(a, 'DEPOSIT');
    const [s1] = await seats(a.purchaseRef);
    const p = await correction(a, [{ seatSlotRef: s1.seat_slot_ref, ticketType: 'AGE_14_17' }], 'tabs-0001');
    assert.ok(p.ok);
    const [x, y] = await Promise.all([consentToAmendment(db.pool, p.amendmentRef, p.candidateHash, { sessionToken: a.token }),
      consentToAmendment(db.pool, p.amendmentRef, p.candidateHash, { sessionToken: a.token })]);
    assert.ok(x.ok && y.ok);
    assert.deepEqual([x.result, y.result].sort(), ['COMMITTED', 'REPLAYED']);
    assert.equal(x.consentRef, y.consentRef);
    assert.equal((await revisionOf(a.purchaseRef)).revision, 2);
  });

  for (const first of ['refund', 'cancellation'] as const) {
    test(`a 0022 refund and a cancellation of the seat it paid, ${first} first: never both on the same money`, async () => {
      const a = await buy({ adults: 2, teens: 0, children: 0 });
      const x = await pay(a, 'FULL');
      const [s1] = await seats(a.purchaseRef);
      const holder = await db.admin.connect();
      try {
        await holder.query('BEGIN');
        if (first === 'refund') await holder.query('SELECT fn_bank_refund_open($1, $2, $3, $4)', [staff.owner, x, 1_000 * RUB, 'goodwill']);
        else await holder.query('SELECT * FROM fn_amendment_record_cancellation($1, $2, $3, $4, $5, $6, $7)',
          [staff.manager, a.purchaseRef, [s1.seat_slot_ref], 'BUYER', 'buyer asked', 'mail-1', 'race-cancel-1']);
        let settled = false;
        const other = (first === 'refund' ? cancel(a, [s1.seat_slot_ref], 'race-cancel-2')
          : db.admin.query('SELECT fn_bank_refund_open($1, $2, $3, $4)', [staff.owner, x, 1_000 * RUB, 'goodwill']).then(() => 'opened', (e: Error) => e.message))
          .finally(() => { settled = true; });
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(settled, false, 'the second waits on the purchase locks');
        await holder.query('COMMIT');
        if (first === 'refund') assert.deepEqual(await other, { ok: false, refusal: 'AMENDMENT_PAYMENT_IN_FLIGHT' });
        else assert.equal(await other, 'REFUND_SOURCE_UNDER_SETTLEMENT');
      } finally { holder.release(); }
    });
  }
});
