// ART-327. Real merchant code/SQL; only Refref and Notisend responses are synthetic.
// BIxx assertion messages are the mutation runner's required failure witnesses.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

import { issueState, onReturn, pay, reconcileAll, reconcileOrder, zayavkaOf, type CheckoutDeps } from '../src/checkout.js';
import { eisRecords, recordEisSubmitted } from '../src/eis.js';
import { NotisendClient, processEmailOutbox } from '../src/email.js';
import { LiveSiteReleaseAdmission } from '../src/legal-admission.js';
import { maintain, reserve, setSalesOpen } from '../src/orders.js';
import { RefrefClient } from '../src/refref.js';
import { FakeRefref } from './fake-refref.js';
import { captureLog, fixtureCatalog, freshDb, tourist, type TestDb } from './helpers.js';

const now = new Date('2026-10-23T03:00:00Z');
const merchant = { businessId: '3f1c2a5e-8b4d-4c7e-9a10-2b6d8e4f1a90', businessSlug: 'mikluha',
  checkoutOrigin: 'https://checkout.example.invalid', origin: 'https://book.example.invalid', siteOrigin: 'https://site.example.invalid' };
const catalog = fixtureCatalog([{ slug: 'synthetic-trip', startsOn: '2026-11-01', endsOn: '2026-11-04', capacity: 2 }]);
let db: TestDb;
let fake: FakeRefref;
let deps: CheckoutDeps;
let logs: ReturnType<typeof captureLog>;

before(async () => {
  db = await freshDb();
  fake = new FakeRefref(merchant.businessId, () => now);
  await fake.start();
});
after(async () => { await fake?.stop(); await db?.drop(); });
beforeEach(async () => {
  fake.reset();
  logs = captureLog();
  deps = { pool: db.pool, catalog, merchant, log: logs.log, now: () => now,
    refref: new RefrefClient({ apiBase: fake.base, apiKey: 'synthetic-only', timeoutMs: 500 }) };
  await db.owner.query('TRUNCATE execution_change_notice, order_eis_event, order_eis, email_outbox, order_document, order_event, order_passenger, order_contact, orders');
  await setSalesOpen(db.operator, true, 'synthetic-operator', 'test setup');
});

const booking = () => ({ departureSlug: 'synthetic-trip',
  contact: { phone: '+70000000001', email: 'synthetic-traveller@example.invalid' },
  passengers: [tourist(1, { fullName: 'Синтетический Турист', dateOfBirth: '1991-02-03',
    document: { type: 'RU_PASSPORT', series: '0000', number: '000001' } })],
  adultsOnlyConfirmed: true, termsRef: catalog.terms.ref, termsHash: catalog.terms.hash,
  pdConsentConfirmed: true, pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash });

async function reserved() {
  const result = await reserve({ ...deps, allowDemo: false }, booking());
  assert.ok(result.ok, 'fixture reservation');
  const state = await issueState(db.pool, result.orderRef);
  assert.ok(state);
  return { ref: result.orderRef, state };
}
async function resolved() {
  const order = await reserved();
  assert.equal((await onReturn(deps, { rt: 'synthetic-handoff', state: order.state,
    cookieState: () => order.state })).kind, 'CONFIRM', 'fixture resolution');
  const document = await zayavkaOf(db.pool, order.ref);
  assert.ok(document);
  return { ...order, hash: document.sha256 };
}
async function paid() {
  const order = await resolved();
  await pay(deps, order.ref, order.hash);
  fake.state.obligation = 'SATISFIED';
  await reconcileOrder(deps, order.ref);
  return order;
}
const status = async (ref: string) => (await db.owner.query('SELECT status FROM orders WHERE order_ref = $1', [ref])).rows[0].status;

