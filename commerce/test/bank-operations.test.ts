// Track A / A2b-1 for TOUR-77 (migration 0022): the bank operation registry. Real PostgreSQL,
// production roles. Synthetic evidence only: no provider, no money (contract §14).
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import { applyDueBankOperations, openCollection, pendingBankOperations, recordBankEvidence, type BankEvidence } from '../src/bank-operations.js';
import { createUser } from '../src/admin/operator.js';
import { issueCheckoutIntent, openCheckoutSession } from '../src/checkout-session.js';
import type { Catalog } from '../src/catalog.js';
import { maintain, setSalesOpen, type OrderDeps } from '../src/orders.js';
import { reserveNativePurchase, retryNativePurchasePayment, type NativePurchaseRequest } from '../src/purchases.js';
import { fixtureCatalog, freshDb, resetOrders, seedCatalog, type TestDb } from './helpers.js';

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const SLUG = 'altai-bank';
const PROVIDER = 'alfa';
const ACCOUNT = 'mikluha-test';

let db: TestDb;
let catalog: Catalog;
let adult: number;
const staff = { owner: '', manager: '' };

const deps = (): OrderDeps => ({ pool: db.pool, catalog, log: () => undefined, allowDemo: false });
const sessions = new Map<string, string>();
const sessionOf = (purchaseRef: string) => sessions.get(purchaseRef)!;
async function buy(adults = 1) {
  const s = await openCheckoutSession(db.pool);
  const intent = await issueCheckoutIntent(db.pool, s.token);
  assert.ok(intent.ok);
  const req: NativePurchaseRequest = { session: { token: s.token }, checkoutIntent: { key: intent.key },
    departureSlug: SLUG, buyer: { fullName: 'Анна Покупатель', phone: '+7 903 907-55-47', email: 'buyer@example.ru' },
    tickets: { adults, teens: 0, children: 0 }, ageTermsConfirmed: true, termsRef: catalog.terms.ref, termsHash: catalog.terms.hash,
    pdConsentConfirmed: true, pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash };
  const r = await reserveNativePurchase(deps(), req);
  assert.ok(r.ok, JSON.stringify(r));
  sessions.set(r.purchaseRef, s.token);
  return r as Extract<typeof r, { ok: true }>;
}
async function open(purchaseRef: string) {
  const r = await openCollection(db.pool, purchaseRef, sessionOf(purchaseRef), PROVIDER, ACCOUNT);
  assert.ok(r.ok, JSON.stringify(r));
  return r as Extract<typeof r, { ok: true }>;
}
let n = 0;
/** A matching answer of the bank about the operation; override any field. */
const says = (ref: string, amount: number, over: Partial<BankEvidence> = {}) => recordBankEvidence(db.pool, ref, {
  source: 'CALLBACK', observed: 'SUCCEEDED', provider: PROVIDER, merchantAccount: ACCOUNT, providerOperationId: `alfa-${ref}`,
  amountKopecks: amount, currency: 'RUB', payload: `payload-${++n}`, ...over });
const states = async (purchaseRef: string) => (await db.owner.query(
  'SELECT state FROM seat_slot_current WHERE purchase_ref = $1 ORDER BY position', [purchaseRef])).rows.map((r) => r.state);
const op = async (ref: string) => (await db.owner.query('SELECT * FROM bank_operation WHERE bank_operation_ref = $1', [ref])).rows[0];
const count = async (sql: string, values: unknown[] = []) => Number((await db.owner.query(sql, values)).rows[0].n);
const orderStatus = async (orderRef: string) => (await db.owner.query('SELECT status FROM orders WHERE order_ref = $1', [orderRef])).rows[0].status;
async function asOwnerWithoutTriggers(sql: string, values: unknown[]) {
  await db.owner.query('BEGIN');
  try {
    await db.owner.query('SET LOCAL session_replication_role = replica');
    await db.owner.query(sql, values);
    await db.owner.query('COMMIT');
  } catch (e) { await db.owner.query('ROLLBACK'); throw e; }
}
const ageRetryWindow = (purchaseRef: string) => asOwnerWithoutTriggers(
  "UPDATE purchase SET created_at = created_at - interval '25 hours' WHERE purchase_ref = $1", [purchaseRef]);

