// Track A / A2b-11 and A2b-12 for TOUR-28/99 (migration 0023): idempotent ordinary checkout,
// browser sessions, resuming a purchase and its ownership. Real PostgreSQL, production roles
// (contract §15; OWNER v1.9.1 §9, G-IDEMP-01, G-RESUME-01, G-RESUME-02).
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';

import type pg from 'pg';

import { createUser } from '../src/admin/operator.js';
import { openCollection, recordBankEvidence } from '../src/bank-operations.js';
import type { Catalog } from '../src/catalog.js';
import {
  checkoutSessionCookie, forgetPurchaseOnDevice, issueCheckoutIntent, issueResumeCode, markResumePrompted, openCheckoutSession,
  resumeCodeHmac, resumeCodeKey, resumeSeatMessage, resumeView, sessionPurchases, tokenSha256, verifyResumeCode,
} from '../src/checkout-session.js';
import { maintain, setSalesOpen, type OrderDeps } from '../src/orders.js';
import { previewNativePurchaseRetry, reserveNativePurchase, retryNativePurchasePayment, type NativePurchaseRequest } from '../src/purchases.js';
import { fixtureCatalog, freshDb, resetOrders, seedCatalog, type TestDb } from './helpers.js';

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const SLUG = 'altai-resume';
const EMAIL = 'buyer@example.ru';
/** The server's resume-code key: outside PostgreSQL (CHECKOUT_RESUME_CODE_KEY in Coolify). */
const KEY = resumeCodeKey(randomBytes(32).toString('base64'));

let db: TestDb;
let catalog: Catalog;
let adult: number;
let manager: string;

const deps = (pool: pg.Pool = db.pool): OrderDeps => ({ pool, catalog, log: () => undefined, allowDemo: false });
async function session() { return (await openCheckoutSession(db.pool)).token; }
async function intent(token: string) {
  const r = await issueCheckoutIntent(db.pool, token);
  assert.ok(r.ok, JSON.stringify(r));
  return r.key;
}
const request = (token: string, key: string | undefined, over: Partial<NativePurchaseRequest> = {}): NativePurchaseRequest => ({
  departureSlug: SLUG, buyer: { fullName: 'Анна Покупатель', phone: '+7 903 907-55-47', email: EMAIL },
  tickets: { adults: 1, teens: 0, children: 0 }, ageTermsConfirmed: true, termsRef: catalog.terms.ref, termsHash: catalog.terms.hash,
  pdConsentConfirmed: true, pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash,
  session: { token }, ...(key === undefined ? {} : { checkoutIntent: { key } }), ...over });
async function buy(over: Partial<NativePurchaseRequest> = {}) {
  const token = await session();
  const r = await reserveNativePurchase(deps(), request(token, await intent(token), over));
  assert.ok(r.ok, JSON.stringify(r));
  return { ...(r as Extract<typeof r, { ok: true }>), token };
}
const count = async (sql: string, values: unknown[] = []) => Number((await db.owner.query(sql, values)).rows[0].n);
async function asOwnerWithoutTriggers(sql: string, values: unknown[]) {
  await db.owner.query('BEGIN');
  try {
    await db.owner.query('SET LOCAL session_replication_role = replica');
    await db.owner.query(sql, values);
    await db.owner.query('COMMIT');
  } catch (e) { await db.owner.query('ROLLBACK'); throw e; }
}
/** A pool whose clients silently skip one statement: a service path that "forgot" a step. */
function skipping(pool: pg.Pool, needle: string): pg.Pool {
  return new Proxy(pool, { get(target, prop) {
    if (prop !== 'connect') return Reflect.get(target, prop);
    return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(c, p) {
        if (p !== 'query') { const v = Reflect.get(c, p); return typeof v === 'function' ? v.bind(c) : v; }
        return (sql: unknown, ...rest: unknown[]) => (typeof sql === 'string' && sql.includes(needle)
          ? Promise.resolve({ rows: [], rowCount: 0 }) : (c.query as (...a: unknown[]) => unknown)(sql, ...rest));
      } });
    };
  } }) as pg.Pool;
}

before(async () => {
  db = await freshDb();
  catalog = fixtureCatalog([{ slug: SLUG, startsOn: day(30), endsOn: day(33), capacity: 6 }]);
  await seedCatalog(db, catalog);
  adult = catalog.departures.get(SLUG)!.priceKopecks;
  manager = await createUser(db.adminOperator, 'resume-manager', 'MANAGER', 'correct horse battery staple 42', 'test');
  await setSalesOpen(db.operator, true, 'test', 'open for the test');
});
after(async () => { await db?.drop(); });
beforeEach(async () => { await resetOrders(db.owner); });

