// The whole checkout through the real HTTP routes, a real Postgres (as the runtime role) and a model
// of Refref (fake-refref.ts).
import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';

import type { Catalog } from '../src/catalog.js';
import { pay, reconcileAll, verdict, zayavkaOf, type CheckoutDeps } from '../src/checkout.js';
import { contractHash } from '../src/zayavka.js';
import { schemaHead } from '../src/migrate.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import { maintain, setSalesOpen } from '../src/orders.js';
import { BookingRateLimiter } from '../src/rate-limit.js';
import { RefrefClient, type CheckoutAttempt } from '../src/refref.js';
import { createCommerceServer } from '../src/server.js';
import { createWebHandler } from '../src/web.js';
import { FakeRefref } from './fake-refref.js';
import { captureLog, fixtureCatalog, freshDb, type TestDb } from './helpers.js';

const MERCHANT_ID = '3f1c2a5e-8b4d-4c7e-9a10-2b6d8e4f1a90';
const MINUTE = 60_000;
const PD = ['Иван', 'Петров', 'Анна', '9039075547', 'ivan@example.ru', '654321', '765432', '1990-05-17'];

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
      origin: 'https://book.mikluha.example', siteOrigin: 'https://mikluha.example' },
  };
  server = createCommerceServer({ pool: db.pool, catalog, schemaHead: schemaHead(MIGRATIONS_DIR), sourceCommit: null,
    startedAt: new Date() }, createWebHandler(deps, false,
    new BookingRateLimiter({ ipLimit: 10_000, emailLimit: 10_000 })));
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
  await db.owner.query('TRUNCATE order_eis_event, order_eis, email_outbox, order_document, order_event, order_passenger, order_contact, orders');
  await setSalesOpen(db.operator, true, 'test', 'open');
});

interface Reply { status: number; location: string | undefined; setCookie: string[]; retryAfter: string | undefined; body: string }