before(async () => {
  db = await freshDb();
  catalog = fixtureCatalog([{ slug: SLUG, startsOn: day(30), endsOn: day(33), capacity: 4 }]);
  await seedCatalog(db, catalog);
  adult = catalog.departures.get(SLUG)!.priceKopecks;
  staff.owner = await createUser(db.adminOperator, 'bank-owner', 'OWNER', 'correct horse battery staple 42', 'test');
  staff.manager = await createUser(db.adminOperator, 'bank-manager', 'MANAGER', 'correct horse battery staple 42', 'test');
  await setSalesOpen(db.operator, true, 'test', 'open for the test');
});
after(async () => { await db?.drop(); });
beforeEach(async () => { await resetOrders(db.owner); });

describe('A2b-1: one identity per payment cycle, recorded before the bank', () => {
  test('opening records the operation and fences the cycle; a repeat returns the same operation', async () => {
    const a = await buy(2);
    const first = await open(a.purchaseRef);
    assert.match(first.bankOperationRef, /^bo-[0-9a-f]{20}$/);
    assert.deepEqual([first.amountKopecks, first.currency, first.replayed], [2 * adult, 'RUB', false]);
    const again = await open(a.purchaseRef);
    assert.deepEqual([again.bankOperationRef, again.holdRef, again.replayed], [first.bankOperationRef, first.holdRef, true]);
    assert.deepEqual(await openCollection(db.pool, a.purchaseRef, sessionOf(a.purchaseRef), 'sbp', ACCOUNT), { ok: false, refusal: 'HOLD_ALREADY_FENCED' });
    const hold = (await db.owner.query('SELECT attempt_ref, fenced_at FROM seat_hold WHERE hold_ref = $1', [first.holdRef])).rows[0];
    assert.equal(hold.attempt_ref, first.bankOperationRef);
    assert.ok(hold.fenced_at);
    assert.equal(await count('SELECT count(*) AS n FROM bank_operation'), 1);
    const [pending] = await pendingBankOperations(db.pool);
    assert.deepEqual([pending!.bankOperationRef, pending!.status, pending!.readBackDue], [first.bankOperationRef, 'INTENDED', false]);
  });

  test('registration starts the bank window; the same evidence twice is one fact', async () => {
    const a = await buy();
    const { bankOperationRef: ref } = await open(a.purchaseRef);
    const reg = { source: 'REGISTRATION_RESPONSE', observed: 'REGISTERED', amountKopecks: undefined, currency: undefined, payload: 'reg-1' } as const;
    const r1 = await says(ref, adult, reg);
    assert.deepEqual([r1.status, r1.effect, r1.replayed], ['REGISTERED', 'STATUS_CHANGED', false]);
    const r2 = await says(ref, adult, reg);
    assert.deepEqual([r2.status, r2.effect, r2.replayed], ['REGISTERED', 'STATUS_CHANGED', true]);
    const o = await op(ref);
    assert.equal(o.provider_operation_id, `alfa-${ref}`);
    assert.equal(o.bank_expires_at.getTime() - o.registered_at.getTime(), 1_800_000);
    assert.equal(await count('SELECT count(*) AS n FROM bank_operation_evidence'), 1);
    // The bank's window passed without an answer: the read-back is due, the seats stay protected.
    await asOwnerWithoutTriggers(`UPDATE bank_operation SET registered_at = registered_at - interval '31 minutes',
      bank_expires_at = bank_expires_at - interval '31 minutes' WHERE bank_operation_ref = $1`, [ref]);
    assert.equal((await pendingBankOperations(db.pool))[0]!.readBackDue, true);
    assert.deepEqual(await states(a.purchaseRef), ['HELD']);
  });
});