describe('A2b-11: the ordinary checkout is idempotent by its server-issued intent (G-IDEMP-01)', () => {
  test('a double click gives one purchase, its seats created once; both answers carry it', async () => {
    for (let round = 0; round < 5; round++) {
      await resetOrders(db.owner);
      const token = await session();
      const same = request(token, await intent(token), { tickets: { adults: 2, teens: 0, children: 0 } });
      const [a, b] = await Promise.all([reserveNativePurchase(deps(), same), reserveNativePurchase(deps(), same)]);
      assert.ok(a.ok && b.ok, JSON.stringify([a, b]));
      assert.equal(a.purchaseRef, b.purchaseRef);
      assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]);
      assert.deepEqual([await count('SELECT count(*) AS n FROM purchase'), await count('SELECT count(*) AS n FROM seat_slot')], [1, 2]);
    }
  });

  test('a lost response is answered from history, even after sales closed; another request or buyer is a conflict', async () => {
    const token = await session();
    const key = await intent(token);
    const first = await reserveNativePurchase(deps(), request(token, key));
    assert.ok(first.ok);
    await setSalesOpen(db.operator, false, 'test', 'closed');
    try {
      const again = await reserveNativePurchase(deps(), request(token, key));
      assert.ok(again.ok && again.replayed);
      assert.deepEqual([again.purchaseRef, again.orderRef, again.amountKopecks], [first.purchaseRef, first.orderRef, adult]);
    } finally { await setSalesOpen(db.operator, true, 'test', 'reopen'); }
    assert.deepEqual(await reserveNativePurchase(deps(), request(token, key, { tickets: { adults: 2, teens: 0, children: 0 } })),
      { ok: false, refusal: 'IDEMPOTENCY_CONFLICT' });
    assert.deepEqual(await reserveNativePurchase(deps(), request(token, key, { buyer: { fullName: 'Иван Другой', phone: '+7 903 907-55-47', email: EMAIL } })),
      { ok: false, refusal: 'IDEMPOTENCY_CONFLICT' });
    assert.equal(await count('SELECT count(*) AS n FROM purchase'), 1);
  });

  test('the intent belongs to its session; none, unknown or expired is refused; a refused attempt keeps it usable', async () => {
    const token = await session();
    const key = await intent(token);
    assert.deepEqual(await reserveNativePurchase(deps(), request(token, undefined)), { ok: false, refusal: 'CHECKOUT_INTENT_REQUIRED' });
    assert.deepEqual(await reserveNativePurchase(deps(), request(await session(), key)), { ok: false, refusal: 'CHECKOUT_INTENT_INVALID' });
    assert.deepEqual(await reserveNativePurchase(deps(), request('y'.repeat(43), key)), { ok: false, refusal: 'CHECKOUT_SESSION_INVALID' });
    assert.deepEqual(await reserveNativePurchase(deps(), request(token, 'z'.repeat(43))), { ok: false, refusal: 'CHECKOUT_INTENT_INVALID' });
    assert.deepEqual(await issueCheckoutIntent(db.pool, await session(), key), { ok: false, refusal: 'CHECKOUT_INTENT_INVALID' });
    assert.deepEqual(await reserveNativePurchase(deps(), request(token, key, { tickets: { adults: 7, teens: 0, children: 0 } })),
      { ok: false, refusal: 'NOT_ENOUGH_SEATS' });
    assert.equal((await reserveNativePurchase(deps(), request(token, key))).ok, true, 'the refused attempt consumed nothing');
    const stale = await intent(token);
    await asOwnerWithoutTriggers(`UPDATE checkout_intent SET expires_at = clock_timestamp() - interval '1 second'
      WHERE key_sha256 = $1`, [tokenSha256(stale)]);
    assert.deepEqual(await reserveNativePurchase(deps(), request(token, stale)), { ok: false, refusal: 'CHECKOUT_INTENT_INVALID' });
  });

  test('no service path commits a purchase without its intent or its session', async () => {
    const token = await session();
    await assert.rejects(reserveNativePurchase(deps(skipping(db.pool, 'fn_checkout_intent_consume')), request(token, await intent(token))),
      /CHECKOUT_SESSION_REQUIRED|CHECKOUT_INTENT_REQUIRED/);
    // A staff-linked purchase has its own key, but is still bound to the creating session.
    const origin = await buy();
    const group = (await db.owner.query(`SELECT g.purchase_group_ref FROM purchase p JOIN purchase_group_member m ON m.purchase_id = p.id
      JOIN purchase_group g ON g.id = m.group_id WHERE p.purchase_ref = $1`, [origin.purchaseRef])).rows[0].purchase_group_ref;
    const linkToken = 'link-token-'.padEnd(40, 'x');
    await db.admin.query('SELECT fn_group_link_issue($1, $2, $3, 1, 0, 0)', [manager, group, tokenSha256(linkToken)]);
    await assert.rejects(reserveNativePurchase(deps(skipping(db.pool, 'fn_purchase_session_bind_new')),
      request(await session(), undefined, { groupLink: { token: linkToken, idempotencyKey: 'link-attempt-1' } })), /CHECKOUT_SESSION_REQUIRED/);
    assert.equal(await count('SELECT count(*) AS n FROM purchase'), 1);
  });
});