// Bound observations, then assert the observed lock state. A timing delay is never the oracle.
async function waitLocks(login: string, count: number): Promise<number> {
  const deadline = Date.now() + 2500;
  let observed = 0;
  do {
    await db.owner.query('SELECT pg_stat_clear_snapshot()');
    observed = Number((await db.owner.query(`SELECT count(*) AS n FROM pg_stat_activity
      WHERE datname = current_database() AND usename = $1 AND wait_event_type = 'Lock'`, [login])).rows[0].n);
    if (observed === count) return observed;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  return observed;
}

test('BI01 stop-sales waits for an in-flight session and then prevents new sessions', { timeout: 10_000 }, async () => {
  const order = await resolved();
  const gate = fake.holdSessions();
  const paying = pay(deps, order.ref, order.hash);
  let closing: Promise<void> | undefined;
  let observed: number;
  try {
    await gate.arrived;
    closing = setSalesOpen(db.operator, false, 'synthetic-operator', 'stop');
    observed = await waitLocks('commerce_test_operator', 1);
  } finally {
    gate.release();
    await paying;
    await closing;
  }
  assert.equal(observed!, 1, 'BI01: close must wait for the in-flight provider request');
  const before = fake.requests.length;
  assert.deepEqual(await pay(deps, order.ref, order.hash), { kind: 'STATUS', code: 'SALES_CLOSED' }, 'BI01: stop refuses retry');
  assert.equal(fake.requests.length, before, 'BI01: no new external call after close commits');
});

test('BI02 close commits before pay crosses the sales lock', { timeout: 10_000 }, async () => {
  const order = await resolved();
  const operator = await db.operator.connect();
  let paying: ReturnType<typeof pay> | undefined;
  let observed: number;
  try {
    await operator.query('BEGIN');
    await operator.query("SELECT fn_set_sales_open(false, 'synthetic-operator', 'stop')");
    paying = pay(deps, order.ref, order.hash);
    observed = await waitLocks('commerce_test_runtime', 1);
  } finally {
    await operator.query('COMMIT');
    operator.release();
  }
  const result = await paying!;
  assert.equal(observed!, 1, 'BI02: payment reaches the controlled sales lock');
  assert.deepEqual(result, { kind: 'STATUS', code: 'SALES_CLOSED' }, 'BI02: committed close rejects pay');
  assert.equal(fake.requests.length, 1, 'BI02: only the pre-stop referral resolution was sent');
});

test('BI03 concurrent holds cannot oversell the final seat', { timeout: 10_000 }, async () => {
  await reserved(); // one of two seats remains
  await db.owner.query('BEGIN');
  await db.owner.query('LOCK TABLE order_contact IN ACCESS EXCLUSIVE MODE');
  const contenders = Promise.all(Array.from({ length: 8 }, () => reserve({ ...deps, allowDemo: false }, booking())));
  let observed: number;
  try { observed = await waitLocks('commerce_test_runtime', 8); }
  finally { await db.owner.query('COMMIT'); }
  const results = await contenders;
  assert.equal(observed!, 8, 'BI03: all contenders reach controlled lock boundaries');
  assert.equal(results.filter(r => r.ok).length, 1, 'BI03: exactly one final-seat winner');
  assert.ok(results.filter(r => !r.ok).every(r => r.refusal === 'NOT_ENOUGH_SEATS'), 'BI03: losers are capacity refusals');
  assert.equal((await db.owner.query('SELECT sum(seats)::int AS seats FROM orders')).rows[0].seats, 2, 'BI03: capacity conserved');
});

test('BI04 ambiguous provider creation and duplicate pay replay the identical frozen attempt', async () => {
  const order = await resolved();
  fake.state.attempt = 'ACCEPTED_TIMEOUT';
  fake.state.session = 'TIMEOUT';
  await pay(deps, order.ref, order.hash);
  assert.equal(await status(order.ref), 'PAYMENT_PENDING', 'BI04: ambiguity cannot release seats');
  // Lose the local write, as if the process stopped after remote commit and before persisting ACK.
  await db.owner.query('UPDATE orders SET checkout_attempt_id = NULL WHERE order_ref = $1', [order.ref]);
  fake.state.attempt = 'OK';
  fake.state.session = 'READY';
  const restarted = { ...deps, refref: new RefrefClient({ apiBase: fake.base, apiKey: 'synthetic-only', timeoutMs: 500 }) };
  const sessionsBefore = fake.calls(/\/payment-session$/).length;
  assert.equal(sessionsBefore, 1, 'BI04: first ambiguous session was actually requested');
  const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => pay(restarted, order.ref, order.hash)));
  assert.ok(outcomes.every(r => r.status === 'fulfilled' && r.value.kind === 'REDIRECT'), 'BI04: all parallel retries return the live provider session');
  const sessions = fake.calls(/\/payment-session$/);
  assert.equal(sessions.length - sessionsBefore, outcomes.length, 'BI04: observe every parallel payment-session replay');
  const attemptId = fake.attempts.get(order.ref)!.id;
  assert.ok(sessions.every(r => r.path.includes(`/checkout-attempts/${attemptId}/`)), 'BI04: every session replay uses the same attempt');
  const attempts = fake.calls(/\/checkout-attempts$/);
  assert.ok(attempts.length >= 2, 'BI04: exercise actual replay');
  assert.equal(new Set(attempts.map(r => r.key)).size, 1, 'BI04: replay uses one idempotency identity');
  assert.equal(new Set(attempts.map(r => JSON.stringify(r.body))).size, 1, 'BI04: replay preserves exact frozen bytes');
  assert.equal(fake.attempts.size, 1, 'BI04: one remote attempt');
  const beforeReturns = fake.requests.length;
  await Promise.all(Array.from({ length: 4 }, () => onReturn(restarted,
    { rt: 'synthetic-handoff', state: order.state, cookieState: () => order.state })));
  assert.equal(fake.requests.length, beforeReturns, 'BI04: duplicate returns never initiate more money');
  assert.equal((await db.owner.query('SELECT count(*) FROM orders')).rows[0].count, '1', 'BI04: one local booking');
  assert.equal((await db.owner.query('SELECT count(*) FROM email_outbox')).rows[0].count, '0', 'BI04: browser return is not proof of payment');
  await maintain(db.pool, logs.log, new Date(now.getTime() + 2 * 60 * 60_000));
  assert.equal(await status(order.ref), 'PAYMENT_PENDING', 'BI04: expiry never frees ambiguous money');
});

