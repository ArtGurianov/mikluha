import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import pg from 'pg';

import type { Catalog } from '../src/catalog.js';
import { maintain, reserve, salesOpen, setSalesOpen, type BookingRequest, type OrderDeps } from '../src/orders.js';
import { captureLog, fixtureCatalog, forceStatus, freshDb, type TestDb } from './helpers.js';

const NOW = new Date('2026-10-04T06:00:00Z');
const HOUR = 3_600_000;

let db: TestDb;
let catalog: Catalog;

const request = (over: Partial<BookingRequest> = {}): BookingRequest => ({
  departureSlug: 'altai-2026-11-01',
  contact: { fullName: 'Иван Петров', phone: '+7 (903) 907-55-47', email: 'Ivan@Example.ru' },
  passengers: [{ fullName: 'Иван Петров' }],
  adultsOnlyConfirmed: true,
  termsRef: catalog.terms.ref,
  termsHash: catalog.terms.hash,
  ...over,
});

const deps = (over: Partial<OrderDeps> = {}): OrderDeps =>
  ({ pool: db.pool, catalog, log: () => undefined, allowDemo: false, now: () => NOW, ...over });

before(async () => {
  db = await freshDb();
  catalog = fixtureCatalog([
    { slug: 'altai-2026-11-01', startsOn: '2026-11-01', endsOn: '2026-11-04', capacity: 3 },
    { slug: 'altai-dob', startsOn: '2026-11-10', requiresDateOfBirth: true },
    { slug: 'altai-demo', startsOn: '2026-11-10', isDemo: true },
    { slug: 'altai-closed', startsOn: '2026-11-10', status: 'CLOSED' },
    { slug: 'altai-no-capacity', startsOn: '2026-11-10', capacity: null },
    { slug: 'altai-today', startsOn: '2026-10-04' },
  ]);
});
after(async () => { await db.drop(); });
beforeEach(async () => {
  await db.owner.query('TRUNCATE order_event, order_passenger, order_contact, orders');
  await setSalesOpen(db.operator, true, 'test', 'open for the test');
});