describe('A2b-12: only a session bound to the purchase resumes or pays it (G-RESUME-02)', () => {
  test('a stranger who knows the purchaseRef cannot see, retry or pay it', async () => {
    const a = await buy();
    const stranger = await session();
    assert.equal(await resumeView(db.pool, a.purchaseRef, stranger), null);
    assert.deepEqual(await openCollection(db.pool, a.purchaseRef, stranger, 'alfa', 'mikluha-test'), { ok: false, refusal: 'PURCHASE_NOT_OWNED' });
    assert.deepEqual(await retryNativePurchasePayment(deps(), a.purchaseRef, stranger), { ok: false, refusal: 'PURCHASE_NOT_OWNED' });
    for (const sql of [`SELECT * FROM fn_purchase_rehold('${a.purchaseRef}')`, `SELECT * FROM fn_bank_operation_open('${a.purchaseRef}', 'alfa', 'x')`]) {
      await assert.rejects(db.pool.query(sql), /permission denied/);
    }
    await assert.rejects(db.pool.query('SELECT * FROM fn_purchase_rehold_owned($1, $2)', [a.purchaseRef, tokenSha256(stranger)]), /PURCHASE_NOT_OWNED/);
    assert.equal((await openCollection(db.pool, a.purchaseRef, a.token, 'alfa', 'mikluha-test')).ok, true);
  });
});