test('BI05 duplicate readbacks and lost fulfilment ACK confirm exactly once after restart', async () => {
  const order = await resolved();
  await pay(deps, order.ref, order.hash);
  fake.state.obligation = 'SATISFIED';
  fake.state.ack = 'ACCEPTED_TIMEOUT';
  await reconcileOrder(deps, order.ref);
  assert.equal(await status(order.ref), 'PAID', 'BI05: lost ACK cannot fulfil locally');
  assert.equal((await db.owner.query('SELECT count(*) FROM email_outbox')).rows[0].count, '0', 'BI05: no premature confirmation');
  assert.equal(fake.fulfillments.size, 1, 'BI05: remote ACK committed before response was lost');
  fake.state.ack = 'OK';
  const restarted = { ...deps, refref: new RefrefClient({ apiBase: fake.base, apiKey: 'synthetic-only' }) };
  await db.owner.query('BEGIN');
  await db.owner.query('SELECT id FROM orders WHERE order_ref = $1 FOR UPDATE', [order.ref]);
  const replays = Promise.allSettled(Array.from({ length: 8 }, () => reconcileOrder(restarted, order.ref)));
  let observed: number;
  try { observed = await waitLocks('commerce_test_runtime', 8); }
  finally { await db.owner.query('COMMIT'); }
  const outcomes = await replays;
  assert.equal(observed!, 8, 'BI05: all duplicate confirmations reach the write boundary');
  assert.ok(outcomes.every(r => r.status === 'fulfilled'), 'BI05: duplicate confirmation must be a clean no-op');
  await reconcileAll(restarted);
  assert.equal(await status(order.ref), 'FULFILLED', 'BI05: restart completes proven payment');
  const events = (await db.owner.query("SELECT event, count(*)::int AS n FROM order_event WHERE event IN ('PAID','FULFILLED') GROUP BY event ORDER BY event")).rows;
  assert.deepEqual(events, [{ event: 'FULFILLED', n: 1 }, { event: 'PAID', n: 1 }], 'BI05: one paid and one fulfilled transition');
  assert.equal((await db.owner.query('SELECT count(*) FROM email_outbox')).rows[0].count, '1', 'BI05: exactly one confirmation');
  assert.equal((await db.owner.query('SELECT count(*) FROM order_eis')).rows[0].count, '1', 'BI05: exactly one EIS obligation');
  assert.deepEqual([...new Set(fake.calls(/\/fulfillment-ack$/).map(r => r.key))], [`mk-fulfil:${order.ref}`], 'BI05: stable remote ACK identity');
  assert.equal(fake.fulfillments.size, 1, 'BI05: one remote fulfilment identity after replay');
});

test('BI06 stale live legal descriptor prevents any payment side effect', async () => {
  const order = await resolved();
  const legalAdmission = new LiveSiteReleaseAdmission(merchant.siteOrigin, { sourceCommit: 'a'.repeat(40), catalog }, 100,
    async () => ({ schema: 1, service: 'mikluha-site', sourceCommit: 'b'.repeat(40),
      termsRef: catalog.terms.ref, termsHash: catalog.terms.hash, pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash }));
  const before = fake.requests.length;
  assert.deepEqual(await pay({ ...deps, legalAdmission }, order.ref, order.hash),
    { kind: 'STATUS', code: 'LEGAL_RELEASE_NOT_ADMITTED' }, 'BI06: stale descriptor refused');
  assert.equal(fake.requests.length, before, 'BI06: no Refref side effect');
});

