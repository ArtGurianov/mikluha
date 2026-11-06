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
import { reserveNativePurchase, retryNativePurchasePayment, type NativePurchaseRequest } from '../src/purchases.js';
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