describe('A2b-12: the return dialog follows server state (G-RESUME-01, v1.9.1 §9 п.4)', () => {
  test('hold, payment in progress, released, closed and paid; the dialog is offered once; «forget» cancels nothing', async () => {
    const a = await buy({ tickets: { adults: 2, teens: 0, children: 0 } });
    let v = (await resumeView(db.pool, a.purchaseRef, a.token))!;
    assert.deepEqual([v.state, v.tickets, v.totalKopecks, v.promptDue], ['HOLD_ACTIVE', { adults: 2, teens: 0, children: 0 }, 2 * adult, true]);
    assert.ok(v.holdExpiresAt instanceof Date && v.retryUntil > v.holdExpiresAt);
    assert.match(resumeSeatMessage(v.state, v.holdExpiresAt)!, /^Места временно удерживаются до \d\d:\d\d\.$/);
    assert.deepEqual(await sessionPurchases(db.pool, a.token), [{ purchaseRef: a.purchaseRef, promptDue: true }]);
    assert.equal(await markResumePrompted(db.pool, a.purchaseRef, a.token), true);
    assert.equal(await markResumePrompted(db.pool, a.purchaseRef, a.token), false, 'shown once');
    const op = await openCollection(db.pool, a.purchaseRef, a.token, 'alfa', 'mikluha-test');
    assert.ok(op.ok);
    v = (await resumeView(db.pool, a.purchaseRef, a.token))!;
    assert.deepEqual([v.state, v.holdExpiresAt, v.promptDue], ['PAYMENT_IN_PROGRESS', null, false]);
    await recordBankEvidence(db.pool, op.bankOperationRef, { source: 'CALLBACK', observed: 'FAILED', provider: 'alfa',
      merchantAccount: 'mikluha-test', payload: 'failed' });
    v = (await resumeView(db.pool, a.purchaseRef, a.token))!;
    assert.equal(v.state, 'RELEASED');
    const messages = new Set((['HOLD_ACTIVE', 'PAYMENT_IN_PROGRESS', 'RELEASED', 'CLOSED'] as const).map((s) => resumeSeatMessage(s, null)));
    assert.equal(messages.size, 4, 'one message per state, never one generic phrase');
    await asOwnerWithoutTriggers("UPDATE purchase SET created_at = created_at - interval '25 hours' WHERE purchase_ref = $1", [a.purchaseRef]);
    assert.equal((await resumeView(db.pool, a.purchaseRef, a.token))!.state, 'CLOSED');

    const b = await buy();
    const paid = await openCollection(db.pool, b.purchaseRef, b.token, 'alfa', 'mikluha-test');
    assert.ok(paid.ok);
    await recordBankEvidence(db.pool, paid.bankOperationRef, { source: 'CALLBACK', observed: 'SUCCEEDED', provider: 'alfa',
      merchantAccount: 'mikluha-test', providerOperationId: 'alfa-b', amountKopecks: adult, currency: 'RUB', payload: 'ok' });
    assert.equal((await resumeView(db.pool, b.purchaseRef, b.token))!.state, 'PAID');

    await forgetPurchaseOnDevice(db.pool, b.purchaseRef, b.token);
    assert.equal(await resumeView(db.pool, b.purchaseRef, b.token), null);
    assert.deepEqual(await sessionPurchases(db.pool, b.token), []);
    assert.equal((await db.owner.query('SELECT status FROM orders WHERE order_ref = $1', [b.orderRef])).rows[0].status, 'RESERVED',
      'forgetting on a device cancels nothing');
  });

  test('another device: a one-time email code binds a new session; wrong codes burn it; three per hour', async () => {
    const a = await buy();
    assert.deepEqual((await issueResumeCode(db.pool, 'nobody@example.ru', KEY)).orderIds, []);
    const device = await session();
    const first = await issueResumeCode(db.pool, '  Buyer@Example.ru ', KEY);
    assert.equal(first.orderIds.length, 1);
    assert.match(first.code, /^[0-9]{6}$/);
    const wrong = first.code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) assert.deepEqual(await verifyResumeCode(db.pool, EMAIL, wrong, device, KEY), []);
    assert.deepEqual(await verifyResumeCode(db.pool, EMAIL, first.code, device, KEY), [], 'five wrong attempts end the code');
    const second = await issueResumeCode(db.pool, EMAIL, KEY);
    assert.deepEqual(await verifyResumeCode(db.pool, EMAIL, second.code, device, KEY), [a.purchaseRef]);
    assert.deepEqual(await verifyResumeCode(db.pool, EMAIL, second.code, await session(), KEY), [], 'single use');
    assert.equal((await resumeView(db.pool, a.purchaseRef, device))!.state, 'HOLD_ACTIVE');
    assert.equal((await retryNativePurchasePayment(deps(), a.purchaseRef, device)).ok, false, 'owned, but the hold is still open');
    const third = await issueResumeCode(db.pool, EMAIL, KEY);
    assert.equal(third.orderIds.length, 1);
    assert.deepEqual((await issueResumeCode(db.pool, EMAIL, KEY)).orderIds, [], 'at most three codes per purchase per hour');
    await asOwnerWithoutTriggers("UPDATE purchase_resume_code SET expires_at = clock_timestamp() - interval '1 second' WHERE consumed_at IS NULL", []);
    assert.deepEqual(await verifyResumeCode(db.pool, EMAIL, third.code, await session(), KEY), [], 'an expired code binds nothing');
    // The code is never stored, only its hash; the session token likewise.
    const stored = JSON.stringify((await db.owner.query('SELECT * FROM purchase_resume_code')).rows)
      + JSON.stringify((await db.owner.query('SELECT * FROM checkout_session')).rows);
    for (const secret of [second.code, third.code, device, a.token]) assert.equal(stored.includes(secret), false);
    // Review of PR #88: no stored value is a plain hash of the six digits, so a read of the database
    // alone cannot brute-force a code offline; only the server key reproduces it.
    const plain = (c: string) => createHash('sha256').update(c).digest('hex');
    for (const c of [first.code, second.code, third.code]) assert.equal(stored.includes(plain(c)), false);
    const rows = (await db.owner.query('SELECT code_hmac FROM purchase_resume_code ORDER BY issued_at')).rows.map((r) => r.code_hmac);
    assert.ok(rows.includes(resumeCodeHmac(KEY, EMAIL, third.code)));
    const another = resumeCodeKey(randomBytes(32).toString('base64'));
    assert.notEqual(resumeCodeHmac(another, EMAIL, third.code), resumeCodeHmac(KEY, EMAIL, third.code));
    assert.throws(() => resumeCodeKey(randomBytes(16).toString('base64')), /RESUME_CODE_KEY_INVALID/);
    assert.throws(() => resumeCodeKey(undefined), /RESUME_CODE_KEY_INVALID/);
  });
});