test('BI07 stale accepted order document prevents any payment side effect', async () => {
  const order = await resolved();
  const before = fake.requests.length;
  assert.deepEqual(await pay(deps, order.ref, 'f'.repeat(64)), { kind: 'STATUS', code: 'DOCUMENT_CHANGED' }, 'BI07: stale document refused');
  assert.equal(fake.requests.length, before, 'BI07: no Refref side effect');
});

test('BI08 crossed browser identity cannot resolve an order', async () => {
  const a = await reserved();
  const b = await reserved();
  assert.deepEqual(await onReturn(deps, { rt: 'synthetic-handoff', state: a.state, cookieState: () => b.state }),
    { kind: 'REFUSED', code: 'STATE_MISMATCH' }, 'BI08: crossed browser refused');
  assert.equal(fake.requests.length, 0, 'BI08: no resolution or money call');
});

test('BI09 crossed resolution identity is rejected before contract creation', async () => {
  const order = await reserved();
  const resolve = deps.refref.resolve.bind(deps.refref);
  deps.refref.resolve = async body => {
    const result = await resolve(body);
    if (result.kind === 'ANSWERED' && result.body.status === 'RESOLVED') result.body.merchantOrderRef = 'mk-crossed00000';
    return result;
  };
  assert.equal((await onReturn(deps, { rt: 'synthetic-handoff', state: order.state, cookieState: () => order.state })).kind,
    'REFUSED', 'BI09: crossed merchant order refused');
  assert.equal(await zayavkaOf(db.pool, order.ref), null, 'BI09: no contract from crossed identity');
});

test('BI10 Refref receives only receipt email and nonpersonal contract data', async () => {
  const order = await resolved();
  await pay(deps, order.ref, order.hash);
  const session = fake.calls(/\/payment-session$/)[0]!.body as { receiptContact: unknown };
  assert.deepEqual(session.receiptContact, { email: booking().contact.email }, 'BI10: explicit receipt-contact projection');
  const all = JSON.stringify(fake.requests);
  for (const value of ['Синтетический Турист', '1991-02-03', '000001', '+70000000001']) {
    // The generated attempt id can contain 000001; inspect bodies, excluding opaque attempt ids.
    const bodies = JSON.stringify(fake.requests.map(r => r.body));
    assert.ok(!bodies.includes(value), `BI10: tourist PII must not leave the merchant (${value})`);
    assert.ok(!logs.lines.join('\n').includes(value), 'BI10: tourist PII absent from logs');
  }
  assert.ok(all.includes('FULL_PREPAYMENT'), 'BI10: provider fiscal snapshot exercised');
});

test('BI11 accepted contract snapshot remains immutable', async () => {
  const order = await paid();
  const original = (await db.owner.query('SELECT contract_snapshot FROM orders WHERE order_ref = $1', [order.ref])).rows[0].contract_snapshot;
  const changed = structuredClone(original);
  changed.tourTitle = 'Подменённый синтетический договор';
  const error = await db.pool.query('UPDATE orders SET contract_snapshot = $2 WHERE order_ref = $1', [order.ref, changed]).then(() => null, e => e);
  assert.match(String(error), /ORDER_CONTRACT_SNAPSHOT_IMMUTABLE/, 'BI11: accepted contract refuses rewrite');
  assert.deepEqual((await db.owner.query('SELECT contract_snapshot FROM orders WHERE order_ref = $1', [order.ref])).rows[0].contract_snapshot,
    original, 'BI11: frozen contract preserved');
});

test('BI12 mismatched payment amount cannot confirm a booking', async () => {
  const order = await resolved();
  await pay(deps, order.ref, order.hash);
  fake.state.obligation = 'SATISFIED';
  fake.state.paymentAmountDelta = -1;
  await reconcileOrder(deps, order.ref);
  assert.equal(await status(order.ref), 'HELD', 'BI12: payment mismatch stays held');
  assert.equal((await db.owner.query('SELECT count(*) FROM email_outbox')).rows[0].count, '0', 'BI12: no false confirmation');
});

