// Track A / A2b-2 for TOUR-78 (migration 0026): the per-seat money ledger, MK-C01 deposits and the
// remaining balance. Real PostgreSQL, production roles; synthetic bank evidence only (contract §18).
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import { createUser } from '../src/admin/operator.js';
import { currentTermsOf, openCollection, purchaseMoney, recordBankEvidence, type PaymentPurpose } from '../src/bank-operations.js';
import type { Catalog } from '../src/catalog.js';
import { issueCheckoutIntent, openCheckoutSession, tokenSha256 } from '../src/checkout-session.js';
import { maintain, setSalesOpen, type OrderDeps } from '../src/orders.js';
import { reserveNativePurchase } from '../src/purchases.js';
import { fixtureCatalog, freshDb, resetOrders, seedCatalog, type TestDb } from './helpers.js';

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const SLUG = 'altai-money';
const SOON = 'altai-money-soon';
const RUB = 100;

let db: TestDb;
let catalog: Catalog;
let price: number;
let owner: string;
const ids: Record<string, string> = {};

/** draft → check → publish, as the Control Room (admin_app saves, admin_publisher publishes). */
async function publish(slug: string, extra: Record<string, unknown>) {
  const id = ids[slug]!;
  const draft = (await db.owner.query('SELECT revision, document FROM departure_draft WHERE departure_id = $1', [id])).rows[0];
  const document = { ...draft.document };
  delete document.paymentTerms;
  Object.assign(document, extra);
  const revision = (await db.admin.query('SELECT fn_save_departure_draft($1, $2, $3, $4) AS r', [id, draft.revision, document, 'fixture'])).rows[0].r;
  const published = (await db.owner.query('SELECT published_version AS v FROM departure WHERE id = $1', [id])).rows[0].v;
  return db.publisher.query('SELECT fn_publish_departure($1, $2, $3, $4)', [id, revision, published, 'owner-publication']);
}
const deps = (): OrderDeps => ({ pool: db.pool, catalog, log: () => undefined, allowDemo: false });
async function buy(tickets = { adults: 2, teens: 0, children: 0 }, slug = SLUG) {
  const s = await openCheckoutSession(db.pool);
  const intent = await issueCheckoutIntent(db.pool, s.token);
  assert.ok(intent.ok);
  const r = await reserveNativePurchase(deps(), {
    departureSlug: slug, buyer: { fullName: 'Анна Покупатель', phone: '+7 903 907-55-47', email: 'buyer@example.ru' }, tickets,
    ageTermsConfirmed: true, termsRef: catalog.terms.ref, termsHash: catalog.terms.hash, pdConsentConfirmed: true,
    pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash, session: { token: s.token }, checkoutIntent: { key: intent.key } });
  assert.ok(r.ok, JSON.stringify(r));
  return { ...r, token: s.token };
}
const pay = (p: { purchaseRef: string; token: string }, purpose: PaymentPurpose, provider = 'alfa') =>
  openCollection(db.pool, p.purchaseRef, p.token, provider, 'mikluha-test', currentTermsOf(catalog), purpose);