describe('A2b-1: UNKNOWN, read-back and the outcome', () => {
  test('UNKNOWN keeps the seats, forbids a new cycle and the closure; a proven failure then allows a retry', async () => {
    const a = await buy(2);
    const { bankOperationRef: ref } = await open(a.purchaseRef);
    const unknown = await says(ref, 2 * adult, { source: 'DISPATCH_ERROR', observed: 'UNKNOWN', provider: undefined, merchantAccount: undefined,
      providerOperationId: undefined, amountKopecks: undefined, currency: undefined });
    assert.deepEqual([unknown.status, unknown.effect], ['UNKNOWN', 'STATUS_CHANGED']);
    assert.deepEqual(await retryNativePurchasePayment(deps(), a.purchaseRef, sessionOf(a.purchaseRef)), { ok: false, refusal: 'REHOLD_NOT_ALLOWED' });
    await ageRetryWindow(a.purchaseRef);
    await maintain(db.pool, () => undefined, new Date(Date.now() + 3 * 3_600_000));
    assert.deepEqual([await orderStatus(a.orderRef), ...(await states(a.purchaseRef))], ['RESERVED', 'HELD', 'HELD']);
    assert.equal((await pendingBankOperations(db.pool))[0]!.readBackDue, true);
    // A transport error proves nothing final; only the bank's own answer does.
    await assert.rejects(says(ref, 2 * adult, { source: 'DISPATCH_ERROR', observed: 'FAILED' }), /BANK_EVIDENCE_INVALID/);
    await assert.rejects(says(ref, 2 * adult, { source: 'REGISTRATION_RESPONSE', observed: 'SUCCEEDED' }), /BANK_EVIDENCE_INVALID/);
    const failedRb = await says(ref, 2 * adult, { source: 'READ_BACK', observed: 'FAILED' });
    assert.deepEqual([failedRb.status, failedRb.seatEffect], ['FAILED', 'SEATS_RELEASED']);
    assert.deepEqual(await states(a.purchaseRef), ['RELEASED', 'RELEASED']);
  });

  test('evidence about something else changes nothing and opens one case', async () => {
    const a = await buy();
    const b = await buy();
    const { bankOperationRef: ref } = await open(a.purchaseRef);
    const { bankOperationRef: other } = await open(b.purchaseRef);
    await says(other, adult, { source: 'REGISTRATION_RESPONSE', observed: 'REGISTERED', providerOperationId: 'alfa-order-b' });
    for (const over of [{ amountKopecks: adult - 1 }, { currency: 'USD' }, { merchantAccount: 'someone-else' }, { provider: 'sbp' },
      { providerOperationId: 'alfa-order-b' }, { providerOperationId: undefined }] as Partial<BankEvidence>[]) {
      const r = await says(ref, adult, over);
      assert.deepEqual([r.status, r.effect, r.seatEffect], ['INTENDED', 'EVIDENCE_MISMATCH', null], JSON.stringify(over));
    }
    assert.deepEqual(await states(a.purchaseRef), ['HELD']);
    assert.equal(await count("SELECT count(*) AS n FROM bank_settlement_case WHERE reason = 'EVIDENCE_MISMATCH'"), 1);
    assert.equal(await count('SELECT count(*) AS n FROM bank_operation_evidence WHERE NOT matches'), 6);
    const ok = await says(ref, adult);
    assert.deepEqual([ok.status, ok.seatEffect, ok.confirmed], ['SUCCEEDED', 'SEATS_CONFIRMED', 1]);
  });

  test('concurrent duplicate callbacks: one status change, one application, one case', async () => {
    const a = await buy();
    const late = (await open(a.purchaseRef)).bankOperationRef;
    await says(late, adult, { observed: 'FAILED' });
    const b = await buy(4);
    await says((await open(b.purchaseRef)).bankOperationRef, 4 * adult);
    // A late success with no room left: PAID_NO_SEAT, delivered three times at once (two identical).
    const results = await Promise.all([says(late, adult, { payload: 'dup' }), says(late, adult, { payload: 'dup' }), says(late, adult)]);
    assert.equal(results.filter((r) => r.effect === 'STATUS_CHANGED' && !r.replayed).length, 1);
    assert.ok(results.every((r) => r.status === 'SUCCEEDED' && r.seatEffect === 'PAID_NO_SEAT'));
    assert.deepEqual(await states(a.purchaseRef), ['PAID_NO_SEAT_EXCEPTION']);
    assert.equal(await count('SELECT count(*) AS n FROM bank_operation_evidence WHERE bank_operation_id = (SELECT id FROM bank_operation WHERE bank_operation_ref = $1)', [late]), 3);
    assert.equal(await count("SELECT count(*) AS n FROM bank_operation_application WHERE outcome = 'SUCCEEDED' AND seat_effect = 'PAID_NO_SEAT'"), 1);
    assert.equal(await count("SELECT count(*) AS n FROM bank_settlement_case WHERE reason = 'PAID_NO_SEAT'"), 1);
    assert.equal((await op(late)).contradicted_at instanceof Date, true, 'a failure, then a success: recorded as contradicted');
  });
});