describe('review of PR #88: codes need the server key; a repeat after 8B erasure is still answered', () => {
  test('a code verified under another key binds nothing', async () => {
    const a = await buy();
    const issued = await issueResumeCode(db.pool, EMAIL, KEY);
    const other = resumeCodeKey(randomBytes(32).toString('base64'));
    assert.deepEqual(await verifyResumeCode(db.pool, EMAIL, issued.code, await session(), other), []);
    assert.deepEqual(await verifyResumeCode(db.pool, EMAIL, issued.code, await session(), KEY), [a.purchaseRef]);
  });

  test('replay, failure, closure with PD erased, replay: the same purchase from history; another request still conflicts', async () => {
    const token = await session();
    const key = await intent(token);
    const first = await reserveNativePurchase(deps(), request(token, key));
    assert.ok(first.ok);
    const again = await reserveNativePurchase(deps(), request(token, key));
    assert.ok(again.ok && again.replayed && again.purchaseRef === first.purchaseRef);
    const op = await openCollection(db.pool, first.purchaseRef, token, 'alfa', 'mikluha-test');
    assert.ok(op.ok);
    await recordBankEvidence(db.pool, op.bankOperationRef, { source: 'CALLBACK', observed: 'FAILED', provider: 'alfa',
      merchantAccount: 'mikluha-test', payload: 'failed-8b' });
    await asOwnerWithoutTriggers("UPDATE purchase SET created_at = created_at - interval '25 hours' WHERE purchase_ref = $1", [first.purchaseRef]);
    const m = await maintain(db.pool, () => undefined);
    assert.deepEqual([m.expired, m.erased], [1, 1]);
    assert.equal(await count('SELECT count(*) AS n FROM order_contact'), 0, 'the buyer contact is erased (8B)');
    const afterErasure = await reserveNativePurchase(deps(), request(token, key));
    assert.ok(afterErasure.ok && afterErasure.replayed, JSON.stringify(afterErasure));
    assert.deepEqual([afterErasure.purchaseRef, afterErasure.orderRef], [first.purchaseRef, first.orderRef]);
    assert.equal((await resumeView(db.pool, first.purchaseRef, token))!.state, 'CLOSED');
    assert.deepEqual(await reserveNativePurchase(deps(), request(token, key, { tickets: { adults: 2, teens: 0, children: 0 } })),
      { ok: false, refusal: 'IDEMPOTENCY_CONFLICT' });
    // A device that forgot the purchase cannot replay it into its session after the contact is gone.
    await forgetPurchaseOnDevice(db.pool, first.purchaseRef, token);
    assert.deepEqual(await reserveNativePurchase(deps(), request(token, key)), { ok: false, refusal: 'IDEMPOTENCY_CONFLICT' });
    assert.equal(await count('SELECT count(*) AS n FROM purchase'), 1);
  });
});