const mailConfig = { apiKey: 'synthetic-only', fromEmail: 'sender@example.invalid', fromName: 'Synthetic', commerceOrigin: merchant.origin };
test('BI13 ambiguous Notisend result never resends after worker restart', async () => {
  await paid();
  let sends = 0;
  const sender = new NotisendClient(mailConfig, async () => { sends++; return new Response('unreadable', { status: 200 }); });
  await processEmailOutbox(db.pool, sender, logs.log, () => now, 1);
  const restart = new NotisendClient(mailConfig, async () => { sends++; return new Response('{"id":1,"status":"queued"}'); });
  await processEmailOutbox(db.pool, restart, logs.log, () => new Date(now.getTime() + 86400_000), 1);
  assert.equal(sends, 1, 'BI13: ambiguous mail is never blindly resent');
  assert.equal((await db.owner.query('SELECT state FROM email_outbox')).rows[0].state, 'ATTENTION', 'BI13: unknown delivery requires attention');
});

test('BI14 a crash after mail submission leaves a lease that cannot resend', async () => {
  await paid();
  // The sender has accepted remotely, then the process dies before recording the result.
  await assert.rejects(processEmailOutbox(db.pool, { send: async () => { throw new Error('synthetic-process-crash'); } }, logs.log, () => now, 1), /synthetic-process-crash/);
  let sends = 0;
  await processEmailOutbox(db.pool, { send: async () => { sends++; return { kind: 'ACCEPTED', jobId: 'duplicate' }; } },
    logs.log, () => new Date(now.getTime() + 120_000), 1);
  assert.equal(sends, 0, 'BI14: expired SENDING lease cannot resend');
  assert.equal((await db.owner.query('SELECT state FROM email_outbox')).rows[0].state, 'ATTENTION', 'BI14: crash requires attention');
});

test('BI15 manual EIS filing replay after lost local ACK cannot duplicate filing history', async () => {
  const order = await paid();
  await recordEisSubmitted(db.operator, order.ref, 'SYNTHETIC-EIS-001', 'synthetic-operator', 0);
  const error = await recordEisSubmitted(db.operator, order.ref, 'SYNTHETIC-EIS-001', 'synthetic-operator', 0).then(() => null, e => e);
  assert.match(String(error), /EIS_ALREADY_SUBMITTED/, 'BI15: replay is refused after persisted submission');
  assert.equal((await db.owner.query("SELECT count(*) FROM order_eis_event WHERE to_status = 'EIS_SUBMITTED'")).rows[0].count, '1', 'BI15: one filing event');
});

test('BI16 stale EIS packet cannot be filed after tourist data changes', async () => {
  const order = await paid();
  const revision = (await eisRecords(db.operator, order.ref))[0]!.materialRevision;
  await db.owner.query("UPDATE order_passenger SET document_number = '000002'");
  const error = await recordEisSubmitted(db.operator, order.ref, 'SYNTHETIC-EIS-001', 'synthetic-operator', revision).then(() => null, e => e);
  assert.match(String(error), /EIS_PACKET_STALE/, 'BI16: stale reviewed packet refused');
  assert.equal((await eisRecords(db.operator, order.ref))[0]!.status, 'EIS_PENDING', 'BI16: no stale submission');
});

test('BI17 corrupted frozen offer cannot start payment', async () => {
  const order = await resolved();
  await db.owner.query("UPDATE orders SET legal_release_content = 'synthetic tampering' WHERE order_ref = $1", [order.ref]);
  const before = fake.requests.length;
  assert.deepEqual(await pay(deps, order.ref, order.hash), { kind: 'STATUS', code: 'LEGAL_RELEASE_INVALID' }, 'BI17: frozen offer integrity checked');
  assert.equal(fake.requests.length, before, 'BI17: no payment side effect');
});

test('BI18 corrupted frozen consent cannot start payment', async () => {
  const order = await resolved();
  await db.owner.query("UPDATE orders SET pd_consent_content = 'synthetic tampering' WHERE order_ref = $1", [order.ref]);
  const before = fake.requests.length;
  assert.deepEqual(await pay(deps, order.ref, order.hash), { kind: 'STATUS', code: 'PD_CONSENT_INVALID' }, 'BI18: frozen consent integrity checked');
  assert.equal(fake.requests.length, before, 'BI18: no payment side effect');
});

test('BI19 crossed payment snapshot cannot confirm a booking', async () => {
  const order = await resolved();
  await pay(deps, order.ref, order.hash);
  fake.state.obligation = 'SATISFIED';
  fake.state.projectionMismatch = true;
  await reconcileOrder(deps, order.ref);
  assert.equal(await status(order.ref), 'HELD', 'BI19: crossed snapshot must hold');
  assert.equal((await db.owner.query('SELECT count(*) FROM email_outbox')).rows[0].count, '0', 'BI19: no false confirmation');
});