describe('A2b-1: money the seats cannot absorb stays a fact (G-LATE-CLOSED, NEWER_CYCLE_EXISTS)', () => {
  test('a double collection keeps the purchase open until the case is settled', async () => {
    const a = await buy();
    const first = (await open(a.purchaseRef)).bankOperationRef;
    await says(first, adult, { observed: 'FAILED' });
    assert.equal((await retryNativePurchasePayment(deps(), a.purchaseRef, sessionOf(a.purchaseRef))).ok, true);
    const second = (await open(a.purchaseRef)).bankOperationRef;
    await says(second, adult, { observed: 'FAILED' });
    const late = await says(first, adult);
    assert.deepEqual([late.status, late.seatEffect], ['SUCCEEDED', 'NEWER_CYCLE_EXISTS']);
    assert.deepEqual(await states(a.purchaseRef), ['RELEASED']);
    await ageRetryWindow(a.purchaseRef);
    await maintain(db.pool, () => undefined);
    assert.equal(await orderStatus(a.orderRef), 'RESERVED', 'confirmed money with an open case is never closed by the window');
    const caseRef = late.settlementCaseRef!;
    await assert.rejects(db.admin.query('SELECT fn_bank_settlement_resolve($1, $2, $3, $4, $5)', [staff.manager, caseRef, 'OWNER_DECISION', null, 'x']),
      /STAFF_FORBIDDEN: refund.execute/);
    await assert.rejects(db.admin.query('SELECT fn_bank_refund_open($1, $2, $3, $4)', [staff.manager, first, adult, 'x']), /STAFF_FORBIDDEN/);
    await assert.rejects(db.admin.query('SELECT fn_bank_refund_open($1, $2, $3, $4)', [staff.owner, second, adult, 'x']), /REFUND_SOURCE_INVALID/);
    await assert.rejects(db.admin.query('SELECT fn_bank_refund_open($1, $2, $3, $4)', [staff.owner, first, adult + 1, 'x']), /REFUND_AMOUNT_INVALID/);
    const refund = (await db.admin.query('SELECT fn_bank_refund_open($1, $2, $3, $4) AS r', [staff.owner, first, adult, 'double collection'])).rows[0].r;
    await assert.rejects(db.admin.query('SELECT fn_bank_refund_open($1, $2, $3, $4)', [staff.owner, first, 1, 'x']), /REFUND_AMOUNT_INVALID/,
      'refunds not proven failed count against the collected money');
    await assert.rejects(db.admin.query('SELECT fn_bank_settlement_resolve($1, $2, $3, $4, $5)', [staff.owner, caseRef, 'REFUNDED', refund, 'x']),
      /REFUND_NOT_CONFIRMED/);
    const refunded = await says(refund, adult);
    assert.deepEqual([refunded.status, refunded.seatEffect], ['SUCCEEDED', null], 'a refund changes no seat');
    await db.admin.query('SELECT fn_bank_settlement_resolve($1, $2, $3, $4, $5)', [staff.owner, caseRef, 'REFUNDED', refund, 'refunded in full']);
    await assert.rejects(db.admin.query('SELECT fn_bank_settlement_resolve($1, $2, $3, $4, $5)', [staff.owner, caseRef, 'OWNER_DECISION', null, 'x']),
      /SETTLEMENT_CASE_ALREADY_RESOLVED/);
    await maintain(db.pool, () => undefined);
    assert.equal(await orderStatus(a.orderRef), 'EXPIRED');
    assert.equal(await count('SELECT count(*) AS n FROM bank_settlement_open'), 0);
  });

  test('a late success after closure is kept once and settled by the owner; a repeated callback adds nothing', async () => {
    const a = await buy();
    const ref = (await open(a.purchaseRef)).bankOperationRef;
    await says(ref, adult, { observed: 'FAILED' });
    await ageRetryWindow(a.purchaseRef);
    await maintain(db.pool, () => undefined);
    assert.equal(await orderStatus(a.orderRef), 'EXPIRED');
    const late = await says(ref, adult, { payload: 'late' });
    assert.deepEqual([late.status, late.seatEffect], ['SUCCEEDED', 'PURCHASE_CLOSED_LATE_PAYMENT']);
    const again = await says(ref, adult, { payload: 'late' });
    assert.deepEqual([again.replayed, again.settlementCaseRef], [true, late.settlementCaseRef]);
    await says(ref, adult, { source: 'READ_BACK' });
    assert.equal(await count('SELECT count(*) AS n FROM bank_settlement_case'), 1);
    assert.deepEqual(await states(a.purchaseRef), ['RELEASED']);
    const open_ = (await db.admin.query('SELECT case_ref, reason, purchase_ref FROM bank_settlement_open')).rows;
    assert.deepEqual(open_, [{ case_ref: late.settlementCaseRef, reason: 'PURCHASE_CLOSED_LATE_PAYMENT', purchase_ref: a.purchaseRef }]);
    await db.admin.query('SELECT fn_bank_settlement_resolve($1, $2, $3, $4, $5)', [staff.owner, late.settlementCaseRef, 'OWNER_DECISION', null, 'kept per owner']);
  });
});