let n = 0;
const bank = (ref: string, amount: number, observed: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED', payload = `p-${++n}`) =>
  recordBankEvidence(db.pool, ref, { source: 'CALLBACK', observed, provider: 'alfa', merchantAccount: 'mikluha-test',
    providerOperationId: `alfa-${ref}`, amountKopecks: amount, currency: 'RUB', payload });
const seats = async (purchaseRef: string) => (await db.owner.query(`SELECT state, ticket_type, price_kopecks, deposit_kopecks, paid_kopecks,
    refunded_kopecks, balance_due_kopecks FROM seat_money WHERE purchase_ref = $1 ORDER BY seat_slot_ref`, [purchaseRef])).rows
  .map((r) => ({ ...r, price_kopecks: Number(r.price_kopecks), deposit_kopecks: Number(r.deposit_kopecks), paid_kopecks: Number(r.paid_kopecks),
    refunded_kopecks: Number(r.refunded_kopecks), balance_due_kopecks: Number(r.balance_due_kopecks) }));

before(async () => {
  db = await freshDb();
  catalog = fixtureCatalog([{ slug: SLUG, startsOn: day(30), endsOn: day(33), capacity: 4 },
    { slug: SOON, startsOn: day(2), endsOn: day(4), capacity: 4 }]);
  await seedCatalog(db, catalog);
  for (const slug of [SLUG, SOON]) ids[slug] = (await db.owner.query('SELECT id FROM departure WHERE slug = $1', [slug])).rows[0].id;
  price = catalog.departures.get(SLUG)!.priceKopecks!;
  owner = await createUser(db.adminOperator, 'money-owner', 'OWNER', 'correct horse battery staple 42', 'test');
  await setSalesOpen(db.operator, true, 'test', 'open for the test');
});
after(async () => { await db?.drop(); });
beforeEach(async () => {
  await resetOrders(db.owner);
  await publish(SLUG, {});
});

describe('MK-C01: the nominal deposit is a published term of the departure', () => {
  test('default 5 000 ₽; publication sets it in whole roubles; nothing else writes it; the basis freezes it', async () => {
    const nominal = async () => Number((await db.owner.query('SELECT deposit_nominal_kopecks AS n FROM departure WHERE id = $1', [ids[SLUG]])).rows[0].n);
    assert.equal(await nominal(), 5_000 * RUB);
    await publish(SLUG, { paymentTerms: { depositRub: 7_000 } });
    assert.equal(await nominal(), 7_000 * RUB);
    for (const bad of [{ depositRub: 0 }, { depositRub: 1.5 }, { depositRub: '5000' }, { depositRub: 5000, percent: 30 }]) {
      await assert.rejects(publish(SLUG, { paymentTerms: bad }), /DEPARTURE_DOCUMENT_INVALID/, JSON.stringify(bad));
    }
    await assert.rejects(db.owner.query('UPDATE departure SET deposit_nominal_kopecks = 100 WHERE id = $1', [ids[SLUG]]),
      /DEPARTURE_PAYMENT_TERMS_PUBLICATION_ONLY/);
    await assert.rejects(db.admin.query('UPDATE departure SET deposit_nominal_kopecks = 100 WHERE id = $1', [ids[SLUG]]), /permission denied/);
    const a = await buy({ adults: 1, teens: 0, children: 0 });
    await publish(SLUG, { paymentTerms: { depositRub: 3_000 } });
    const basis = (await db.owner.query(`SELECT b.deposit_nominal_kopecks AS n FROM pricing_basis b JOIN purchase p ON p.origin_order_id = b.document_order_id
      WHERE p.purchase_ref = $1`, [a.purchaseRef])).rows[0].n;
    assert.equal(Number(basis), 7_000 * RUB, 'the purchase keeps the nominal it was bought with');
    assert.equal(Number((await db.pool.query('SELECT deposit_nominal_kopecks AS n FROM public_departure WHERE slug = $1', [SLUG])).rows[0].n), 3_000 * RUB);
  });
});

describe('A2b-2: deposit, balance and the ledger', () => {
  test('a deposit confirms the seats and is allocated per seat; the balance pays the remainder once; nothing more is due', async () => {
    const a = await buy();
    const dep = await pay(a, 'DEPOSIT');
    assert.ok(dep.ok);
    assert.equal(dep.amountKopecks, 2 * 5_000 * RUB);
    assert.deepEqual(await pay(a, 'DEPOSIT'), { ...dep, replayed: true });
    assert.deepEqual(await pay(a, 'FULL'), { ok: false, refusal: 'HOLD_ALREADY_FENCED' }, 'one operation per cycle, whatever the purpose');
    assert.deepEqual(await pay(a, 'BALANCE'), { ok: false, refusal: 'NOTHING_DUE' }, 'nothing is owed before a seat is confirmed');
    const ok = await bank(dep.bankOperationRef, dep.amountKopecks);
    assert.deepEqual([ok.status, ok.seatEffect], ['SUCCEEDED', 'SEATS_CONFIRMED']);
    await bank(dep.bankOperationRef, dep.amountKopecks); // a repeated callback allocates nothing again
    assert.deepEqual((await seats(a.purchaseRef)).map((s) => [s.state, s.paid_kopecks, s.balance_due_kopecks]),
      [['CONFIRMED', 5_000 * RUB, price - 5_000 * RUB], ['CONFIRMED', 5_000 * RUB, price - 5_000 * RUB]]);
    let money = (await purchaseMoney(db.pool, a.purchaseRef))!;
    assert.deepEqual([money.paidKopecks, money.balanceDueKopecks, money.depositOffered], [10_000 * RUB, 2 * price - 10_000 * RUB, true]);
    assert.ok(money.depositUntil < money.balanceDueAt);

    // The balance: one operation in flight; the same request replays it; another provider waits.
    const [b1, b2] = await Promise.all([pay(a, 'BALANCE'), pay(a, 'BALANCE')]);
    assert.ok(b1.ok && b2.ok);
    assert.equal(b1.bankOperationRef, b2.bankOperationRef);
    assert.deepEqual([b1.amountKopecks, b1.holdRef], [2 * price - 10_000 * RUB, null]);
    assert.deepEqual(await pay(a, 'BALANCE', 'sbp'), { ok: false, refusal: 'BALANCE_PAYMENT_IN_FLIGHT' });
    const done = await bank(b1.bankOperationRef, b1.amountKopecks, 'SUCCEEDED', 'balance-ok');
    assert.deepEqual([done.status, done.seatEffect], ['SUCCEEDED', 'NONE']);
    await bank(b1.bankOperationRef, b1.amountKopecks, 'SUCCEEDED', 'balance-ok');
    money = (await purchaseMoney(db.pool, a.purchaseRef))!;
    assert.deepEqual([money.paidKopecks, money.balanceDueKopecks], [2 * price, 0]);
    assert.deepEqual(await pay(a, 'BALANCE'), { ok: false, refusal: 'NOTHING_DUE' });
    assert.equal(Number((await db.owner.query('SELECT count(*) AS n FROM seat_money_allocation')).rows[0].n), 4, 'two seats × two payments');
  });

  test('a failed balance payment changes nothing and can be tried again', async () => {
    const a = await buy({ adults: 1, teens: 0, children: 0 });
    const dep = await pay(a, 'DEPOSIT');
    assert.ok(dep.ok);
    await bank(dep.bankOperationRef, dep.amountKopecks);
    const bal = await pay(a, 'BALANCE');
    assert.ok(bal.ok);
    const failed = await bank(bal.bankOperationRef, bal.amountKopecks, 'FAILED');
    assert.deepEqual([failed.status, failed.seatEffect], ['FAILED', 'NONE']);
    assert.deepEqual((await seats(a.purchaseRef)).map((s) => s.state), ['CONFIRMED']);
    const again = await pay(a, 'BALANCE');
    assert.ok(again.ok && again.bankOperationRef !== bal.bankOperationRef);
  });

  test('MK-C01 cap: a seat cheaper than the nominal pays in full; when every seat does, only the full payment is offered', async () => {
    const child = 3_700 * RUB;
    await publish(SLUG, { minorTerms: { allowed: true, minAge: null, childPriceKopecks: child } });
    const a = await buy({ adults: 1, teens: 0, children: 1 });
    const dep = await pay(a, 'DEPOSIT');
    assert.ok(dep.ok);
    assert.equal(dep.amountKopecks, 5_000 * RUB + child);
    await bank(dep.bankOperationRef, dep.amountKopecks);
    const byType = Object.fromEntries((await seats(a.purchaseRef)).map((s) => [s.ticket_type, [s.deposit_kopecks, s.paid_kopecks, s.balance_due_kopecks]]));
    assert.deepEqual(byType, { AGE_18_PLUS: [5_000 * RUB, 5_000 * RUB, price - 5_000 * RUB], AGE_0_13: [child, child, 0] });
    // A nominal above every seat's price: the deposit would be the whole price.
    await publish(SLUG, { paymentTerms: { depositRub: 40_000 } });
    const b = await buy({ adults: 1, teens: 0, children: 0 });
    assert.equal((await purchaseMoney(db.pool, b.purchaseRef))!.depositOffered, false);
    assert.deepEqual(await pay(b, 'DEPOSIT'), { ok: false, refusal: 'DEPOSIT_NOT_AVAILABLE' });
    assert.equal((await pay(b, 'FULL')).ok, true);
  });

  test('T−72 and T−24 by the database clock: no deposit from T−72; no public balance from T−24', async () => {
    const soon = await buy({ adults: 1, teens: 0, children: 0 }, SOON);
    assert.deepEqual(await pay(soon, 'DEPOSIT'), { ok: false, refusal: 'DEPOSIT_WINDOW_CLOSED' });
    const full = await pay(soon, 'FULL');
    assert.ok(full.ok);
    assert.equal(full.amountKopecks, catalog.departures.get(SOON)!.priceKopecks);
    // A deposit-paid purchase whose departure is now within 24 hours: the public balance is closed.
    const a = await buy({ adults: 1, teens: 0, children: 0 });
    const dep = await pay(a, 'DEPOSIT');
    assert.ok(dep.ok);
    await bank(dep.bankOperationRef, dep.amountKopecks);
    await db.owner.query('BEGIN');
    try {
      await db.owner.query('SET LOCAL session_replication_role = replica');
      await db.owner.query("UPDATE departure SET starts_on = (now() AT TIME ZONE timezone)::date + 1, departure_time = '00:00' WHERE id = $1", [ids[SLUG]]);
      await db.owner.query('COMMIT');
    } catch (e) { await db.owner.query('ROLLBACK'); throw e; }
    try {
      assert.deepEqual(await pay(a, 'BALANCE'), { ok: false, refusal: 'BALANCE_WINDOW_CLOSED' });
      assert.ok((await purchaseMoney(db.pool, a.purchaseRef))!.balanceDueKopecks > 0, 'the debt stays; nothing is cancelled');
    } finally {
      await db.owner.query('BEGIN');
      await db.owner.query('SET LOCAL session_replication_role = replica');
      await db.owner.query("UPDATE departure SET starts_on = $2::date, departure_time = '06:00' WHERE id = $1", [ids[SLUG], day(30)]);
      await db.owner.query('COMMIT');
    }
  });
});

describe('review of PR #91: confirmed money not yet in the ledger never lets the balance be collected twice', () => {
  const fault = async (on: boolean) => {
    if (on) {
      await db.owner.query(`CREATE FUNCTION test_ledger_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST_LEDGER_FAULT'; END $$`);
      await db.owner.query('CREATE TRIGGER test_ledger_fault BEFORE INSERT ON seat_money_allocation FOR EACH ROW EXECUTE FUNCTION test_ledger_fault()');
    } else {
      await db.owner.query('DROP TRIGGER test_ledger_fault ON seat_money_allocation');
      await db.owner.query('DROP FUNCTION test_ledger_fault()');
    }
  };
  const balances = async () => Number((await db.owner.query("SELECT count(*) AS n FROM bank_operation WHERE purpose = 'BALANCE'")).rows[0].n);

  test('deposit, balance confirmed, application failing: a new balance is refused; maintain() applies it; nothing is due', async () => {
    const a = await buy({ adults: 1, teens: 0, children: 0 });
    const dep = await pay(a, 'DEPOSIT');
    assert.ok(dep.ok);
    await bank(dep.bankOperationRef, dep.amountKopecks);
    const bal = await pay(a, 'BALANCE');
    assert.ok(bal.ok);
    await fault(true);
    try {
      const r = await bank(bal.bankOperationRef, bal.amountKopecks, 'SUCCEEDED', 'balance-paid');
      assert.deepEqual([r.status, r.applicationPending], ['SUCCEEDED', true]);
      assert.equal((await purchaseMoney(db.pool, a.purchaseRef))!.balanceDueKopecks, price - 5_000 * RUB, 'the ledger lags behind the bank');
      for (const provider of ['alfa', 'sbp']) {
        assert.deepEqual(await pay(a, 'BALANCE', provider), { ok: false, refusal: 'BALANCE_APPLICATION_PENDING' });
      }
      // Not even a direct insert of a second BALANCE operation: the database index refuses it.
      await assert.rejects(db.owner.query(`INSERT INTO bank_operation (bank_operation_ref, kind, purchase_id, provider, merchant_account,
          amount_kopecks, currency, status, created_by, purpose)
        SELECT 'bo-00000000000000000001', 'COLLECTION', purchase_id, 'alfa', 'x', 1, 'RUB', 'INTENDED', 'test', 'BALANCE'
          FROM bank_operation WHERE bank_operation_ref = $1`, [bal.bankOperationRef]), /bank_operation_balance_in_flight/);
    } finally { await fault(false); }
    assert.equal(await balances(), 1, 'no second collection was created');
    await maintain(db.pool, () => undefined);
    assert.equal((await purchaseMoney(db.pool, a.purchaseRef))!.balanceDueKopecks, 0);
    assert.deepEqual(await pay(a, 'BALANCE'), { ok: false, refusal: 'NOTHING_DUE' });
    assert.equal(await balances(), 1);
  });

  test('the pending application is applied by the next balance request itself, under its locks', async () => {
    const a = await buy({ adults: 1, teens: 0, children: 0 });
    const dep = await pay(a, 'DEPOSIT');
    assert.ok(dep.ok);
    await bank(dep.bankOperationRef, dep.amountKopecks);
    const bal = await pay(a, 'BALANCE');
    assert.ok(bal.ok);
    await fault(true);
    try { await bank(bal.bankOperationRef, bal.amountKopecks, 'SUCCEEDED', 'balance-paid-2'); } finally { await fault(false); }
    const state = async () => (await db.owner.query(`SELECT b.application_due,
        (SELECT count(*) FROM bank_operation_application x WHERE x.bank_operation_id = b.id) AS applications,
        (SELECT coalesce(sum(amount_kopecks), 0) FROM seat_money_allocation a WHERE a.bank_operation_id = b.id) AS allocated
      FROM bank_operation b WHERE b.bank_operation_ref = $1`, [bal.bankOperationRef])).rows[0];
    // The database's own open never applies and refuses: nothing of an application could survive its exception.
    assert.deepEqual(Object.values(await state()).map(String), ['SUCCEEDED', '0', '0']);
    // The service path applies first, in its own committed statement; the refusal then rolls back only the open.
    assert.deepEqual(await pay(a, 'BALANCE'), { ok: false, refusal: 'NOTHING_DUE' }, 'applied first, then nothing is owed');
    const after = await state();
    assert.deepEqual([after.application_due, Number(after.applications), Number(after.allocated)], [null, 1, bal.amountKopecks],
      'the application is committed: due cleared, application recorded, money in the ledger');
    assert.equal((await purchaseMoney(db.pool, a.purchaseRef))!.balanceDueKopecks, 0);
    assert.equal(await balances(), 1);
  });

  test('a direct open of the database refuses while money is unapplied, and changes nothing', async () => {
    const a = await buy({ adults: 1, teens: 0, children: 0 });
    const dep = await pay(a, 'DEPOSIT');
    assert.ok(dep.ok);
    await bank(dep.bankOperationRef, dep.amountKopecks);
    const bal = await pay(a, 'BALANCE');
    assert.ok(bal.ok);
    await fault(true);
    try { await bank(bal.bankOperationRef, bal.amountKopecks, 'SUCCEEDED', 'balance-paid-3'); } finally { await fault(false); }
    const t = currentTermsOf(catalog);
    await assert.rejects(db.pool.query('SELECT * FROM fn_bank_operation_open_payment($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [a.purchaseRef, tokenSha256(a.token), 'alfa', 'mikluha-test', t.termsRef, t.termsHash, t.pdConsentRef, t.pdConsentHash, 'BALANCE']),
      /BALANCE_APPLICATION_PENDING/);
    assert.equal(await balances(), 1);
    assert.equal(await db.pool.query('SELECT fn_purchase_apply_due($1) AS n', [a.purchaseRef]).then((r) => r.rows[0].n), 1);
    assert.equal(await db.pool.query('SELECT fn_purchase_apply_due($1) AS n', [a.purchaseRef]).then((r) => r.rows[0].n), 0, 'idempotent');
  });

  test('a conflict found after a balance was opened: its replay still returns it; a new one waits for the settlement', async () => {
    const a = await buy({ adults: 1, teens: 0, children: 0 });
    const dep = await pay(a, 'DEPOSIT');
    assert.ok(dep.ok);
    await bank(dep.bankOperationRef, dep.amountKopecks);
    const bal = await pay(a, 'BALANCE');
    assert.ok(bal.ok);
    const odd = await bank(bal.bankOperationRef, bal.amountKopecks + 1);
    assert.deepEqual([odd.status, odd.effect], ['INTENDED', 'EVIDENCE_MISMATCH']);
    const replay = await pay(a, 'BALANCE');
    assert.ok(replay.ok, JSON.stringify(replay));
    assert.deepEqual([replay.bankOperationRef, replay.replayed], [bal.bankOperationRef, true]);
    assert.deepEqual(await pay(a, 'BALANCE', 'sbp'), { ok: false, refusal: 'BALANCE_PAYMENT_IN_FLIGHT' });
    await bank(bal.bankOperationRef, bal.amountKopecks, 'FAILED');
    assert.deepEqual(await pay(a, 'BALANCE'), { ok: false, refusal: 'BALANCE_SETTLEMENT_PENDING' });
    assert.equal(await balances(), 1);
  });

  test('unsettled money of the purchase (an open case other than PAID_NO_SEAT) stops a new balance', async () => {
    const a = await buy({ adults: 1, teens: 0, children: 0 });
    const dep = await pay(a, 'DEPOSIT');
    assert.ok(dep.ok);
    await bank(dep.bankOperationRef, dep.amountKopecks);
    // Evidence of a success with another amount: no status change, an EVIDENCE_MISMATCH case.
    const bal = await pay(a, 'BALANCE');
    assert.ok(bal.ok);
    const odd = await bank(bal.bankOperationRef, bal.amountKopecks + 1);
    assert.equal(odd.effect, 'EVIDENCE_MISMATCH');
    await bank(bal.bankOperationRef, bal.amountKopecks, 'FAILED');
    assert.deepEqual(await pay(a, 'BALANCE'), { ok: false, refusal: 'BALANCE_SETTLEMENT_PENDING' });
    const caseRef = (await db.owner.query("SELECT case_ref FROM bank_settlement_case WHERE reason = 'EVIDENCE_MISMATCH'")).rows[0].case_ref;
    await db.admin.query('SELECT fn_bank_settlement_resolve($1, $2, $3, $4, $5)', [owner, caseRef, 'OWNER_DECISION', null, 'bank confirmed no money']);
    assert.equal((await pay(a, 'BALANCE')).ok, true);
  });
});

describe('A2b-2: what a seat received is what a no-seat refund settles; the ledger never over-allocates', () => {
  test('a late deposit with no free seat: the seat holds its deposit; the refund of that deposit settles it', async () => {
    const a = await buy({ adults: 1, teens: 0, children: 0 });
    const late = await pay(a, 'DEPOSIT');
    assert.ok(late.ok);
    await bank(late.bankOperationRef, late.amountKopecks, 'FAILED');
    const b = await buy({ adults: 4, teens: 0, children: 0 });
    const full = await pay(b, 'FULL');
    assert.ok(full.ok);
    await bank(full.bankOperationRef, full.amountKopecks);
    const r = await bank(late.bankOperationRef, late.amountKopecks);
    assert.equal(r.seatEffect, 'PAID_NO_SEAT');
    const [s] = await seats(a.purchaseRef);
    assert.deepEqual([s!.state, s!.paid_kopecks], ['PAID_NO_SEAT_EXCEPTION', 5_000 * RUB]);
    const refund = (await db.admin.query('SELECT fn_bank_refund_open($1, $2, $3, $4) AS r', [owner, late.bankOperationRef, 5_000 * RUB, 'no seat'])).rows[0].r;
    await bank(refund, 5_000 * RUB);
    const slotRef = (await db.owner.query('SELECT seat_slot_ref FROM seat_slot_current WHERE purchase_ref = $1', [a.purchaseRef])).rows[0].seat_slot_ref;
    await db.pool.query('SELECT fn_seat_slot_refund_settled($1, $2)', [slotRef, refund]);
    const [settled] = await seats(a.purchaseRef);
    assert.deepEqual([settled!.state, settled!.refunded_kopecks], ['REFUND_SETTLED', 5_000 * RUB]);
  });

  test('no login writes the ledger beyond a seat\'s price, for unconfirmed money, or after the fact', async () => {
    const a = await buy({ adults: 1, teens: 0, children: 0 });
    const op = await pay(a, 'FULL');
    assert.ok(op.ok);
    const slot = (await db.owner.query('SELECT seat_slot_id FROM seat_slot_current WHERE purchase_ref = $1', [a.purchaseRef])).rows[0].seat_slot_id;
    const opId = (await db.owner.query('SELECT id FROM bank_operation WHERE bank_operation_ref = $1', [op.bankOperationRef])).rows[0].id;
    await assert.rejects(db.owner.query('INSERT INTO seat_money_allocation (bank_operation_id, seat_slot_id, amount_kopecks) VALUES ($1, $2, 1)',
      [opId, slot]), /SEAT_MONEY_ALLOCATION_INVALID/, 'money not confirmed by the bank is not allocated');
    await bank(op.bankOperationRef, op.amountKopecks);
    await assert.rejects(db.owner.query('INSERT INTO seat_money_allocation (bank_operation_id, seat_slot_id, amount_kopecks) VALUES ($1, $2, 1)',
      [opId, slot]), /SEAT_MONEY_ALLOCATION_EXCEEDS/, 'a fully paid seat takes no more money, not even one kopeck');
    await assert.rejects(db.owner.query('UPDATE seat_money_allocation SET amount_kopecks = 1'), /PURCHASE_HISTORY_IMMUTABLE/);
    await assert.rejects(db.owner.query('TRUNCATE seat_money_allocation'), /PURCHASE_HISTORY_IMMUTABLE/);
    await assert.rejects(db.pool.query('DELETE FROM seat_money_allocation'), /permission denied/);
    await assert.rejects(db.owner.query("UPDATE bank_operation SET purpose = 'DEPOSIT' WHERE id = $1", [opId]), /BANK_OPERATION_HISTORY_IMMUTABLE/);
  });
});