describe('review 2 of PR #88: forgetting is not final for an authorized code; a live hold outlasts the window', () => {
  test('forget on this device, then a correct email code in the same browser restores access', async () => {
    const a = await buy();
    assert.equal(await markResumePrompted(db.pool, a.purchaseRef, a.token), true);
    await forgetPurchaseOnDevice(db.pool, a.purchaseRef, a.token);
    assert.equal(await resumeView(db.pool, a.purchaseRef, a.token), null);
    const issued = await issueResumeCode(db.pool, EMAIL, KEY);
    assert.deepEqual(await verifyResumeCode(db.pool, EMAIL, issued.code, a.token, KEY), [a.purchaseRef]);
    const v = await resumeView(db.pool, a.purchaseRef, a.token);
    assert.ok(v !== null, 'the code restores access in the same browser');
    assert.deepEqual([v.state, v.promptDue], ['HOLD_ACTIVE', true]);
    assert.deepEqual(await sessionPurchases(db.pool, a.token), [{ purchaseRef: a.purchaseRef, promptDue: true }]);
    assert.equal((await openCollection(db.pool, a.purchaseRef, a.token, 'alfa', 'mikluha-test')).ok, true);
    // History keeps the forgotten link; one live link per purchase and session; forgetting again works.
    const links = (await db.owner.query(`SELECT bound_via, forgotten_at IS NOT NULL AS forgotten FROM purchase_session_binding b
      JOIN purchase p ON p.id = b.purchase_id WHERE p.purchase_ref = $1 ORDER BY bound_at`, [a.purchaseRef])).rows;
    assert.deepEqual(links.map((l) => [l.bound_via, l.forgotten]), [['CHECKOUT', true], ['EMAIL_CODE', false]]);
    await forgetPurchaseOnDevice(db.pool, a.purchaseRef, a.token);
    assert.equal(await resumeView(db.pool, a.purchaseRef, a.token), null);
  });

  test('a new hold made just before the 24-hour limit is shown as held until it ends; a new attempt is then refused', async () => {
    const a = await buy();
    const op = await openCollection(db.pool, a.purchaseRef, a.token, 'alfa', 'mikluha-test');
    assert.ok(op.ok);
    await recordBankEvidence(db.pool, op.bankOperationRef, { source: 'CALLBACK', observed: 'FAILED', provider: 'alfa',
      merchantAccount: 'mikluha-test', payload: 'failed-boundary' });
    const age = (interval: string) => asOwnerWithoutTriggers(`UPDATE purchase SET created_at = created_at - interval '${interval}'
      WHERE purchase_ref = $1`, [a.purchaseRef]);
    await age('23 hours 59 minutes');
    const retry = await retryNativePurchasePayment(deps(), a.purchaseRef, a.token);
    assert.ok(retry.ok, JSON.stringify(retry));
    await age('2 minutes'); // now past created + 24 h, the new hold still has about three minutes
    let v = (await resumeView(db.pool, a.purchaseRef, a.token))!;
    assert.deepEqual([v.state, v.holdExpiresAt?.getTime(), v.retryWindowOpen, v.canPayCurrentHold, v.cycleStateEligible],
      ['HOLD_ACTIVE', retry.reservedUntil.getTime(), false, true, false]);
    assert.ok(v.retryUntil < new Date() && v.holdExpiresAt! > new Date());
    assert.match(resumeSeatMessage(v.state, v.holdExpiresAt)!, /удерживаются до/);
    await asOwnerWithoutTriggers(`UPDATE seat_hold SET expires_at = clock_timestamp() - interval '1 second'
      WHERE closed_at IS NULL AND purchase_id = (SELECT id FROM purchase WHERE purchase_ref = $1)`, [a.purchaseRef]);
    v = (await resumeView(db.pool, a.purchaseRef, a.token))!;
    assert.deepEqual([v.state, v.holdExpiresAt, v.retryWindowOpen, v.canPayCurrentHold, v.cycleStateEligible], ['CLOSED', null, false, false, false]);
    // Before the limit, a released purchase may still start a new attempt.
    const b = await buy();
    const opB = await openCollection(db.pool, b.purchaseRef, b.token, 'alfa', 'mikluha-test');
    assert.ok(opB.ok);
    await recordBankEvidence(db.pool, opB.bankOperationRef, { source: 'CALLBACK', observed: 'FAILED', provider: 'alfa',
      merchantAccount: 'mikluha-test', payload: 'failed-b' });
    const vb = (await resumeView(db.pool, b.purchaseRef, b.token))!;
    assert.deepEqual([vb.state, vb.retryWindowOpen, vb.canPayCurrentHold, vb.cycleStateEligible], ['RELEASED', true, false, true]);
  });
});