describe('review of PR #87: a refund settles only what it returned (TOUR-27)', () => {
  test('1 kopeck does not settle a seat; one refund is not allocated beyond its amount; another collection\'s refund does not fit', async () => {
    const a = await buy(2);
    const late = (await open(a.purchaseRef)).bankOperationRef;
    await says(late, 2 * adult, { observed: 'FAILED' });
    const b = await buy(4);
    const paidB = (await open(b.purchaseRef)).bankOperationRef;
    await says(paidB, 4 * adult);
    const noSeat = await says(late, 2 * adult);
    assert.deepEqual([noSeat.seatEffect, noSeat.noSeat], ['PAID_NO_SEAT', 2]);
    const [s1, s2] = (await db.owner.query('SELECT seat_slot_ref FROM seat_slot_current WHERE purchase_ref = $1 ORDER BY position',
      [a.purchaseRef])).rows.map((r) => r.seat_slot_ref);
    const refund = async (collection: string, amount: number) => {
      const ref = (await db.admin.query('SELECT fn_bank_refund_open($1, $2, $3, $4) AS r', [staff.owner, collection, amount, 'no seat'])).rows[0].r;
      await says(ref, amount);
      return ref as string;
    };
    const settle = (slot: string, ref: string) => db.pool.query('SELECT fn_seat_slot_refund_settled($1, $2)', [slot, ref]);
    const tiny = await refund(late, 1);
    await assert.rejects(settle(s1!, tiny), /REFUND_INSUFFICIENT/, '1 kopeck does not settle a seat of the adult price');
    const one = await refund(late, adult);
    await settle(s1!, one);
    await assert.rejects(settle(s2!, one), /REFUND_INSUFFICIENT/, 'the same refund is not allocated twice beyond its amount');
    await assert.rejects(settle(s1!, one), /SEAT_SLOT_TRANSITION_INVALID/);
    // A refund of another purchase's collection never settles this seat.
    const foreign = await refund(paidB, adult);
    await assert.rejects(settle(s2!, foreign), /REFUND_NOT_CONFIRMED/);
    // The PAID_NO_SEAT case is REFUNDED only once every seat it is about was settled by its own allocation.
    await assert.rejects(db.admin.query('SELECT fn_bank_settlement_resolve($1, $2, $3, $4, $5)',
      [staff.owner, noSeat.settlementCaseRef, 'REFUNDED', one, 'x']), /REFUND_INSUFFICIENT/);
    await assert.rejects(refund(late, adult), /REFUND_AMOUNT_INVALID/, '1 + adult + adult would exceed the two seats collected');
    await assert.rejects(settle(s2!, tiny), /REFUND_INSUFFICIENT/);
    const second = await refund(late, adult - 1);
    await assert.rejects(settle(s2!, second), /REFUND_INSUFFICIENT/);
    assert.deepEqual(await states(a.purchaseRef), ['REFUND_SETTLED', 'PAID_NO_SEAT_EXCEPTION']);
    const allocated = (await db.owner.query('SELECT sum(amount_kopecks) AS n FROM bank_refund_allocation')).rows[0].n;
    assert.equal(Number(allocated), adult, 'exactly one seat price allocated, from exactly one refund');
  });

  test('a case about a whole collection needs a refund of the whole collection, allocated once', async () => {
    const a = await buy();
    const first = (await open(a.purchaseRef)).bankOperationRef;
    await says(first, adult, { observed: 'FAILED' });
    assert.equal((await retryNativePurchasePayment(deps(), a.purchaseRef, sessionOf(a.purchaseRef))).ok, true);
    const second = (await open(a.purchaseRef)).bankOperationRef;
    await says(second, adult);
    const late = await says(first, adult);
    assert.equal(late.seatEffect, 'NEWER_CYCLE_EXISTS');
    const half = (await db.admin.query('SELECT fn_bank_refund_open($1, $2, $3, $4) AS r', [staff.owner, first, Math.floor(adult / 2), 'part'])).rows[0].r;
    await says(half, Math.floor(adult / 2));
    await assert.rejects(db.admin.query('SELECT fn_bank_settlement_resolve($1, $2, $3, $4, $5)',
      [staff.owner, late.settlementCaseRef, 'REFUNDED', half, 'x']), /REFUND_INSUFFICIENT/, 'half the money is not a refund of the case');
    await db.admin.query('SELECT fn_bank_settlement_resolve($1, $2, $3, $4, $5)',
      [staff.owner, late.settlementCaseRef, 'OWNER_DECISION', null, 'half refunded, the rest kept by agreement']);
    assert.equal(Number((await db.owner.query('SELECT count(*) AS n FROM bank_refund_allocation')).rows[0].n), 0);
  });
});

