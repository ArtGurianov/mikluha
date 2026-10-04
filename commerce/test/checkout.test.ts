// The whole checkout through the real HTTP routes, a real Postgres (as the runtime role) and a model
// of Refref (fake-refref.ts).
import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';

import type { Catalog } from '../src/catalog.js';
import { reconcileAll, verdict, type CheckoutDeps } from '../src/checkout.js';
import { schemaHead } from '../src/migrate.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import { maintain, setSalesOpen } from '../src/orders.js';
import { RefrefClient, type CheckoutAttempt } from '../src/refref.js';
import { createCommerceServer } from '../src/server.js';
import { createWebHandler } from '../src/web.js';
import { FakeRefref } from './fake-refref.js';
import { captureLog, fixtureCatalog, freshDb, type TestDb } from './helpers.js';

const MERCHANT_ID = '3f1c2a5e-8b4d-4c7e-9a10-2b6d8e4f1a90';
const MINUTE = 60_000;
const PD = ['Иван', 'Петров', 'Анна', '9039075547', 'ivan@example.ru'];

let db: TestDb;
let catalog: Catalog;
let refref: FakeRefref;
let server: Server;
let base: string;
let clock: Date;
let logs: ReturnType<typeof captureLog>;
let deps: CheckoutDeps;

before(async () => {
  db = await freshDb();
  catalog = fixtureCatalog([{ slug: 'altai-2026-11-01', startsOn: '2026-11-01', endsOn: '2026-11-04', capacity: 3 }]);
  refref = new FakeRefref(MERCHANT_ID);
  await refref.start();
  logs = captureLog();
  deps = {
    pool: db.pool, catalog, log: (e, f) => logs.log(e, f), now: () => clock,
    refref: new RefrefClient({ apiBase: refref.base, apiKey: 'rk_test', timeoutMs: 1500 }),
    merchant: { businessId: MERCHANT_ID, businessSlug: 'mikluha', checkoutOrigin: 'https://checkout.refref.example',
      origin: 'https://book.mikluha.example' },
  };
  server = createCommerceServer({ pool: db.pool, catalog, schemaHead: schemaHead(MIGRATIONS_DIR), sourceCommit: null,
    startedAt: new Date() }, createWebHandler(deps, false));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await refref.stop();
  await db.drop();
});
beforeEach(async () => {
  clock = new Date('2026-10-04T06:00:00Z');
  refref.reset();
  logs.lines.length = 0;
  await db.owner.query('TRUNCATE order_event, order_passenger, order_contact, orders');
  await setSalesOpen(db.operator, true, 'test', 'open');
});

interface Reply { status: number; location: string | undefined; setCookie: string[]; body: string }