describe('review 3 of PR #88: the resume view promises only what the commands do', () => {
  test('a registered bank operation: PAYMENT_IN_PROGRESS, no payment and no new cycle offered, and none possible', async () => {
    const a = await buy();
    let v = (await resumeView(db.pool, a.purchaseRef, a.token))!;
    assert.deepEqual([v.state, v.retryWindowOpen, v.canPayCurrentHold, v.cycleStateEligible], ['HOLD_ACTIVE', true, true, false]);
    assert.deepEqual(await retryNativePurchasePayment(deps(), a.purchaseRef, a.token), { ok: false, refusal: 'REHOLD_NOT_ALLOWED' });
    const op = await openCollection(db.pool, a.purchaseRef, a.token, 'alfa', 'mikluha-test');
    assert.ok(op.ok);
    await recordBankEvidence(db.pool, op.bankOperationRef, { source: 'REGISTRATION_RESPONSE', observed: 'REGISTERED', provider: 'alfa',
      merchantAccount: 'mikluha-test', providerOperationId: 'alfa-in-progress', payload: 'registered' });
    // Past the hold's five minutes the registered attempt still protects the seats and blocks a new cycle.
    await asOwnerWithoutTriggers(`UPDATE seat_hold SET expires_at = clock_timestamp() - interval '1 second'
      WHERE closed_at IS NULL AND purchase_id = (SELECT id FROM purchase WHERE purchase_ref = $1)`, [a.purchaseRef]);
    v = (await resumeView(db.pool, a.purchaseRef, a.token))!;
    assert.deepEqual([v.state, v.retryWindowOpen, v.canPayCurrentHold, v.cycleStateEligible], ['PAYMENT_IN_PROGRESS', true, false, false]);
    assert.deepEqual(await retryNativePurchasePayment(deps(), a.purchaseRef, a.token), { ok: false, refusal: 'REHOLD_NOT_ALLOWED' });
    assert.deepEqual(await openCollection(db.pool, a.purchaseRef, a.token, 'sbp', 'mikluha-test'), { ok: false, refusal: 'HOLD_ALREADY_FENCED' });
  });

  test('a hold that expired before maintain() ran: RELEASED, a new cycle is offered and the retry starts it at once', async () => {
    const a = await buy();
    await asOwnerWithoutTriggers(`UPDATE seat_hold SET expires_at = clock_timestamp() - interval '1 second'
      WHERE closed_at IS NULL AND purchase_id = (SELECT id FROM purchase WHERE purchase_ref = $1)`, [a.purchaseRef]);
    const v = (await resumeView(db.pool, a.purchaseRef, a.token))!;
    assert.deepEqual([v.state, v.holdExpiresAt, v.canPayCurrentHold, v.cycleStateEligible], ['RELEASED', null, false, true]);
    assert.deepEqual(await openCollection(db.pool, a.purchaseRef, a.token, 'alfa', 'mikluha-test'), { ok: false, refusal: 'HOLD_EXPIRED' },
      'no payment on the expired hold');
    const retry = await retryNativePurchasePayment(deps(), a.purchaseRef, a.token);
    assert.ok(retry.ok, JSON.stringify(retry));
    const cycles = (await db.owner.query(`SELECT cycle, outcome FROM seat_hold h JOIN purchase p ON p.id = h.purchase_id
      WHERE p.purchase_ref = $1 ORDER BY cycle`, [a.purchaseRef])).rows;
    assert.deepEqual(cycles, [{ cycle: 1, outcome: 'LAPSED' }, { cycle: 2, outcome: null }]);
    const events = (await db.owner.query(`SELECT e.reason FROM seat_slot_event e JOIN seat_slot s ON s.id = e.seat_slot_id
      JOIN purchase p ON p.id = s.purchase_id WHERE p.purchase_ref = $1 ORDER BY e.id`, [a.purchaseRef])).rows.map((r) => r.reason);
    assert.deepEqual(events, ['PURCHASE_OPENED', 'HOLD_LAPSED', 'NEW_PAYMENT_CYCLE']);
    const after = (await resumeView(db.pool, a.purchaseRef, a.token))!;
    assert.deepEqual([after.state, after.canPayCurrentHold, after.cycleStateEligible], ['HOLD_ACTIVE', true, false]);
  });
});