test('BI20 accepted application document remains immutable', async () => {
  const order = await paid();
  const original = await zayavkaOf(db.pool, order.ref);
  const error = await db.pool.query("UPDATE order_document SET content = 'synthetic tampering'").then(() => null, e => e);
  assert.match(String(error), /ORDER_DOCUMENT_FROZEN/, 'BI20: accepted application refuses rewrite');
  assert.deepEqual(await zayavkaOf(db.pool, order.ref), original, 'BI20: accepted bytes and hash preserved');
});

test('BI21 unqualified expense refund policy cannot start new money', async () => {
  const order = await resolved();
  const before = fake.requests.length;
  assert.deepEqual(await pay({ ...deps, catalog: { ...catalog, refundPolicy: 'DOCUMENTED_EXPENSES' } }, order.ref, order.hash),
    { kind: 'STATUS', code: 'REFUND_WORKFLOW_UNQUALIFIED' }, 'BI21: unqualified refund workflow blocks money');
  assert.equal(fake.requests.length, before, 'BI21: no payment side effect');
});

async function rejectAcks(id: string, bodies: (attemptId: string) => readonly unknown[]) {
  const order = await resolved();
  await pay(deps, order.ref, order.hash);
  const attemptId = fake.attempts.get(order.ref)!.id;
  fake.state.obligation = 'SATISFIED';
  for (const body of bodies(attemptId)) {
    fake.ackBody = body;
    await reconcileOrder(deps, order.ref);
    assert.equal(await status(order.ref), 'PAID', `${id}: unusable ACK cannot fulfil locally`);
    assert.equal((await db.owner.query('SELECT count(*) FROM email_outbox')).rows[0].count, '0', `${id}: no premature confirmation`);
    assert.equal((await db.owner.query("SELECT count(*) FROM order_event WHERE event = 'FULFILLED'")).rows[0].count,
      '0', `${id}: no fulfilled event`);
    // EIS is due from the independently proven payment, even while the ACK is unusable.
    assert.deepEqual((await db.owner.query('SELECT status FROM order_eis')).rows, [{ status: 'EIS_PENDING' }], `${id}: preserve the payment-created EIS obligation`);
  }
  assert.equal(fake.calls(/\/fulfillment-ack$/).length, bodies(attemptId).length, `${id}: every invalid ACK was exercised over HTTP`);
  fake.ackBody = undefined;
  const restarted = { ...deps, refref: new RefrefClient({ apiBase: fake.base, apiKey: 'synthetic-only' }) };
  await reconcileOrder(restarted, order.ref);
  await reconcileAll(restarted);
  assert.equal(await status(order.ref), 'FULFILLED', `${id}: a later correct ACK recovers the paid order`);
  assert.equal((await db.owner.query('SELECT count(*) FROM email_outbox')).rows[0].count, '1', `${id}: recovery confirms once`);
  assert.equal((await db.owner.query('SELECT count(*) FROM order_eis')).rows[0].count, '1', `${id}: recovery never duplicates EIS`);
  assert.deepEqual([...new Set(fake.calls(/\/fulfillment-ack$/).map(r => r.key))], [`mk-fulfil:${order.ref}`], `${id}: recovery keeps the ACK identity`);
}

test('BI22 foreign or malformed fulfilment ACK identity cannot confirm the order', async () => {
  await rejectAcks('BI22', () => [
    { checkoutAttemptId: '99999999-9999-4999-8999-999999999999', status: 'DELIVERED' },
    { checkoutAttemptId: 'x', status: 'DELIVERED' },
  ]);
});

test('BI23 a non-delivered fulfilment ACK cannot confirm the order', async () => {
  await rejectAcks('BI23', attemptId => ['NOT_READY', 'READY', 'FAILED', 'ACTION_REQUIRED']
    .map(status => ({ checkoutAttemptId: attemptId, status })));
});

test('BI24 malformed fulfilment ACK bodies cannot confirm the order', async () => {
  await rejectAcks('BI24', attemptId => [null, {}, [], [attemptId, 'DELIVERED'], 'DELIVERED', true, 42,
    { checkoutAttemptId: attemptId }, { status: 'DELIVERED' },
    { checkoutAttemptId: [attemptId], status: 'DELIVERED' }, { checkoutAttemptId: attemptId, status: null }]);
});