function http(method: string, path: string, opts: { cookie?: string; form?: Record<string, string>; raw?: string;
  headers?: Record<string, string>; origin?: string } = {}): Promise<Reply> {
  const payload = opts.form ? new URLSearchParams(opts.form).toString() : opts.raw;
  return new Promise((resolve, reject) => {
    const req = request(`${opts.origin ?? base}${path}`, { method, headers: {
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(payload ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(Buffer.byteLength(payload)) } : {}),
      ...opts.headers,
    } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location,
        setCookie: res.headers['set-cookie'] ?? [], retryAfter: res.headers['retry-after'], body }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const touristFields = (i: number, name: string, series: string, number: string): Record<string, string> => ({
  [`t${i}Name`]: name, [`t${i}Dob`]: '1990-05-17', [`t${i}Citizenship`]: 'RU',
  [`t${i}DocType`]: 'RU_PASSPORT', [`t${i}DocSeries`]: series, [`t${i}DocNumber`]: number,
});

describe('booking HTTP boundaries', () => {
  test('booking and identity expose the site visual system and exact legal release identities', async () => {
    const form = await http('GET', '/book?departure=altai-2026-11-01');
    assert.equal(form.status, 200);
    assert.match(form.body, /--rust:#bd623c/);
    assert.match(form.body, /class="steps"/);
    assert.match(form.body, /Перейти к проверке заявки/);
    const identity = await http('GET', '/identity');
    assert.deepEqual(JSON.parse(identity.body), {
      service: 'mikluha-commerce', sourceCommit: null, schemaHead: schemaHead(MIGRATIONS_DIR),
      startedAt: JSON.parse(identity.body).startedAt,
      termsRef: catalog.terms.ref, termsHash: catalog.terms.hash,
      pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash,
    });
  });

  test('the form body is capped before an order can be inserted', async () => {
    const response = await http('POST', '/orders', { raw: `x=${'a'.repeat(8 * 1024)}` });
    assert.equal(response.status, 400);
    assert.match(response.body, /Форма заполнена неверно/);
    assert.equal((await db.owner.query('SELECT count(*) FROM orders')).rows[0].count, '0');
  });

  test('POST /orders uses per-IP buckets and one shared untrusted-ingress bucket', async () => {
    const limited = createCommerceServer({ pool: db.pool, catalog, schemaHead: schemaHead(MIGRATIONS_DIR), sourceCommit: null,
      startedAt: new Date() }, createWebHandler(deps, false,
      new BookingRateLimiter({ ipLimit: 1, emailLimit: 10, windowMs: 60_000 })));
    await new Promise<void>((resolve) => limited.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`;
    try {
      assert.equal((await http('POST', '/orders', { origin, form: bookingForm(), headers: { 'x-forwarded-for': '203.0.113.10' } })).status, 303);
      const repeated = await http('POST', '/orders', { origin, form: bookingForm(), headers: { 'x-forwarded-for': '203.0.113.10' } });
      assert.equal(repeated.status, 429);
      assert.equal(repeated.retryAfter, '60');
      assert.equal((await http('POST', '/orders', { origin, form: bookingForm(), headers: { 'x-forwarded-for': '203.0.113.11' } })).status, 303);
      assert.equal((await http('POST', '/orders', { origin, form: bookingForm() })).status, 303);
      assert.equal((await http('POST', '/orders', { origin, form: bookingForm(), headers: { 'x-forwarded-for': '203.0.113.12, 10.0.0.1' } })).status, 429);
    } finally {
      limited.closeAllConnections();
      await new Promise<void>((resolve, reject) => limited.close((e) => e ? reject(e) : resolve()));
    }
  });
});

/** POST /pay as the confirmation page's form does: with the hash of the Заявка it showed. */
async function payOrder(ref: string, cookie: string, zayavka?: string): Promise<Reply> {
  const { rows } = await db.owner.query(`SELECT d.sha256 FROM order_document d JOIN orders o ON o.id = d.order_id
    WHERE o.order_ref = $1`, [ref]);
  return http('POST', `/orders/${ref}/pay`, { cookie, form: { zayavka: zayavka ?? rows[0]?.sha256 ?? '' } });
}

const bookingForm = (seats = 1): Record<string, string> => ({
  departure: 'altai-2026-11-01', termsRef: catalog.terms.ref, termsHash: catalog.terms.hash,
  pdConsent: 'yes', pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash,
  contactPhone: '+7 903 907-55-47', contactEmail: 'ivan@example.ru',
  adultsOnly: 'yes',
  ...touristFields(1, 'Иван Петров', '3210', '654321'),
  ...(seats > 1 ? touristFields(2, 'Анна Петрова', '3211', '765432') : {}),
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
  test('a later catalog cannot change the reserved schedule in the accepted application or Refref payment line', async () => {
    const { ref } = await bookAndResolve();
    const d = catalog.departures.get('altai-2026-11-01')!;
    const later = { ...catalog, timezone: 'Europe/Moscow', departures: new Map(catalog.departures).set(d.slug,
      { ...d, contract: { ...d.contract!, departure: { ...d.contract!.departure, departureTime: '10:00', returnTime: '18:00' } } }) };
    const shown = await zayavkaOf(db.pool, ref);
    assert.ok(shown?.content);
    assert.match(shown.content, /06:00 \(Asia\/Krasnoyarsk\)/);
    assert.equal((await pay({ ...deps, catalog: later }, ref, shown!.sha256)).kind, 'REDIRECT');
    const stored = (await db.owner.query('SELECT snapshot FROM orders WHERE order_ref = $1', [ref])).rows[0].snapshot;
    assert.equal(stored.lines[0].serviceStartsAt, '2026-10-31T23:00:00Z');
    assert.equal(stored.lines[0].serviceEndsAt, '2026-11-04T14:00:00Z');
    assert.equal((await zayavkaOf(db.pool, ref))!.sha256, shown!.sha256);
    await assert.rejects(db.pool.query("UPDATE orders SET trip_departure_time = '10:00' WHERE order_ref = $1", [ref]), /FROZEN_TRIP_SCHEDULE_IMMUTABLE/);
  });

  test('legacy unresolved schedule is not guessed from current catalog and cannot start a payment', async () => {
    const { ref } = await bookAndResolve();
    // Simulate a historical row carried through migration 0007 (which does NOT backfill times).
    await db.owner.query('ALTER TABLE orders DISABLE TRIGGER trg_frozen_trip_schedule');
    try {
      await db.owner.query('UPDATE orders SET trip_departure_time = NULL, trip_return_time = NULL, trip_timezone = NULL WHERE order_ref = $1', [ref]);
    } finally { await db.owner.query('ALTER TABLE orders ENABLE TRIGGER trg_frozen_trip_schedule'); }
    const shown = await zayavkaOf(db.pool, ref);
    assert.deepEqual(await pay(deps, ref, shown!.sha256), { kind: 'STATUS', code: 'TRIP_SCHEDULE_MISSING' });
    assert.equal(refref.attempts.size, 0);
    assert.equal((await order(ref)).status, 'RESERVED');
  });
  test('documented-expense policy blocks payment initiation even for an existing resolved order', async () => {
    const { ref } = await bookAndResolve();
    const blocked = { ...deps, catalog: { ...catalog, launchReady: true, refundPolicy: 'DOCUMENTED_EXPENSES' as const } };
    const shown = await zayavkaOf(db.pool, ref);
    assert.deepEqual(await pay(blocked, ref, shown!.sha256), { kind: 'STATUS', code: 'REFUND_WORKFLOW_UNQUALIFIED' });
    assert.equal((await order(ref)).status, 'RESERVED');
    assert.equal((await order(ref)).checkout_attempt_id, null);
    assert.equal(refref.attempts.size, 0);
    assert.equal(refref.requests.some((r) => r.path.endsWith('/checkout-attempts') || r.path.endsWith('/payment-session')), false);
  });
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

    const paid = await payOrder(ref, cookie);
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
    assert.match(done.body, /Тестовая публичная оферта/);
    assert.match(done.body, new RegExp(`Заявка на бронирование № ${ref}`));
    assert.equal((await order(ref)).status, 'FULFILLED');
    assert.deepEqual((await db.owner.query(`SELECT type, recipient_email, idempotency_key, state, attempts
      FROM email_outbox`)).rows, [{ type: 'BOOKING_CONFIRMATION', recipient_email: 'ivan@example.ru',
      idempotency_key: `mk-confirm:${ref}`, state: 'PENDING', attempts: 0 }]);
    assert.deepEqual((await db.owner.query(`SELECT e.status, e.electronic_voucher_number
      FROM order_eis e JOIN orders o ON o.id = e.order_id WHERE o.order_ref = $1`, [ref])).rows,
    [{ status: 'EIS_PENDING', electronic_voucher_number: null }]);
    assert.deepEqual((await db.owner.query(`SELECT x.to_status, x.changed_by, x.login_role, x.reason
      FROM order_eis_event x JOIN orders o ON o.id = x.order_id WHERE o.order_ref = $1`, [ref])).rows,
    [{ to_status: 'EIS_PENDING', changed_by: 'system:payment', login_role: 'commerce_test_runtime',
      reason: 'PAYMENT_CONFIRMED' }]);
    const token = (await db.owner.query('SELECT access_token FROM email_outbox')).rows[0].access_token;
    const shared = await http('GET', `/documents/${token}`);
    assert.equal(shared.status, 200);
    assert.match(shared.body, /Тестовая публичная оферта/);
    assert.match(shared.body, new RegExp(`Заявка на бронирование № ${ref}`));
    await reconcileAll(deps);
    await assert.rejects(db.pool.query(`INSERT INTO email_outbox
      (order_id, type, recipient_email, access_token, idempotency_key, state, attempts, next_attempt_at, created_at)
      SELECT id, 'BOOKING_CONFIRMATION', 'other@example.ru', $2, 'other-key', 'PENDING', 0, now(), now()
      FROM orders WHERE order_ref = $1`, [ref, 'b'.repeat(43)]), /duplicate key/);
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

describe('the Заявка: shown before paying, accepted by paying, frozen after', () => {
  test('payment fails closed if the live public legal release changed after reservation', async () => {
    const { ref } = await bookAndResolve();
    const document = await zayavkaOf(db.pool, ref);
    assert.ok(document);
    const result = await pay({ ...deps, legalAdmission: { verify: async () => { throw new Error('site drift'); } } }, ref, document.sha256);
    assert.deepEqual(result, { kind: 'STATUS', code: 'LEGAL_RELEASE_NOT_ADMITTED' });
    assert.equal((await order(ref)).status, 'RESERVED');
    assert.equal(refref.calls(/\/checkout-attempts$/).length, 0);
  });

  test('the confirmation page shows the order\'s Заявка; Refref gets the contract hash over the offer and it', async () => {
    const { ref, cookie } = await bookAndResolve(2);
    const page = (await http('GET', `/orders/${ref}`, { cookie })).body;
    for (const expected of [`Заявка на бронирование № ${ref}`, 'Иван Петров', 'Анна Петрова', 'Паспорт гражданина РФ: 3210 654321',
      'Россия', '17.05.1990', 'Гостевой дом «Озеро»', 'ООО «Перевозчик»', 'День 1. Кемерово — Телецкое озеро', 'Версия Оферты',
      'oferta@2026-10-04', 'Оплачивая заказ, я подтверждаю']) {
      assert.ok(page.includes(expected), `the confirmation page lacks ${expected}`);
    }
    await payOrder(ref, cookie);
    const [create] = refref.calls(/\/checkout-attempts$/);
    const snapshot = (create!.body as { snapshot: { legalReleaseRef: string; legalReleaseHash: string } }).snapshot;
    const doc = (await db.owner.query('SELECT sha256 FROM order_document')).rows[0];
    assert.equal(snapshot.legalReleaseRef, catalog.terms.ref);
    assert.equal(snapshot.legalReleaseHash, contractHash(catalog.terms.ref, catalog.terms.hash, doc.sha256));
    assert.doesNotMatch(JSON.stringify(snapshot), /soglasie-pd|pdConsent/i);
  });

  test('a Заявка other than the one stored is refused, and nothing is sent', async () => {
    const { ref, cookie } = await bookAndResolve();
    const r = await payOrder(ref, cookie, 'f'.repeat(64));
    assert.equal(r.location, `/orders/${ref}?notice=DOCUMENT_CHANGED`);
    assert.equal((await order(ref)).status, 'RESERVED');
    assert.equal(refref.calls(/\/checkout-attempts$/).length, 0);
  });

  test('payment fails closed when the stored consent no longer hashes to what the form showed', async () => {
    const { ref, cookie } = await bookAndResolve();
    await db.owner.query(`UPDATE orders SET pd_consent_content = pd_consent_content || ' forged' WHERE order_ref = $1`, [ref]);
    const result = await payOrder(ref, cookie);
    assert.equal(result.location, `/orders/${ref}?notice=PD_CONSENT_INVALID`);
    assert.equal((await order(ref)).status, 'RESERVED');
    assert.equal(refref.calls(/\/checkout-attempts$/).length, 0);
  });

  test('payment fails closed when the stored offer no longer hashes to what the form showed', async () => {
    const { ref, cookie } = await bookAndResolve();
    await db.owner.query(`UPDATE orders SET legal_release_content = legal_release_content || ' forged' WHERE order_ref = $1`, [ref]);
    const result = await payOrder(ref, cookie);
    assert.equal(result.location, `/orders/${ref}?notice=LEGAL_RELEASE_INVALID`);
    assert.equal((await order(ref)).status, 'RESERVED');
    assert.equal(refref.calls(/\/checkout-attempts$/).length, 0);
  });

  const document = async () => (await db.owner.query('SELECT content IS NOT NULL AS kept, sha256 FROM order_document')).rows[0];
  const contactRows = async () => Number((await db.owner.query('SELECT count(*) FROM order_contact')).rows[0].count);

  test('once paid, the Заявка cannot change and is kept as the contract for 3 years after the trip (ПП №748)', async () => {
    const { ref, cookie } = await bookAndResolve();
    await payOrder(ref, cookie);
    await assert.rejects(db.pool.query(`UPDATE order_document SET content = 'forged'`), /ORDER_DOCUMENT_FROZEN/);
    refref.state.obligation = 'SATISFIED';
    await reconcileAll(deps);
    // The trip ends 2026-11-04. 90 days later the operational personal data is gone, the contract is not.
    await maintain(db.pool, () => undefined, new Date('2027-03-01T00:00:00Z'));
    assert.equal(await contactRows(), 0);
    assert.equal((await db.owner.query('SELECT recipient_email FROM email_outbox')).rows[0].recipient_email, null);
    assert.equal((await document()).kept, true);
    await maintain(db.pool, () => undefined, new Date('2029-11-04T12:00:00Z'));
    assert.equal((await document()).kept, true);
    // A legal hold keeps it past 3 years; released, it goes, and its hash stays.
    await db.owner.query(`UPDATE orders SET legal_hold = true, legal_hold_reason = 'claim'`);
    await maintain(db.pool, () => undefined, new Date('2029-11-06T12:00:00Z'));
    assert.equal((await document()).kept, true);
    await db.owner.query(`UPDATE orders SET legal_hold = false, legal_hold_reason = NULL`);
    assert.equal((await maintain(db.pool, () => undefined, new Date('2029-11-06T12:00:00Z'))).contractsErased, 1);
    const d = await document();
    assert.equal(d.kept, false);
    assert.match(d.sha256, /^[0-9a-f]{64}$/);
  });

  /** A paid, fulfilled order (trip 2026-11-04) with its Заявка. */
  async function fulfilledOrder(): Promise<string> {
    const { ref, cookie } = await bookAndResolve();
    await payOrder(ref, cookie);
    refref.state.obligation = 'SATISFIED';
    await reconcileAll(deps);
    assert.equal((await order(ref)).status, 'FULFILLED');
    return ref;
  }
  const at = (iso: string) => maintain(db.pool, () => undefined, new Date(iso));

  test('retention follows the contract\'s end: an old PAID order is never erased', async () => {
    const ref = await fulfilledOrder();
    // Paid, but the contract is still open (fulfilment not confirmed): no end, no clock.
    await db.owner.query(`UPDATE orders SET status = 'PAID', fulfilled_at = NULL WHERE order_ref = $1`, [ref]);
    await at('2040-01-01T00:00:00Z');
    assert.equal((await document()).kept, true);
  });

  test('a FULFILLED order: 3 years from the trip\'s end', async () => {
    await fulfilledOrder();
    await at('2029-11-04T12:00:00Z');
    assert.equal((await document()).kept, true);
    await at('2029-11-05T12:00:00Z');
    assert.equal((await document()).kept, false);
  });

  test('a REFUNDED order: 3 years from the refund, also when it came after the trip', async () => {
    const ref = await fulfilledOrder();
    await db.owner.query(`UPDATE orders SET status = 'REFUNDED', closed_at = '2030-06-01T10:00:00Z' WHERE order_ref = $1`, [ref]);
    // Long past trip end + 3 years, but not refund + 3 years.
    await at('2033-05-31T10:00:00Z');
    assert.equal((await document()).kept, true);
    await at('2033-06-02T10:00:00Z');
    assert.equal((await document()).kept, false);
  });

  test('an order never paid concluded no contract: its Заявка goes with the rest within 24 hours', async () => {
    await bookAndResolve();
    const ended = new Date(clock.getTime() + 60 * MINUTE);
    await maintain(db.pool, () => undefined, ended);
    assert.equal((await document()).kept, true);
    await maintain(db.pool, () => undefined, new Date(ended.getTime() + 24 * 60 * MINUTE));
    assert.equal((await document()).kept, false);
    assert.equal(await contactRows(), 0);
  });

  test('the customer is tourist №1: their name in the Заявка is that tourist\'s', async () => {
    const { ref, cookie } = await bookAndResolve(2);
    const page = (await http('GET', `/orders/${ref}`, { cookie })).body;
    assert.match(page, /<h3>1\. Заказчик<\/h3>\s*<table><tr><th>ФИО<\/th><td>Иван Петров<\/td>/);
    assert.match(page, /Заказчик является туристом<\/th><td>Да, турист № 1/);
  });
});

describe('never a second payment after ambiguity', () => {
  test('an accepted attempt with a lost response is recovered from the merchant-order projection', async () => {
    const { ref, cookie } = await bookAndResolve();
    refref.state.attempt = 'ACCEPTED_TIMEOUT';
    assert.equal((await payOrder(ref, cookie)).location, 'https://pay.alfa.example/form?mdOrder=1');
    assert.equal(refref.calls(/\/checkout-attempts$/).length, 1);
    assert.equal(refref.calls(/\/merchant-orders\//, 'GET').length, 1);
    assert.equal((await order(ref)).checkout_attempt_id, [...refref.attempts.values()][0]!.id);
    assert.deepEqual((await db.owner.query(`SELECT event FROM order_event WHERE order_id =
      (SELECT id FROM orders WHERE order_ref = $1) AND event = 'ATTEMPT_RECOVERED'`, [ref])).rows,
    [{ event: 'ATTEMPT_RECOVERED' }]);
  });

  test('merchant-order recovery holds a projection that does not match the frozen attempt facts', async () => {
    const { ref, cookie } = await bookAndResolve();
    refref.state.attempt = 'ACCEPTED_TIMEOUT';
    refref.state.projectionMismatch = true;
    assert.equal((await payOrder(ref, cookie)).location, `/orders/${ref}`);
    assert.deepEqual(await order(ref).then((o) => [o.status, o.hold_reason]), ['HELD', 'ATTEMPT_RECOVERY_MISMATCH']);
    assert.equal(refref.calls(/\/payment-session$/).length, 0);
  });

  test('merchant-order recovery also binds the frozen referral resolution', async () => {
    const { ref, cookie } = await bookAndResolve();
    refref.state.attempt = 'ACCEPTED_TIMEOUT';
    refref.state.projectionResolutionMismatch = true;
    assert.equal((await payOrder(ref, cookie)).location, `/orders/${ref}`);
    assert.deepEqual(await order(ref).then((o) => [o.status, o.hold_reason]), ['HELD', 'ATTEMPT_RECOVERY_MISMATCH']);
    assert.equal(refref.calls(/\/payment-session$/).length, 0);
  });

  test('an unanswered attempt is repeated identically; an unanswered session is re-asked on the same attempt', async () => {
    const { ref, cookie } = await bookAndResolve();
    refref.state.attempt = 'TIMEOUT';
    assert.equal((await payOrder(ref, cookie)).location, `/orders/${ref}`);
    assert.equal((await order(ref)).checkout_attempt_id, null);
    assert.equal(refref.calls(/\/payment-session$/).length, 0);

    refref.state.attempt = 'OK';
    refref.state.session = 'ERROR_500';
    await reconcileAll(deps);
    assert.equal((await payOrder(ref, cookie)).location, `/orders/${ref}`);
    refref.state.session = 'READY';
    assert.equal((await payOrder(ref, cookie)).location, 'https://pay.alfa.example/form?mdOrder=1');

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
    await payOrder(ref, cookie);
    assert.match((await http('GET', `/orders/${ref}`, { cookie })).body, /Платёж не прошёл[\s\S]*Попробовать ещё раз/);
    refref.state.session = 'READY';
    assert.equal((await payOrder(ref, cookie)).location, 'https://pay.alfa.example/form?mdOrder=1');
    assert.equal(refref.attempts.size, 1);
  });
});

describe('seats come back only when Refref says the money cannot move', () => {
  test('an abandoned payment: cancelled after an hour, and only once Refref agrees', async () => {
    const { ref, cookie } = await bookAndResolve(2);
    await payOrder(ref, cookie);
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
    await payOrder(a.ref, a.cookie);
    assert.equal((await order(a.ref)).status, 'CANCELLED');

    const b = await bookAndResolve();
    refref.state.attempt = { status: 409, code: 'LIVE_CHECKOUT_ATTEMPT_EXISTS' };
    await payOrder(b.ref, b.cookie);
    assert.deepEqual(await order(b.ref).then((o) => [o.status, o.hold_reason]), ['HELD', 'ATTEMPT_REFUSED:LIVE_CHECKOUT_ATTEMPT_EXISTS']);
  });
});

describe('the booking switch', () => {
  test('closed: no new payment is started, but a payment in flight is still read back and fulfilled', async () => {
    const a = await bookAndResolve();
    await payOrder(a.ref, a.cookie);
    const b = await bookAndResolve();
    await setSalesOpen(db.operator, false, 'test', 'stop-sales');
    const before = refref.requests.length;
    const refused = await payOrder(b.ref, b.cookie);
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
    await payOrder(o.ref, o.cookie);
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
      paying = payOrder(ref, cookie);
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
    const paying = payOrder(ref, cookie);
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
    assert.equal((await payOrder(ref, cookie)).location, `/orders/${ref}?notice=SALES_CLOSED`);
  });
});

describe("the read-back's verdict", () => {
  const attempt = (o: Partial<CheckoutAttempt['obligations'][0]>, status: CheckoutAttempt['status'] = 'OPEN'): CheckoutAttempt => ({
    id: 'a', status, snapshotHash: 'h', referralResolutionId: 'resolution',
    obligations: [{ obligationRef: 'full', status: 'SATISFIED', amountKopecks: 100,
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