describe('the booking switch', () => {
  test('a new database is closed, and a closed switch refuses every booking', async () => {
    const fresh = await freshDb();
    try {
      assert.equal(await salesOpen(fresh.pool), false);
      const r = await reserve({ ...deps(), pool: fresh.pool }, request());
      assert.deepEqual(r, { ok: false, refusal: 'SALES_CLOSED' });
    } finally { await fresh.drop(); }
  });

  test('an operator closes it; the event records who, why and the database login that did it', async () => {
    await setSalesOpen(db.operator, false, 'artur', 'stop-sales condition 2');
    assert.deepEqual(await reserve(deps(), request()), { ok: false, refusal: 'SALES_CLOSED' });
    const { rows } = await db.owner.query('SELECT open, changed_by, login_role, reason FROM sales_switch_event ORDER BY id DESC LIMIT 1');
    assert.deepEqual(rows[0], { open: false, changed_by: 'artur', login_role: 'commerce_test_operator', reason: 'stop-sales condition 2' });
  });

  test('the service can never change it: not by the function, not directly', async () => {
    await setSalesOpen(db.operator, false, 'artur', 'closed by an operator');
    await assert.rejects(setSalesOpen(db.pool, true, 'artur', 'reopened by the service'), /permission denied for function fn_set_sales_open/);
    await assert.rejects(db.pool.query('UPDATE sales_switch SET open = true'), /permission denied/);
    await assert.rejects(db.pool.query('INSERT INTO sales_switch_event (open, changed_at, changed_by, login_role, reason) VALUES (true, now(), $1, $1, $1)', ['x']), /permission denied/);
    await assert.rejects(db.pool.query('DELETE FROM orders'), /permission denied/);
    assert.equal(await salesOpen(db.pool), false);
  });

  test('a login that is both operator and service is refused by the function itself', async () => {
    await db.owner.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_test_both') THEN
        CREATE ROLE commerce_test_both LOGIN PASSWORD 'commerce-test-only' IN ROLE commerce_app, commerce_operator;
      END IF; END $$`);
    const u = new URL(db.url);
    u.username = 'commerce_test_both';
    u.password = 'commerce-test-only';
    const both = new pg.Pool({ connectionString: u.toString(), max: 1 });
    try {
      await assert.rejects(setSalesOpen(both, false, 'artur', 'misconfigured login'), /SALES_SWITCH_SERVICE_LOGIN/);
    } finally { await both.end(); }
  });
});

describe('what can be sold', () => {
  test('the full price per seat, frozen on the order', async () => {
    const r = await reserve(deps(), request({ passengers: [{ fullName: 'Иван Петров' }, { fullName: 'Анна Петрова' }] }));
    assert.ok(r.ok);
    assert.equal(r.amountKopecks, 2 * 34000 * 100);
    const { rows } = await db.owner.query('SELECT seats, unit_price_kopecks, amount_kopecks, status FROM orders');
    assert.deepEqual(rows[0], { seats: 2, unit_price_kopecks: '3400000', amount_kopecks: '6800000', status: 'RESERVED' });
  });

  test('only an OPEN, listed, priced departure with a capacity that has not started; demo nowhere but staging', async () => {
    const refusal = async (slug: string, allowDemo = false) => {
      const r = await reserve(deps({ allowDemo }), request({ departureSlug: slug }));
      return r.ok ? 'OK' : r.refusal;
    };
    assert.equal(await refusal('altai-closed'), 'DEPARTURE_NOT_OPEN');
    assert.equal(await refusal('altai-no-capacity'), 'DEPARTURE_NO_CAPACITY');
    assert.equal(await refusal('altai-today'), 'DEPARTURE_STARTED');
    assert.equal(await refusal('nowhere'), 'DEPARTURE_UNKNOWN');
    assert.equal(await refusal('altai-demo'), 'DEPARTURE_DEMO');
    assert.equal(await refusal('altai-demo', true), 'OK');
  });

  test('the terms accepted must be the ones published now, and adults only must be confirmed', async () => {
    assert.deepEqual(await reserve(deps(), request({ termsHash: `sha256:${'0'.repeat(64)}` })), { ok: false, refusal: 'TERMS_NOT_CURRENT' });
    assert.deepEqual(await reserve(deps(), request({ adultsOnlyConfirmed: false })), { ok: false, refusal: 'ADULTS_ONLY_NOT_CONFIRMED' });
  });
});

describe('seats', () => {
  test('ten customers racing for three seats: exactly three get one', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => reserve(deps(), request())));
    assert.equal(results.filter((r) => r.ok).length, 3);
    assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.refusal === 'NOT_ENOUGH_SEATS'));
  });

  test('an unpaid reservation frees its seats when it expires; a pending payment never does', async () => {
    const a = await reserve(deps(), request({ passengers: [{ fullName: 'Иван Петров' }, { fullName: 'Анна Петрова' }] }));
    const b = await reserve(deps(), request());
    assert.ok(a.ok && b.ok);
    await forceStatus(db.owner, b.orderRef, 'PAYMENT_PENDING');
    const later = new Date(NOW.getTime() + HOUR);
    assert.deepEqual(await maintain(db.pool, () => undefined, later), { expired: 1, erased: 0 });
    // a's two seats are free again; b's pending one is not.
    const c = await reserve(deps({ now: () => later }), request({ passengers: [{ fullName: 'Олег Сидоров' }, { fullName: 'Мария Сидорова' }] }));
    assert.ok(c.ok);
    assert.deepEqual(await reserve(deps({ now: () => later }), request()), { ok: false, refusal: 'NOT_ENOUGH_SEATS' });
  });
});

describe('personal data', () => {
  test('a date of birth is collected only where the departure requires it, and proves an adult', async () => {
    const dob = (dateOfBirth?: string) => request({ departureSlug: 'altai-dob',
      passengers: [{ fullName: 'Иван Петров', ...(dateOfBirth === undefined ? {} : { dateOfBirth }) }] });
    assert.deepEqual(await reserve(deps(), request({ passengers: [{ fullName: 'Иван Петров', dateOfBirth: '1990-01-01' }] })),
      { ok: false, refusal: 'DATE_OF_BIRTH_NOT_COLLECTED' });
    assert.deepEqual(await reserve(deps(), dob()), { ok: false, refusal: 'DATE_OF_BIRTH_REQUIRED' });
    assert.deepEqual(await reserve(deps(), dob('1990-02-30')), { ok: false, refusal: 'DATE_OF_BIRTH_INVALID' });
    // 18 on 2026-11-11, the day after the trip starts.
    assert.deepEqual(await reserve(deps(), dob('2008-11-11')), { ok: false, refusal: 'PASSENGER_NOT_ADULT' });
    assert.ok((await reserve(deps(), dob('2008-11-10'))).ok);
  });

  test('contact is normalised; nothing personal reaches the log', async () => {
    const { log, lines } = captureLog();
    const r = await reserve(deps({ log }), request());
    assert.ok(r.ok);
    await reserve(deps({ log }), request({ contact: { fullName: 'Иван Петров', phone: '12345', email: 'ivan@example.ru' } }));
    const { rows } = await db.owner.query('SELECT full_name, phone, email FROM order_contact');
    assert.deepEqual(rows[0], { full_name: 'Иван Петров', phone: '+79039075547', email: 'ivan@example.ru' });
    const logged = lines.join('\n');
    for (const pd of ['Иван', 'Петров', '9039075547', '907-55-47', 'example.ru', '12345']) {
      assert.ok(!logged.includes(pd), `the log contains ${pd}: ${logged}`);
    }
    assert.match(logged, /booking_reserved/);
    assert.match(logged, /CONTACT_PHONE_INVALID/);
  });

  test('an unpaid order keeps its personal data less than 24 hours after it ends', async () => {
    const r = await reserve(deps(), request());
    assert.ok(r.ok);
    const expiredAt = new Date(NOW.getTime() + HOUR);
    await maintain(db.pool, () => undefined, expiredAt);
    assert.deepEqual(await maintain(db.pool, () => undefined, new Date(expiredAt.getTime() + 23 * HOUR)), { expired: 0, erased: 0 });
    assert.deepEqual(await maintain(db.pool, () => undefined, new Date(expiredAt.getTime() + 24 * HOUR)), { expired: 0, erased: 1 });
    const left = await db.owner.query('SELECT (SELECT count(*) FROM order_contact) AS c, (SELECT count(*) FROM order_passenger) AS p');
    assert.deepEqual(left.rows[0], { c: '0', p: '0' });
    const order = await db.owner.query('SELECT status, seats, amount_kopecks, pd_erased_at IS NOT NULL AS erased FROM orders');
    assert.deepEqual(order.rows[0], { status: 'EXPIRED', seats: 1, amount_kopecks: '3400000', erased: true });
  });

  test('a trip keeps it 90 days after it ends, unless held or its money is unresolved', async () => {
    const refs: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await reserve(deps(), request());
      assert.ok(r.ok);
      refs.push(r.orderRef);
    }
    await forceStatus(db.owner, refs[0]!, 'FULFILLED');
    await forceStatus(db.owner, refs[1]!, 'FULFILLED', `, legal_hold = true, legal_hold_reason = 'claim'`);
    await forceStatus(db.owner, refs[2]!, 'PAYMENT_PENDING');
    // The trip ends 2026-11-04: day 90 after it is 2027-02-02.
    assert.equal((await maintain(db.pool, () => undefined, new Date('2027-02-02T12:00:00Z'))).erased, 0);
    assert.equal((await maintain(db.pool, () => undefined, new Date('2027-02-03T12:00:00Z'))).erased, 1);
    const { rows } = await db.owner.query('SELECT order_ref FROM orders WHERE pd_erased_at IS NOT NULL');
    assert.deepEqual(rows.map((r) => r.order_ref), [refs[0]]);
  });
});