describe('A2b-1: the money fact survives a failed seat application', () => {
  test('an unexpected error applying the outcome leaves it due; maintain() applies it later', async () => {
    const a = await buy();
    const ref = (await open(a.purchaseRef)).bankOperationRef;
    await db.owner.query(`CREATE FUNCTION test_seat_event_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'TEST_FAULT'; END $$`);
    await db.owner.query(`CREATE TRIGGER test_seat_event_fault BEFORE INSERT ON seat_slot_event FOR EACH ROW
      WHEN (NEW.reason = 'PAYMENT_CONFIRMED') EXECUTE FUNCTION test_seat_event_fault()`);
    try {
      const r = await says(ref, adult);
      assert.deepEqual([r.status, r.applicationPending, r.seatEffect], ['SUCCEEDED', true, null]);
      assert.match((await op(ref)).application_error, /TEST_FAULT/);
      assert.deepEqual(await states(a.purchaseRef), ['HELD']);
      assert.equal(await applyDueBankOperations(db.pool), 0);
    } finally {
      await db.owner.query('DROP TRIGGER test_seat_event_fault ON seat_slot_event');
      await db.owner.query('DROP FUNCTION test_seat_event_fault()');
    }
    await maintain(db.pool, () => undefined);
    assert.deepEqual(await states(a.purchaseRef), ['CONFIRMED']);
    assert.deepEqual([(await op(ref)).application_due, (await op(ref)).application_error], [null, null]);
    assert.equal((await pendingBankOperations(db.pool)).length, 0);
  });
});

describe('A2b-1: the registry is append-only for every login', () => {
  test('services write only through the functions; history is not rewritten, deleted or truncated', async () => {
    const a = await buy();
    const ref = (await open(a.purchaseRef)).bankOperationRef;
    await says(ref, adult);
    for (const pool of [db.pool, db.admin, db.operator]) {
      await assert.rejects(pool.query("UPDATE bank_operation SET status = 'FAILED'"), /permission denied/);
      await assert.rejects(pool.query('DELETE FROM bank_operation_evidence'), /permission denied/);
    }
    await assert.rejects(db.admin.query('SELECT * FROM bank_operation_evidence'), /permission denied/);
    await assert.rejects(db.owner.query("UPDATE bank_operation SET status = 'FAILED' WHERE bank_operation_ref = $1", [ref]), /BANK_OPERATION_TRANSITION_INVALID/);
    await assert.rejects(db.owner.query('UPDATE bank_operation SET amount_kopecks = 1 WHERE bank_operation_ref = $1', [ref]), /BANK_OPERATION_HISTORY_IMMUTABLE/);
    await assert.rejects(db.owner.query('DELETE FROM bank_operation WHERE bank_operation_ref = $1', [ref]), /BANK_OPERATION_HISTORY_IMMUTABLE/);
    await assert.rejects(db.owner.query('UPDATE bank_operation_evidence SET matches = false'), /PURCHASE_HISTORY_IMMUTABLE/);
    for (const t of ['bank_operation', 'bank_operation_evidence', 'bank_settlement_case', 'bank_operation_application', 'bank_refund_allocation']) {
      await assert.rejects(db.owner.query(`TRUNCATE ${t} CASCADE`), /PURCHASE_HISTORY_IMMUTABLE/);
    }
    // A seat event names a real bank operation (0021's attempt references are now foreign keys).
    await assert.rejects(db.owner.query(`INSERT INTO seat_slot_event (seat_slot_id, to_state, actor, reason, bank_operation_ref)
      SELECT seat_slot_id, state, 'x', 'x', 'alfa:forged' FROM seat_slot_current WHERE purchase_ref = $1`, [a.purchaseRef]), /seat_slot_event_bank_operation/);
  });
});