function http(method: string, path: string, opts: { cookie?: string; form?: Record<string, string> } = {}): Promise<Reply> {
  const payload = opts.form ? new URLSearchParams(opts.form).toString() : undefined;
  return new Promise((resolve, reject) => {
    const req = request(`${base}${path}`, { method, headers: {
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(payload ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(payload)) } : {}),
    } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location,
        setCookie: res.headers['set-cookie'] ?? [], body }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const bookingForm = (seats = 1): Record<string, string> => ({
  departure: 'altai-2026-11-01', termsRef: catalog.terms.ref, termsHash: catalog.terms.hash,
  contactName: 'Иван Петров', contactPhone: '+7 903 907-55-47', contactEmail: 'ivan@example.ru',
  passenger1Name: 'Иван Петров', ...(seats > 1 ? { passenger2Name: 'Анна Петрова' } : {}),
  adultsOnly: 'yes', acceptTerms: 'yes',
});

/** Book, come back from the handoff, and land on the confirmation page. */
async function bookAndResolve(seats = 1): Promise<{ ref: string; cookie: string }> {
  const booked = await http('POST', '/orders', { form: bookingForm(seats) });
  assert.equal(booked.status, 303, booked.body);
  const handoff = new URL(booked.location!);
  const ref = handoff.searchParams.get('merchantOrderRef')!;
  const cookie = booked.setCookie[0]!.split(';')[0]!;
  const back = await http('GET', `/return?rt=${'t'.repeat(40)}&state=${handoff.searchParams.get('state')}`, { cookie });
  assert.equal(back.status, 303, back.body);
  assert.equal(back.location, `/orders/${ref}`);
  return { ref, cookie };
}

const order = async (ref: string) => (await db.owner.query(
  'SELECT status, checkout_attempt_id, hold_reason, payable_kopecks FROM orders WHERE order_ref = $1', [ref])).rows[0];

describe('the paid path', () => {
  test('book → handoff → final price → pay → provider; PAID only from the read-back, then fulfilled once', async () => {
    refref.state.discountKopecks = 100_000;
    const booked = await http('POST', '/orders', { form: bookingForm(2) });
    const handoff = new URL(booked.location!);
    assert.equal(handoff.origin + handoff.pathname, 'https://checkout.refref.example/v1-rc/public/attribution-handoff');
    assert.equal(handoff.searchParams.get('merchant'), 'mikluha');
    assert.equal(handoff.searchParams.get('returnUrl'), 'https://book.mikluha.example/return');
    assert.match(booked.setCookie[0]!, /^__Host-mk_mk-[0-9a-z]{12}=[\w-]+; Path=\/; Secure; HttpOnly; SameSite=Lax/);

    const ref = handoff.searchParams.get('merchantOrderRef')!;
    const cookie = booked.setCookie[0]!.split(';')[0]!;
    await http('GET', `/return?rt=${'t'.repeat(40)}&state=${handoff.searchParams.get('state')}`, { cookie });
    const confirm = await http('GET', `/orders/${ref}`, { cookie });
    assert.match(confirm.body, /Итого к оплате: 67[\s ]?000 ₽/);
    assert.match(confirm.body, /скидка по приглашению 1[\s ]?000 ₽/);

    const paid = await http('POST', `/orders/${ref}/pay`, { cookie });
    assert.equal(paid.location, 'https://pay.alfa.example/form?mdOrder=1');
    const [session] = refref.calls(/\/payment-session$/);
    assert.deepEqual(session!.body, { successUrl: `https://book.mikluha.example/orders/${ref}`, receiptContact: { email: 'ivan@example.ru' } });

    // The customer is back from the bank, but Refref has not accepted a payment: nothing is paid.
    const early = await http('GET', `/orders/${ref}`, { cookie });
    assert.match(early.body, /Проверяем платёж/);
    assert.equal((await order(ref)).status, 'PAYMENT_PENDING');

    refref.state.obligation = 'SATISFIED';
    const done = await http('GET', `/orders/${ref}`, { cookie });
    assert.match(done.body, /Бронирование подтверждено/);
    assert.equal((await order(ref)).status, 'FULFILLED');
    await reconcileAll(deps);
    const acks = refref.calls(/\/fulfillment-ack$/);
    assert.equal(acks.length, 1);
    assert.equal(acks[0]!.key, `mk-fulfil:${ref}`);

    // Refref got the receipt email and nothing else personal; the logs got nothing personal at all.
    const sent = JSON.stringify(refref.requests.map((r) => r.body));
    for (const pd of PD.filter((x) => x !== 'ivan@example.ru')) assert.ok(!sent.includes(pd), `sent to Refref: ${pd}`);
    assert.equal(sent.split('ivan@example.ru').length - 1, 1);
    const logged = logs.lines.join('\n');
    for (const pd of PD) assert.ok(!logged.includes(pd), `logged: ${pd}`);
  });

  test('another browser cannot use the return, see the order or pay it', async () => {
    const booked = await http('POST', '/orders', { form: bookingForm() });
    const handoff = new URL(booked.location!);
    const ref = handoff.searchParams.get('merchantOrderRef')!;
    const stranger = `__Host-mk_${ref}=${'x'.repeat(32)}`;
    const back = await http('GET', `/return?rt=${'t'.repeat(40)}&state=${handoff.searchParams.get('state')}`, { cookie: stranger });
    assert.equal(back.status, 403);
    assert.equal(refref.calls(/referral-resolutions/).length, 0);
    assert.equal((await http('GET', `/orders/${ref}`, { cookie: stranger })).status, 404);
    assert.equal((await http('POST', `/orders/${ref}/pay`)).status, 404);
  });
});

describe('never a second payment after ambiguity', () => {
  test('an unanswered attempt is repeated identically; an unanswered session is re-asked on the same attempt', async () => {
    const { ref, cookie } = await bookAndResolve();
    refref.state.attempt = 'TIMEOUT';
    assert.equal((await http('POST', `/orders/${ref}/pay`, { cookie })).location, `/orders/${ref}`);
    assert.equal((await order(ref)).checkout_attempt_id, null);
    assert.equal(refref.calls(/\/payment-session$/).length, 0);

    refref.state.attempt = 'OK';
    refref.state.session = 'ERROR_500';
    await reconcileAll(deps);
    assert.equal((await http('POST', `/orders/${ref}/pay`, { cookie })).location, `/orders/${ref}`);
    refref.state.session = 'READY';
    assert.equal((await http('POST', `/orders/${ref}/pay`, { cookie })).location, 'https://pay.alfa.example/form?mdOrder=1');

    const creates = refref.calls(/\/checkout-attempts$/);
    assert.ok(creates.length >= 2);
    assert.deepEqual(new Set(creates.map((c) => c.key)), new Set([`mk-attempt:${ref}`]));
    assert.deepEqual(new Set(creates.map((c) => JSON.stringify(c.body))).size, 1);
    assert.equal(refref.attempts.size, 1);
    const attemptId = (await order(ref)).checkout_attempt_id;
    assert.ok(refref.calls(/\/payment-session$/).every((c) => c.path.includes(`/checkout-attempts/${attemptId}/`)));
  });

  test('a definitive failure offers another try on the same attempt', async () => {
    const { ref, cookie } = await bookAndResolve();
    refref.state.session = 'FAILED';
    await http('POST', `/orders/${ref}/pay`, { cookie });
    assert.match((await http('GET', `/orders/${ref}`, { cookie })).body, /Платёж не прошёл[\s\S]*Попробовать ещё раз/);
    refref.state.session = 'READY';
    assert.equal((await http('POST', `/orders/${ref}/pay`, { cookie })).location, 'https://pay.alfa.example/form?mdOrder=1');
    assert.equal(refref.attempts.size, 1);
  });
});

describe('seats come back only when Refref says the money cannot move', () => {
  test('an abandoned payment: cancelled after an hour, and only once Refref agrees', async () => {
    const { ref, cookie } = await bookAndResolve(2);
    await http('POST', `/orders/${ref}/pay`, { cookie });
    refref.state.obligation = 'OUTSTANDING';
    clock = new Date(clock.getTime() + 30 * MINUTE);
    await reconcileAll(deps);
    assert.equal(refref.calls(/\/cancel$/).length, 0);

    clock = new Date(clock.getTime() + 31 * MINUTE);
    refref.state.cancel = { status: 409, code: 'CONFLICT' };
    await reconcileAll(deps);
    assert.equal((await order(ref)).status, 'PAYMENT_PENDING');
    // An hour and more since the reservation: expiry must not free these seats either.
    await maintain(db.pool, () => undefined, clock);
    assert.equal((await http('POST', '/orders', { form: bookingForm(2) })).status, 409);

    refref.state.cancel = 'OK';
    await reconcileAll(deps);
    assert.equal((await order(ref)).status, 'CANCELLED');
    assert.equal(refref.calls(/\/cancel$/).at(-1)!.key, `mk-cancel:${ref}`);
    assert.equal((await http('POST', '/orders', { form: bookingForm(2) })).status, 303);
  });

  test('an attempt Refref refuses outright ends the order; an unexpected refusal holds it', async () => {
    const a = await bookAndResolve();
    refref.state.attempt = { status: 422, code: 'SNAPSHOT_INVALID' };
    await http('POST', `/orders/${a.ref}/pay`, { cookie: a.cookie });
    assert.equal((await order(a.ref)).status, 'CANCELLED');

    const b = await bookAndResolve();
    refref.state.attempt = { status: 409, code: 'LIVE_CHECKOUT_ATTEMPT_EXISTS' };
    await http('POST', `/orders/${b.ref}/pay`, { cookie: b.cookie });
    assert.deepEqual(await order(b.ref).then((o) => [o.status, o.hold_reason]), ['HELD', 'ATTEMPT_REFUSED:LIVE_CHECKOUT_ATTEMPT_EXISTS']);
  });
});

describe('the booking switch', () => {
  test('closed: no new payment is started, but a payment in flight is still read back and fulfilled', async () => {
    const a = await bookAndResolve();
    await http('POST', `/orders/${a.ref}/pay`, { cookie: a.cookie });
    const b = await bookAndResolve();
    await setSalesOpen(db.operator, false, 'test', 'stop-sales');
    const before = refref.requests.length;
    const refused = await http('POST', `/orders/${b.ref}/pay`, { cookie: b.cookie });
    assert.equal(refused.location, `/orders/${b.ref}?notice=SALES_CLOSED`);
    assert.equal(refref.requests.length, before);
    assert.equal((await order(b.ref)).status, 'RESERVED');

    refref.state.obligation = 'SATISFIED';
    await reconcileAll(deps);
    assert.equal((await order(a.ref)).status, 'FULFILLED');
  });
});

describe('stop-sales against a payment session already being started (PR #19 review)', () => {
  const pending = (ms: number) => new Promise<'PENDING'>((r) => setTimeout(() => r('PENDING'), ms));

  /** An order whose first session failed definitively: the next /pay goes straight to a new session. */
  async function retryableOrder() {
    const o = await bookAndResolve();
    refref.state.session = 'FAILED';
    await http('POST', `/orders/${o.ref}/pay`, { cookie: o.cookie });
    refref.state.session = 'READY';
    return o;
  }

  test('a close committed after the switch was read but before the session: no session is started', async () => {
    const { ref, cookie } = await retryableOrder();
    const sessionsBefore = refref.calls(/\/payment-session$/).length;
    // The operator's close is under way: its row lock is taken, its commit not yet made.
    const operator = await db.operator.connect();
    let paying: Promise<Reply> | undefined;
    try {
      await operator.query('BEGIN');
      await operator.query(`SELECT fn_set_sales_open(false, 'artur', 'stop-sales')`);
      paying = http('POST', `/orders/${ref}/pay`, { cookie });
      // /pay cannot get past the switch while the close is in flight…
      assert.equal(await Promise.race([paying.then(() => 'DONE'), pending(300)]), 'PENDING');
      await operator.query('COMMIT');
    } finally {
      await operator.query('ROLLBACK').catch(() => undefined);
      operator.release();
      await paying?.catch(() => undefined);
    }
    // …and once the close commits, it sees it: nothing new is sent to Refref.
    assert.equal((await paying!).location, `/orders/${ref}?notice=SALES_CLOSED`);
    assert.equal(refref.calls(/\/payment-session$/).length, sessionsBefore);
  });

  test('a session already being started holds the close until it has been made', async () => {
    const { ref, cookie } = await retryableOrder();
    const gate = refref.holdSessions();
    const paying = http('POST', `/orders/${ref}/pay`, { cookie });
    await gate.arrived;
    const closing = setSalesOpen(db.operator, false, 'artur', 'stop-sales');
    try {
      assert.equal(await Promise.race([closing.then(() => 'DONE'), pending(300)]), 'PENDING');
    } finally {
      gate.release();
    }
    assert.equal((await paying).location, 'https://pay.alfa.example/form?mdOrder=1');
    await closing;
    // From here on, nothing starts.
    assert.equal((await http('POST', '/orders', { form: bookingForm() })).status, 409);
    assert.equal((await http('POST', `/orders/${ref}/pay`, { cookie })).location, `/orders/${ref}?notice=SALES_CLOSED`);
  });
});

describe("the read-back's verdict", () => {
  const attempt = (o: Partial<CheckoutAttempt['obligations'][0]>, status: CheckoutAttempt['status'] = 'OPEN'): CheckoutAttempt => ({
    id: 'a', status, snapshotHash: 'h', obligations: [{ obligationRef: 'full', status: 'SATISFIED', amountKopecks: 100,
      payment: { id: 'p', status: 'SUCCEEDED', amountKopecks: 100 }, ...o }],
  });
  const now = new Date();
  test('paid only for a SUCCEEDED payment of exactly the payable amount', () => {
    assert.equal(verdict(attempt({}), 100, 'h', false, now).kind, 'PAID');
    assert.deepEqual(verdict(attempt({ payment: { id: 'p', status: 'SUCCEEDED', amountKopecks: 99 } }), 100, 'h', false, now),
      { kind: 'HELD', reason: 'PAYMENT_AMOUNT_MISMATCH' });
    assert.deepEqual(verdict(attempt({}), 100, 'other', false, now), { kind: 'HELD', reason: 'SNAPSHOT_DIVERGED' });
    assert.deepEqual(verdict(attempt({ status: 'LATE_PAYMENT' }), 100, 'h', false, now), { kind: 'HELD', reason: 'LATE_PAYMENT' });
  });
  test('an ended attempt frees the order only if no money moved', () => {
    assert.deepEqual(verdict(attempt({ status: 'CANCELLED', payment: null }, 'CANCELLED'), 100, 'h', false, now),
      { kind: 'CANCELLED', reason: 'ATTEMPT_CANCELLED' });
    assert.deepEqual(verdict(attempt({ status: 'CANCELLED' }, 'CANCELLED'), 100, 'h', false, now),
      { kind: 'HELD', reason: 'ENDED_WITH_PAYMENT' });
    assert.equal(verdict(attempt({ status: 'IN_PROGRESS', payment: null }), 100, 'h', true, now).kind, 'WAIT');
    assert.equal(verdict(attempt({ status: 'OUTSTANDING', payment: null }), 100, 'h', true, now).kind, 'ABANDONED');
  });
});