describe('review 4 of PR #88: the final retry answer and the attempt that starts before the 24-hour limit', () => {
  const failHold = async (r: { purchaseRef: string; token: string }, payload: string) => {
    const op = await openCollection(db.pool, r.purchaseRef, r.token, 'alfa', 'mikluha-test');
    assert.ok(op.ok);
    await recordBankEvidence(db.pool, op.bankOperationRef, { source: 'CALLBACK', observed: 'FAILED', provider: 'alfa',
      merchantAccount: 'mikluha-test', payload });
  };
  const holds = async () => Number((await db.owner.query('SELECT count(*) AS n FROM seat_hold')).rows[0].n);

  test('cycleStateEligible is a precondition; the preview answers with every rule and holds nothing', async () => {
    const a = await buy();
    await failHold(a, 'preview-failed');
    let v = (await resumeView(db.pool, a.purchaseRef, a.token))!;
    assert.deepEqual([v.state, v.cycleStateEligible], ['RELEASED', true]);
    const before = await holds();
    assert.deepEqual(await previewNativePurchaseRetry(deps(), a.purchaseRef, a.token), { ok: true });
    assert.equal(await holds(), before, 'the preview holds nothing');
    assert.deepEqual((await resumeView(db.pool, a.purchaseRef, a.token))!.state, 'RELEASED');
    // The OWNER closes sales: the precondition still holds, the final answer is SALES_CLOSED, as the retry's.
    await setSalesOpen(db.operator, false, 'test', 'closed');
    try {
      v = (await resumeView(db.pool, a.purchaseRef, a.token))!;
      assert.equal(v.cycleStateEligible, true);
      assert.deepEqual(await previewNativePurchaseRetry(deps(), a.purchaseRef, a.token), { ok: false, refusal: 'SALES_CLOSED' });
      assert.deepEqual(await retryNativePurchasePayment(deps(), a.purchaseRef, a.token), { ok: false, refusal: 'SALES_CLOSED' });
    } finally { await setSalesOpen(db.operator, true, 'test', 'reopen'); }
    // The quota is taken meanwhile: NOT_ENOUGH_SEATS from the database, in the preview as in the retry.
    await buy({ tickets: { adults: 6, teens: 0, children: 0 } });
    assert.deepEqual(await previewNativePurchaseRetry(deps(), a.purchaseRef, a.token), { ok: false, refusal: 'NOT_ENOUGH_SEATS' });
    assert.deepEqual(await retryNativePurchasePayment(deps(), a.purchaseRef, a.token), { ok: false, refusal: 'NOT_ENOUGH_SEATS' });
    // A stranger gets nothing from the preview either.
    assert.deepEqual(await previewNativePurchaseRetry(deps(), a.purchaseRef, await session()), { ok: false, refusal: 'PURCHASE_NOT_OWNED' });
  });

  test('OWNER 06.11: a hold created before the 24-hour limit may be paid after it; no new cycle after it', async () => {
    const a = await buy();
    await failHold(a, 'limit-failed');
    const age = (interval: string) => asOwnerWithoutTriggers(`UPDATE purchase SET created_at = created_at - interval '${interval}'
      WHERE purchase_ref = $1`, [a.purchaseRef]);
    await age('23 hours 59 minutes');
    const retry = await retryNativePurchasePayment(deps(), a.purchaseRef, a.token);
    assert.ok(retry.ok, JSON.stringify(retry));
    await age('2 minutes');
    const v = (await resumeView(db.pool, a.purchaseRef, a.token))!;
    assert.deepEqual([v.state, v.retryWindowOpen, v.canPayCurrentHold], ['HOLD_ACTIVE', false, true]);
    // The attempt began with the hold: the bank registers it now, past the limit, and it completes.
    const op = await openCollection(db.pool, a.purchaseRef, a.token, 'alfa', 'mikluha-test');
    assert.ok(op.ok, JSON.stringify(op));
    const reg = await recordBankEvidence(db.pool, op.bankOperationRef, { source: 'REGISTRATION_RESPONSE', observed: 'REGISTERED',
      provider: 'alfa', merchantAccount: 'mikluha-test', providerOperationId: 'alfa-after-limit', payload: 'reg-after-limit' });
    assert.equal(reg.status, 'REGISTERED');
    // If it fails, no further cycle starts after the limit.
    await recordBankEvidence(db.pool, op.bankOperationRef, { source: 'CALLBACK', observed: 'FAILED', provider: 'alfa',
      merchantAccount: 'mikluha-test', providerOperationId: 'alfa-after-limit', payload: 'failed-after-limit' });
    assert.deepEqual([(await resumeView(db.pool, a.purchaseRef, a.token))!.state], ['CLOSED']);
    assert.deepEqual(await previewNativePurchaseRetry(deps(), a.purchaseRef, a.token), { ok: false, refusal: 'RETRY_WINDOW_CLOSED' });
  });
});

describe('A2b-12: cookie and history', () => {
  test('the session cookie is host-only, HTTPS-only and invisible to scripts', async () => {
    const token = await session();
    const cookie = checkoutSessionCookie(token);
    assert.match(cookie, /^__Host-mikluha-checkout=[A-Za-z0-9_-]+; Path=\/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax$/);
    assert.equal(/Domain=/i.test(cookie), false);
    assert.throws(() => checkoutSessionCookie('a;b'), /CHECKOUT_SESSION_INVALID/);
  });

  test('services write only through the functions; identities, consumption and bindings are not rewritten', async () => {
    const a = await buy();
    for (const sql of ['UPDATE checkout_intent SET consumed_at = NULL', 'DELETE FROM purchase_session_binding',
      "INSERT INTO checkout_session (session_ref, token_sha256, expires_at) VALUES ('cs-00000000000000000000', repeat('a', 64), now())"]) {
      await assert.rejects(db.pool.query(sql), /permission denied/);
    }
    await assert.rejects(db.owner.query('UPDATE checkout_intent SET request_sha256 = repeat(\'b\', 64)'), /CHECKOUT_HISTORY_IMMUTABLE/);
    await assert.rejects(db.owner.query('DELETE FROM purchase_session_binding'), /CHECKOUT_HISTORY_IMMUTABLE/);
    await forgetPurchaseOnDevice(db.pool, a.purchaseRef, a.token);
    await assert.rejects(db.owner.query('UPDATE purchase_session_binding SET forgotten_at = NULL'), /CHECKOUT_HISTORY_IMMUTABLE/);
    for (const t of ['checkout_session', 'checkout_intent', 'purchase_session_binding', 'purchase_resume_code']) {
      await assert.rejects(db.owner.query(`TRUNCATE ${t} CASCADE`), /PURCHASE_HISTORY_IMMUTABLE/);
    }
  });
});
