// TOUR-76 / N2 · stable purchase identity, immutable revisions and the server-assigned
// NATIVE_NO_REFERRAL profile (migration 0017), against real PostgreSQL and the production roles.
import assert from 'node:assert/strict';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';

import pg from 'pg';

import type { Catalog } from '../src/catalog.js';
import { issueState, onReturn, pay, reconcileOrder, type CheckoutDeps } from '../src/checkout.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import { schemaHead } from '../src/migrate.js';
import { maintain, reserve, setSalesOpen, type BookingRequest, type OrderDeps } from '../src/orders.js';
import { currentPurchase, purchaseProfileOf, reserveNativePurchase } from '../src/purchases.js';
import { BookingRateLimiter } from '../src/rate-limit.js';
import { RefrefClient } from '../src/refref.js';
import { createCommerceServer } from '../src/server.js';
import { createWebHandler } from '../src/web.js';
import { FakeRefref } from './fake-refref.js';
import { fixtureCatalog, forceStatus, freshDb, seedCatalog, tourist, type TestDb, resetOrders } from './helpers.js';

const NOW = new Date('2026-10-04T06:00:00Z');
const SLUG = 'altai-2026-11-01';
const MERCHANT_ID = '3f1c2a5e-8b4d-4c7e-9a10-2b6d8e4f1a90';
const PD = ['Иван', 'Петров', 'Анна', '9039075547', 'ivan@example.ru', '654321', '654322', '1990-05-17'];

let db: TestDb;
let catalog: Catalog;
let refref: FakeRefref;
let server: Server;
let base: string;
let checkout: CheckoutDeps;

const booking = (over: Partial<BookingRequest> = {}): BookingRequest => ({
  departureSlug: SLUG,
  contact: { phone: '+7 (903) 907-55-47', email: 'Ivan@Example.ru' },
  passengers: [tourist(1), tourist(2)],
  adultsOnlyConfirmed: true,
  termsRef: catalog.terms.ref, termsHash: catalog.terms.hash,
  pdConsentConfirmed: true, pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash,
  ...over,
});
const deps = (over: Partial<OrderDeps> = {}): OrderDeps =>
  ({ pool: db.pool, catalog, log: () => undefined, allowDemo: false, now: () => NOW, ...over });

async function native(over: Partial<BookingRequest> = {}, d: Partial<OrderDeps> = {}) {
  const r = await reserveNativePurchase(deps(d), booking(over));
  assert.ok(r.ok, JSON.stringify(r));
  return r as Extract<typeof r, { ok: true }>;
}
async function legacy(over: Partial<BookingRequest> = {}) {
  const r = await reserve(deps(), booking(over));
  assert.ok(r.ok, JSON.stringify(r));
  return r;
}
const orderId = async (ref: string): Promise<string> =>
  (await db.owner.query('SELECT id FROM orders WHERE order_ref = $1', [ref])).rows[0].id;
const order = async (ref: string) => (await db.owner.query('SELECT * FROM orders WHERE order_ref = $1', [ref])).rows[0];
const count = async (sql: string, values: unknown[] = []): Promise<number> =>
  Number((await db.owner.query(`SELECT count(*) AS n FROM ${sql}`, values)).rows[0].n);

/**
 * Test-only stand-in for database time passing: move a purchase order's database-recorded closure
 * back. The stamp is immutable for every login; only this disposable database's superuser can
 * suspend triggers to do it.
 */
async function ageClosure(id: string, hours = 25): Promise<void> {
  await db.owner.query('BEGIN');
  try {
    await db.owner.query('SET LOCAL session_replication_role = replica');
    await db.owner.query('UPDATE orders SET closed_recorded_at = closed_recorded_at - make_interval(hours => $2) WHERE id = $1', [id, hours]);
    await db.owner.query('COMMIT');
  } catch (e) { await db.owner.query('ROLLBACK'); throw e; }
}

/** Run `extra` on reserve()'s own transaction right after the statement `match` selects. */
function interceptAfter(pool: pg.Pool, match: (sql: string) => boolean, extra: (client: pg.PoolClient) => Promise<unknown>,
  rewrite: (sql: string) => string = (sql) => sql): pg.Pool {
  return new Proxy(pool, { get(target, key) {
    if (key === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(c, k) {
        if (k === 'query') return async (sql: string, values?: unknown[]) => {
          const result = await c.query(rewrite(sql), values);
          if (typeof sql === 'string' && match(sql)) await extra(c);
          return result;
        };
        const value = Reflect.get(c, k); return typeof value === 'function' ? value.bind(c) : value;
      } });
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}

function http(method: string, path: string, cookie: string): Promise<{ status: number; location: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method, headers: { cookie,
      ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '9' } : {}) } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body }));
    });
    req.on('error', reject);
    if (method === 'POST') req.write('zayavka=x');
    req.end();
  });
}

before(async () => {
  db = await freshDb();
  catalog = fixtureCatalog([{ slug: SLUG, startsOn: '2026-11-01', endsOn: '2026-11-04', capacity: 4 }]);
  await seedCatalog(db, catalog);
  refref = new FakeRefref(MERCHANT_ID);
  await refref.start();
  checkout = {
    pool: db.pool, initiationPool: db.initiation, catalog, log: () => undefined, now: () => NOW,
    refref: new RefrefClient({ apiBase: refref.base, apiKey: 'rk_test', timeoutMs: 1500 }),
    merchant: { businessId: MERCHANT_ID, businessSlug: 'mikluha', checkoutOrigin: 'https://checkout.refref.example',
      origin: 'https://book.mikluha.example', siteOrigin: 'https://mikluha.example' },
  };
  server = createCommerceServer({ pool: db.pool, catalog, schemaHead: schemaHead(MIGRATIONS_DIR), sourceCommit: null,
    startedAt: new Date() }, createWebHandler(checkout, false, new BookingRateLimiter({ ipLimit: 10_000, emailLimit: 10_000 })));
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
  refref.reset();
  await resetOrders(db.owner);
  await db.owner.query('UPDATE departure SET capacity = 4 WHERE slug = $1', [SLUG]);
  await setSalesOpen(db.operator, true, 'test', 'open for the test');
});

describe('opening a native purchase', () => {
  test('the database assigns purchaseRef, NATIVE_NO_REFERRAL and MIKLUHA_NATIVE before any payment opportunity', async () => {
    const r = await native();
    assert.match(r.purchaseRef!, /^mp-[0-9a-f]{20}$/);
    assert.equal(r.revision, 1);
    const o = await order(r.orderRef);
    // No payment opportunity, no resolution, no attribution: only the accepted reservation.
    assert.equal(o.status, 'RESERVED');
    for (const c of ['state_hash', 'referral_resolution_id', 'attribution_source', 'quote_issued_at', 'snapshot', 'checkout_attempt_id', 'payment_id']) {
      assert.equal(o[c], null, c);
    }
    const p = await currentPurchase(db.pool, r.purchaseRef!);
    assert.deepEqual({ ...p, revisionHash: undefined }, {
      purchaseRef: r.purchaseRef, lifecycleProfile: 'NATIVE_NO_REFERRAL', paymentOwner: 'MIKLUHA_NATIVE', revision: 1,
      basis: 'INITIAL', revisionHash: undefined, documentOrderRef: r.orderRef, documentOrderStatus: 'RESERVED',
      departureSlug: SLUG, seats: 2, totalKopecks: r.amountKopecks, acceptedAt: NOW, effectiveAt: NOW });
    assert.deepEqual(await purchaseProfileOf(db.pool, r.orderRef), { provenance: 'PURCHASE', purchaseRef: r.purchaseRef,
      revision: 1, lifecycleProfile: 'NATIVE_NO_REFERRAL', paymentOwner: 'MIKLUHA_NATIVE' });
    assert.deepEqual((await db.owner.query("SELECT event, detail FROM order_event WHERE order_id = $1 ORDER BY id", [o.id])).rows,
      [{ event: 'RESERVED', detail: 'seats:2' }, { event: 'PURCHASE_REVISION', detail: 'revision:1' }]);
  });

  test('revision 1 is the order\'s accepted terms, chained and hashed independently of the session time zone', async () => {
    const r = await native();
    const o = await order(r.orderRef);
    const rev = (await db.owner.query('SELECT * FROM purchase_revision')).rows[0];
    assert.deepEqual([rev.document_order_id, rev.departure_id, rev.departure_version, rev.seats, rev.unit_price_kopecks,
      rev.total_kopecks, rev.contract_snapshot_sha256, rev.legal_release_ref, rev.legal_release_hash, rev.pd_consent_ref,
      rev.pd_consent_hash, rev.accepted_at.getTime(), rev.effective_at.getTime(), rev.predecessor_hash],
    [o.id, o.departure_id, o.accepted_departure_version, o.seats, o.unit_price_kopecks, o.amount_kopecks,
      o.contract_snapshot_sha256, o.legal_release_ref, o.legal_release_hash, o.pd_consent_ref, o.pd_consent_hash,
      o.pd_consent_accepted_at.getTime(), o.pd_consent_accepted_at.getTime(), null]);
    const recompute = `SELECT fn_purchase_revision_hash(p.purchase_ref, r) AS h, r.revision_hash FROM purchase_revision r JOIN purchase p ON p.id = r.purchase_id`;
    for (const zone of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
      await db.owner.query(`SET TIME ZONE '${zone}'`);
      const { h, revision_hash } = (await db.owner.query(recompute)).rows[0];
      assert.equal(h, revision_hash, zone);
    }
    await db.owner.query('RESET TIME ZONE');
  });

  test('participants are links to the tourist rows, without personal data, and survive erasure', async () => {
    const r = await native();
    const o = await order(r.orderRef);
    const links = (await db.owner.query('SELECT position, participant_ref, source_order_id, source_position FROM purchase_revision_participant ORDER BY position')).rows;
    assert.deepEqual(links.map(l => [l.position, l.source_order_id, l.source_position]), [[1, o.id, 1], [2, o.id, 2]]);
    assert.notEqual(links[0].participant_ref, links[1].participant_ref);
    const refs = (await db.owner.query('SELECT participant_refs FROM purchase_revision')).rows[0].participant_refs;
    assert.deepEqual(refs, links.map(l => l.participant_ref));
    const stored = JSON.stringify((await db.owner.query(`SELECT (SELECT json_agg(p) FROM purchase p) AS a,
      (SELECT json_agg(r) FROM purchase_revision r) AS b, (SELECT json_agg(x) FROM purchase_revision_participant x) AS c,
      (SELECT json_agg(v) FROM purchase_current v) AS d`)).rows[0]);
    for (const s of PD) assert.ok(!stored.includes(s), `purchase data must not contain ${s}`);
    // Retention erases the tourists; the purchase history and its links stay.
    await maintain(db.pool, () => undefined, new Date(NOW.getTime() + 31 * 60_000));
    await ageClosure(o.id);
    await maintain(db.pool, () => undefined, new Date(NOW.getTime() + 26 * 3_600_000));
    assert.equal((await order(r.orderRef)).status, 'EXPIRED');
    assert.equal(await count('order_passenger WHERE order_id = $1', [o.id]), 0);
    assert.equal(await count('purchase_revision_participant'), 2);
    assert.equal((await currentPurchase(db.pool, r.purchaseRef!))!.documentOrderStatus, 'EXPIRED');
  });

  test('no request field, promo or query value selects the profile, the owner or the price', async () => {
    const extras = { lifecycleProfile: 'REFERRAL_V10', paymentOwner: 'REFREF_RC', promoCode: 'PARTNER10', ref: 'partner-7',
      attributionSource: 'LINK', bound: true, utm_source: 'partner' } as unknown as Partial<BookingRequest>;
    const plain = await native();
    const decorated = await native(extras);
    assert.equal(decorated.amountKopecks, plain.amountKopecks);
    for (const r of [plain, decorated]) {
      const p = await currentPurchase(db.pool, r.purchaseRef!);
      assert.equal(p!.lifecycleProfile, 'NATIVE_NO_REFERRAL');
      assert.equal(p!.paymentOwner, 'MIKLUHA_NATIVE');
      assert.equal((await order(r.orderRef)).attribution_source, null);
    }
    // The same extras on the legacy path do not create a purchase either.
    await db.owner.query('UPDATE departure SET capacity = 6 WHERE slug = $1', [SLUG]);
    const old = await legacy(extras);
    assert.deepEqual(await purchaseProfileOf(db.pool, old.orderRef), { provenance: 'UNRESOLVED' });
  });
});

describe('orders outside a purchase', () => {
  test('keep UNRESOLVED provenance through maintenance and later states, never NATIVE_NO_REFERRAL', async () => {
    const a = await legacy({ passengers: [tourist(1)] });
    const b = await legacy({ passengers: [tourist(3)] });
    await forceStatus(db.owner, b.orderRef, 'FULFILLED');
    await maintain(db.pool, () => undefined, new Date(NOW.getTime() + 26 * 3_600_000));
    for (const ref of [a.orderRef, b.orderRef]) {
      assert.deepEqual(await purchaseProfileOf(db.pool, ref), { provenance: 'UNRESOLVED' });
      const row = (await db.pool.query('SELECT purchase_ref, lifecycle_profile, payment_owner FROM order_purchase_profile WHERE order_ref = $1', [ref])).rows[0];
      assert.deepEqual(row, { purchase_ref: null, lifecycle_profile: null, payment_owner: null });
    }
    assert.equal(await count('purchase'), 0);
    assert.equal(await purchaseProfileOf(db.pool, 'mk-000000000000'), null);
  });

  test('an existing order cannot be adopted into a purchase: not by the service, a worker retry or the owner', async () => {
    const old = await legacy();
    const id = await orderId(old.orderRef);
    await assert.rejects(db.pool.query('SELECT * FROM fn_open_native_purchase($1)', [id]), /PURCHASE_ORDER_NOT_NEW/);
    await assert.rejects(db.owner.query('SELECT * FROM fn_open_native_purchase($1)', [id]), /PURCHASE_ORDER_NOT_NEW/);
    await assert.rejects(db.owner.query(`INSERT INTO purchase (purchase_ref, lifecycle_profile, payment_owner, origin_order_id)
      VALUES ('mp-00000000000000000000', 'NATIVE_NO_REFERRAL', 'MIKLUHA_NATIVE', $1)`, [id]), /PURCHASE_ORDER_NOT_NEW/);
    // Touching the old order in the same transaction does not make it look new: its RESERVED event is older.
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('UPDATE orders SET reserved_until = reserved_until WHERE id = $1', [id]);
      await c.query("INSERT INTO order_event (order_id, event) VALUES ($1, 'RESERVED')", [id]);
      await assert.rejects(c.query('SELECT * FROM fn_open_native_purchase($1)', [id]), /PURCHASE_ORDER_NOT_NEW/);
    } finally { await c.query('ROLLBACK'); c.release(); }
    // A purchase document order cannot be opened twice.
    const r = await native({ passengers: [tourist(3)] });
    await assert.rejects(db.owner.query('SELECT * FROM fn_open_native_purchase($1)', [await orderId(r.orderRef)]), /PURCHASE_ORDER_NOT_NEW/);
    assert.equal(await count('purchase'), 1);
    assert.deepEqual(await purchaseProfileOf(db.pool, old.orderRef), { provenance: 'UNRESOLVED' });
  });

  test('an order that was handed off or attributed before opening is refused, and nothing is reserved', async () => {
    for (const set of ["state_hash = repeat('a', 64)", "attribution_source = 'LINK'"]) {
      const pool = interceptAfter(db.pool, (sql) => sql.includes("'RESERVED'") && sql.includes('INSERT INTO order_event'),
        (c) => c.query(`UPDATE orders SET ${set} WHERE id = (SELECT order_id FROM order_event ORDER BY id DESC LIMIT 1)`));
      await assert.rejects(reserveNativePurchase(deps({ pool }), booking()), /PURCHASE_ORDER_NOT_PRISTINE/);
      assert.equal(await count('orders'), 0);
      assert.equal(await count('purchase'), 0);
    }
  });

  test('malformed or NULL entry-point input is refused', async () => {
    await assert.rejects(db.pool.query('SELECT * FROM fn_open_native_purchase(NULL)'), /PURCHASE_ORDER_UNKNOWN/);
    await assert.rejects(db.pool.query('SELECT * FROM fn_open_native_purchase(gen_random_uuid())'), /PURCHASE_ORDER_UNKNOWN/);
    await assert.rejects(db.pool.query("SELECT * FROM fn_open_native_purchase('not-a-uuid')"), /invalid input syntax for type uuid/);
    await assert.rejects(db.pool.query("SELECT * FROM fn_open_native_purchase(1)"), /does not exist/);
    const r = await native();
    const p = (await db.owner.query('SELECT id FROM purchase')).rows[0].id;
    const document = (await db.owner.query('SELECT document_order_id FROM purchase_revision')).rows[0].document_order_id;
    // Direct owner inserts copying revision 1: wrong sequence, a NULL or old document order and
    // participant links that do not match the revision all fail.
    const copy = (over: Record<string, string>) => {
      const cols = ['purchase_id', 'revision', 'basis', 'document_order_id', 'departure_id', 'departure_version', 'seats',
        'unit_price_kopecks', 'total_kopecks', 'participant_refs', 'contract_snapshot_sha256', 'legal_release_ref',
        'legal_release_hash', 'pd_consent_ref', 'pd_consent_hash', 'accepted_at', 'effective_at', 'recorded_at', 'revision_hash'];
      return `INSERT INTO purchase_revision (${cols.join(', ')}) SELECT ${cols.map(c => over[c] ?? c).join(', ')} FROM purchase_revision WHERE revision = 1`;
    };
    for (const [sql, values, error] of [
      [copy({ revision: '3', basis: "'QUOTE_REPLACEMENT'" }), [], /PURCHASE_REVISION_SEQUENCE/],
      [copy({ revision: '2', basis: "'QUOTE_REPLACEMENT'", document_order_id: 'NULL' }), [], /PURCHASE_ORDER_UNKNOWN/],
      [copy({ revision: '2', basis: "'QUOTE_REPLACEMENT'" }), [], /PURCHASE_ORDER_NOT_NEW/],
      [copy({ revision: 'NULL' }), [], /PURCHASE_REVISION_SEQUENCE/],
      ['INSERT INTO purchase_revision_participant VALUES ($1, 1, 3, gen_random_uuid(), $2, 3)', [p, document], /PURCHASE_PARTICIPANT_MISMATCH/],
      ['INSERT INTO purchase_revision_participant VALUES ($1, 1, NULL, NULL, NULL, NULL)', [p], /PURCHASE_PARTICIPANT_MISMATCH|null value/],
    ] as const) await assert.rejects(db.owner.query(sql, [...values]), error, sql);
    assert.equal(await count('purchase_revision'), 1);
    assert.equal((await currentPurchase(db.pool, r.purchaseRef!))!.revision, 1);
  });
});

describe('profile, identity and history are immutable', () => {
  test('the service cannot write purchase tables directly; Admin and operators cannot read them', async () => {
    await native();
    for (const sql of [
      "INSERT INTO purchase (purchase_ref, lifecycle_profile, payment_owner, origin_order_id) VALUES ('mp-00000000000000000000', 'NATIVE_NO_REFERRAL', 'MIKLUHA_NATIVE', gen_random_uuid())",
      "UPDATE purchase SET lifecycle_profile = 'NATIVE_NO_REFERRAL'", 'DELETE FROM purchase', 'TRUNCATE purchase CASCADE',
      'UPDATE purchase_revision SET seats = seats', 'DELETE FROM purchase_revision', 'UPDATE purchase_revision_participant SET position = position',
      'DELETE FROM purchase_revision_participant',
    ]) await assert.rejects(db.pool.query(sql), /permission denied/, sql);
    for (const pool of [db.admin, db.operator, db.publisher, db.adminOperator]) {
      for (const t of ['purchase', 'purchase_revision', 'purchase_revision_participant', 'purchase_current', 'order_purchase_profile']) {
        await assert.rejects(pool.query(`SELECT * FROM ${t}`), /permission denied/, t);
      }
      await assert.rejects(pool.query('SELECT * FROM fn_open_native_purchase(gen_random_uuid())'), /permission denied/);
      await assert.rejects(pool.query("SELECT fn_departure_taken_seats('x', now())"), /permission denied/);
    }
  });

  test('profile reassignment, identity changes and history rewrites are refused for the owner too', async () => {
    const r = await native();
    for (const [sql, error] of [
      ["UPDATE purchase SET lifecycle_profile = 'REFERRAL_V10'", /PURCHASE_PROFILE_IMMUTABLE/],
      ["UPDATE purchase SET payment_owner = 'REFREF_RC'", /PURCHASE_PROFILE_IMMUTABLE/],
      ["UPDATE purchase SET purchase_ref = 'mp-ffffffffffffffffffff'", /PURCHASE_IDENTITY_IMMUTABLE/],
      ['UPDATE purchase SET origin_order_id = gen_random_uuid()', /PURCHASE_IDENTITY_IMMUTABLE/],
      ['UPDATE purchase SET created_at = created_at - interval \'1 day\'', /PURCHASE_IDENTITY_IMMUTABLE/],
      ['UPDATE purchase SET current_revision = 2', /PURCHASE_REVISION_SEQUENCE/],
      ['DELETE FROM purchase', /PURCHASE_HISTORY_IMMUTABLE/],
      ["UPDATE purchase_revision SET revision_hash = 'sha256:' || repeat('0', 64)", /PURCHASE_HISTORY_IMMUTABLE/],
      ['UPDATE purchase_revision SET total_kopecks = total_kopecks - 1, unit_price_kopecks = unit_price_kopecks', /PURCHASE_HISTORY_IMMUTABLE/],
      ['DELETE FROM purchase_revision', /PURCHASE_HISTORY_IMMUTABLE/],
      ['UPDATE purchase_revision_participant SET participant_ref = gen_random_uuid()', /PURCHASE_HISTORY_IMMUTABLE/],
      ['DELETE FROM purchase_revision_participant', /PURCHASE_HISTORY_IMMUTABLE/],
    ] as const) await assert.rejects(db.owner.query(sql), error, sql);
    const p = await currentPurchase(db.pool, r.purchaseRef!);
    assert.equal(p!.lifecycleProfile, 'NATIVE_NO_REFERRAL');
    assert.equal(p!.paymentOwner, 'MIKLUHA_NATIVE');
  });
});

describe('no retroactive attribution or Refref payment for a purchase', () => {
  const referral: readonly string[] = [
    "attribution_source = 'LINK'",
    'terms_version_id = gen_random_uuid()',
    "referral_resolution_id = gen_random_uuid(), resolution_expires_at = now() + interval '1 hour', discount_kopecks = 0, payable_kopecks = amount_kopecks",
    'resolution_operation_id = gen_random_uuid(), resolution_started_at = now()',
  ];
  const payment: readonly string[] = [
    "status = 'PAYMENT_PENDING', snapshot = '{}', snapshot_hash = 'refref-jcs-1:' || repeat('0', 64), payment_pending_since = now()",
    'checkout_attempt_id = gen_random_uuid()',
    "attempt_creation_state = 'STARTED'",
    "last_session = 'PAYMENT_READY'",
  ];

  test('the database refuses attribution, BOUND-like resolution and Refref checkout columns in every state', async () => {
    const r = await native();
    const id = await orderId(r.orderRef);
    const attempts = async () => {
      for (const pool of [db.pool, db.owner]) {
        for (const set of referral) await assert.rejects(pool.query(`UPDATE orders SET ${set} WHERE id = $1`, [id]), /NATIVE_PURCHASE_NO_REFERRAL/, set);
        for (const set of payment) await assert.rejects(pool.query(`UPDATE orders SET ${set} WHERE id = $1`, [id]), /NATIVE_PURCHASE_PAYMENT_OWNER/, set);
      }
    };
    await attempts();
    // Browser ownership is not attribution: it stays available to the native flow.
    assert.ok(await issueState(db.pool, r.orderRef));
    await attempts();
    // After the hold lapses the guard is unchanged, so a later worker or migration cannot bind it.
    await maintain(db.pool, () => undefined, new Date(NOW.getTime() + 31 * 60_000));
    assert.equal((await order(r.orderRef)).status, 'EXPIRED');
    await attempts();
    const o = await order(r.orderRef);
    for (const c of ['referral_resolution_id', 'attribution_source', 'terms_version_id', 'snapshot', 'checkout_attempt_id']) assert.equal(o[c], null, c);
    // Legacy orders are not affected by the guard.
    const old = await legacy({ passengers: [tourist(3)] });
    await db.pool.query("UPDATE orders SET attribution_source = 'LINK' WHERE order_ref = $1", [old.orderRef]);
  });

  test('the checkout never calls Refref for a purchase: resolution, payment and read-back refuse first', async () => {
    const r = await native();
    const state = (await issueState(db.pool, r.orderRef))!;
    assert.deepEqual(await onReturn(checkout, { rt: 'rt_partner', state, cookieState: () => state }),
      { kind: 'REFUSED', code: 'NATIVE_PURCHASE_NO_REFERRAL', orderRef: r.orderRef });
    assert.deepEqual(await pay(checkout, r.orderRef, 'sha256:any'), { kind: 'STATUS', code: 'NATIVE_PAYMENT_NOT_AVAILABLE' });
    await reconcileOrder(checkout, r.orderRef);
    const cookie = `__Host-mk_${r.orderRef}=${state}`;
    const back = await http('GET', `/return?rt=rt_partner&state=${encodeURIComponent(state)}`, cookie);
    assert.equal(back.status, 409);
    assert.match(back.body, /промокоды и реферальные ссылки не применяются/);
    const paid = await http('POST', `/orders/${r.orderRef}/pay`, cookie);
    assert.equal(paid.location, `/orders/${r.orderRef}?notice=NATIVE_PAYMENT_NOT_AVAILABLE`);
    assert.deepEqual(refref.requests, []);
    const o = await order(r.orderRef);
    assert.equal(o.status, 'RESERVED');
    assert.equal(o.resolution_operation_id, null);
    assert.equal(o.attribution_source, null);
  });
});

describe('continuation and capacity', () => {
  test('a replacement continues the same purchase with a chained revision and moves the seats once', async () => {
    const first = await native();
    const second = await native({ replacementOrderRef: first.orderRef, passengers: [tourist(3), tourist(4)] });
    assert.equal(second.purchaseRef, first.purchaseRef);
    assert.equal(second.revision, 2);
    const revs = (await db.owner.query('SELECT revision, basis, revision_hash, predecessor_hash, document_order_id FROM purchase_revision ORDER BY revision')).rows;
    assert.deepEqual(revs.map(r => [r.revision, r.basis]), [[1, 'INITIAL'], [2, 'QUOTE_REPLACEMENT']]);
    assert.equal(revs[1].predecessor_hash, revs[0].revision_hash);
    assert.notEqual(revs[1].revision_hash, revs[0].revision_hash);
    assert.equal(revs[1].document_order_id, await orderId(second.orderRef));
    assert.equal((await order(first.orderRef)).status, 'CANCELLED');
    const p = await currentPurchase(db.pool, first.purchaseRef!);
    assert.equal(p!.revision, 2);
    assert.equal(p!.documentOrderRef, second.orderRef);
    assert.deepEqual(await purchaseProfileOf(db.pool, first.orderRef), { provenance: 'PURCHASE', purchaseRef: first.purchaseRef,
      revision: 1, lifecycleProfile: 'NATIVE_NO_REFERRAL', paymentOwner: 'MIKLUHA_NATIVE' });
    assert.equal(Number((await db.pool.query('SELECT fn_departure_taken_seats($1, $2) AS n', [SLUG, NOW])).rows[0].n), 2);
    // Only the current document order continues the purchase.
    const stale = await reserveNativePurchase(deps(), booking({ replacementOrderRef: first.orderRef }));
    assert.deepEqual(stale, { ok: false, refusal: 'REPLACEMENT_NOT_AVAILABLE' });
  });

  test('a replacement never crosses profiles, and the database backs that up', async () => {
    const purchase = await native({ passengers: [tourist(1)] });
    const old = await legacy({ passengers: [tourist(2)] });
    assert.deepEqual(await reserve(deps(), booking({ replacementOrderRef: purchase.orderRef, passengers: [tourist(3)] })),
      { ok: false, refusal: 'REPLACEMENT_NOT_AVAILABLE' });
    assert.deepEqual(await reserveNativePurchase(deps(), booking({ replacementOrderRef: old.orderRef, passengers: [tourist(3)] })),
      { ok: false, refusal: 'REPLACEMENT_NOT_AVAILABLE' });
    // A legacy replacement that skipped the check fails at commit: the purchase cannot be left.
    const pool = interceptAfter(db.pool, () => false, async () => undefined,
      (sql) => sql.replace('AND NOT EXISTS (SELECT 1 FROM purchase_revision', 'AND EXISTS (SELECT 1 FROM purchase_revision'));
    await assert.rejects(reserve(deps({ pool }), booking({ replacementOrderRef: purchase.orderRef, passengers: [tourist(3)] })),
      /NATIVE_PURCHASE_CONTINUATION_REQUIRED/);
    assert.equal((await order(purchase.orderRef)).status, 'RESERVED');
    assert.equal((await order(old.orderRef)).status, 'RESERVED');
    assert.deepEqual(await purchaseProfileOf(db.pool, old.orderRef), { provenance: 'UNRESOLVED' });
    assert.equal(await count('purchase_revision'), 1);
  });

  test('purchase seats and legacy seats share one capacity count', async () => {
    await native({ passengers: [tourist(1), tourist(2), tourist(3)] });
    assert.equal(Number((await db.pool.query('SELECT fn_departure_taken_seats($1, $2) AS n', [SLUG, NOW])).rows[0].n), 3);
    assert.deepEqual(await reserve(deps(), booking()), { ok: false, refusal: 'NOT_ENOUGH_SEATS' });
    assert.deepEqual(await reserveNativePurchase(deps(), booking()), { ok: false, refusal: 'NOT_ENOUGH_SEATS' });
    await legacy({ passengers: [tourist(4)] });
    // A lapsed unpaid hold no longer counts, for either kind.
    assert.equal(Number((await db.pool.query('SELECT fn_departure_taken_seats($1, $2) AS n', [SLUG, new Date(NOW.getTime() + 31 * 60_000)])).rows[0].n), 0);
  });
});

describe('concurrency', () => {
  test('concurrent purchases for the last seats never oversell', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      reserveNativePurchase(deps(), booking({ passengers: [tourist(i + 1)] }))));
    assert.equal(results.filter(r => r.ok).length, 4);
    assert.deepEqual(results.filter(r => !r.ok), [{ ok: false, refusal: 'NOT_ENOUGH_SEATS' }, { ok: false, refusal: 'NOT_ENOUGH_SEATS' }]);
    assert.equal(await count('purchase'), 4);
    assert.equal(new Set(results.flatMap(r => r.ok ? [r.purchaseRef] : [])).size, 4);
  });

  test('concurrent replacements of one purchase order append exactly one revision', async () => {
    const first = await native();
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      reserveNativePurchase(deps(), booking({ replacementOrderRef: first.orderRef }))));
    const ok = results.filter(r => r.ok);
    assert.equal(ok.length, 1);
    assert.ok(results.filter(r => !r.ok).every(r => !r.ok && r.refusal === 'REPLACEMENT_NOT_AVAILABLE'));
    assert.equal(await count('purchase'), 1);
    assert.equal(await count('purchase_revision'), 2);
    assert.equal((await currentPurchase(db.pool, first.purchaseRef!))!.revision, 2);
  });
});

describe('integrity backstops (PR #51 review)', () => {
  let ownerPool: pg.Pool;
  before(async () => {
    ownerPool = new pg.Pool({ connectionString: db.url.toString(), max: 2 });
    // Test-only owner function: what a careless migration or maintenance script might write directly.
    await db.owner.query(`CREATE FUNCTION test_partial_purchase(p_order uuid, p_mode text) RETURNS TABLE (purchase_ref text, revision int)
      SET search_path = pg_catalog, public AS $fn$
      #variable_conflict use_column
      DECLARE o orders%ROWTYPE; p purchase%ROWTYPE; v_rev int; v_refs uuid[];
      BEGIN
        SELECT * INTO o FROM orders WHERE id = p_order;
        IF p_mode = 'NO_REVISION' THEN
          INSERT INTO purchase (purchase_ref, lifecycle_profile, payment_owner, origin_order_id)
            VALUES ('mp-' || left(md5(gen_random_uuid()::text), 20), 'NATIVE_NO_REFERRAL', 'MIKLUHA_NATIVE', o.id) RETURNING * INTO p;
          RETURN QUERY SELECT p.purchase_ref, 1;
          RETURN;
        END IF;
        SELECT pu.* INTO p FROM purchase pu JOIN purchase_revision r ON r.purchase_id = pu.id WHERE r.document_order_id = o.replaces_order_id;
        v_rev := p.current_revision + 1;
        SELECT array_agg(gen_random_uuid()) INTO v_refs FROM generate_series(1, o.seats);
        IF p_mode = 'FOREIGN_REF' THEN
          v_refs[1] := (SELECT x.participant_ref FROM purchase_revision_participant x WHERE x.purchase_id <> p.id LIMIT 1);
        ELSIF p_mode = 'WRONG_CARRY' THEN
          v_refs[1] := (SELECT x.participant_ref FROM purchase_revision_participant x WHERE x.purchase_id = p.id AND x.revision = v_rev - 1 AND x.position = 1);
        END IF;
        INSERT INTO purchase_revision (purchase_id, revision, basis, document_order_id, departure_id, departure_version, seats,
            unit_price_kopecks, total_kopecks, participant_refs, contract_snapshot_sha256, legal_release_ref, legal_release_hash,
            pd_consent_ref, pd_consent_hash, accepted_at, effective_at, recorded_at, revision_hash)
          VALUES (p.id, v_rev, 'QUOTE_REPLACEMENT', o.id, o.departure_id, o.accepted_departure_version, o.seats, o.unit_price_kopecks,
            o.amount_kopecks, v_refs, o.contract_snapshot_sha256, o.legal_release_ref, o.legal_release_hash, o.pd_consent_ref,
            o.pd_consent_hash, o.pd_consent_accepted_at, o.pd_consent_accepted_at, now(), 'sha256:' || repeat('0', 64));
        INSERT INTO purchase_revision_participant (purchase_id, revision, position, participant_ref, source_order_id, source_position)
          SELECT p.id, v_rev, i, v_refs[i], o.id, i FROM generate_series(1, o.seats) i;
        IF p_mode <> 'NO_ADVANCE' THEN UPDATE purchase SET current_revision = v_rev WHERE id = p.id; END IF;
        RETURN QUERY SELECT p.purchase_ref, v_rev;
      END $fn$ LANGUAGE plpgsql`);
  });
  after(async () => { await ownerPool.end(); });

  /** reserveNativePurchase as the owner, with the opening call replaced by test_partial_purchase(mode). */
  const partial = (mode: string, over: Partial<BookingRequest> = {}) => {
    const pool = interceptAfter(ownerPool, () => false, async () => undefined,
      (sql) => sql.replace('fn_open_native_purchase($1)', `test_partial_purchase($1, '${mode}')`));
    return reserveNativePurchase(deps({ pool }), booking(over));
  };
  const taken = async () => Number((await db.pool.query('SELECT fn_departure_taken_seats($1, $2) AS n', [SLUG, NOW])).rows[0].n);

  test('document order terms cannot drift from the revision, so capacity cannot oversell', async () => {
    const r = await native({ passengers: [tourist(1), tourist(2), tourist(3)] });
    const id = await orderId(r.orderRef);
    for (const pool of [db.pool, db.owner]) {
      for (const set of ['seats = 1, amount_kopecks = unit_price_kopecks', "legal_release_hash = 'sha256:' || repeat('1', 64)",
        "pd_consent_ref = 'other'", "order_ref = 'mk-zzzzzzzzzzzz'", 'created_at = created_at - interval \'1 day\'']) {
        await assert.rejects(pool.query(`UPDATE orders SET ${set} WHERE id = $1`, [id]), /NATIVE_PURCHASE_TERMS_IMMUTABLE/, set);
      }
      await assert.rejects(pool.query(`INSERT INTO order_passenger (order_id, position, full_name, date_of_birth, citizenship,
        document_type, document_series, document_number) VALUES ($1, 4, 'Пётр Иванов', '1990-01-01', 'RU', 'RU_PASSPORT', '1111', '222222')`, [id]),
      /NATIVE_PURCHASE_TERMS_IMMUTABLE/);
    }
    assert.equal(await taken(), 3);
    assert.deepEqual(await reserveNativePurchase(deps(), booking({ passengers: [tourist(4), tourist(1), tourist(2)] })),
      { ok: false, refusal: 'NOT_ENOUGH_SEATS' });
    assert.equal((await order(r.orderRef)).seats, 3);
  });

  test('the accepted offer and consent bytes are frozen, not only their digests', async () => {
    const r = await native();
    const id = await orderId(r.orderRef);
    const before = await order(r.orderRef);
    for (const pool of [db.pool, db.owner]) {
      for (const set of ["legal_release_content = 'Другая оферта'", "pd_consent_content = 'Другое согласие'", 'legal_release_content = NULL']) {
        await assert.rejects(pool.query(`UPDATE orders SET ${set} WHERE id = $1`, [id]), /NATIVE_PURCHASE_TERMS_IMMUTABLE/, set);
      }
    }
    const after = await order(r.orderRef);
    assert.equal(after.legal_release_content, before.legal_release_content);
    assert.equal(after.pd_consent_content, before.pd_consent_content);
  });

  test('tourists of a revision cannot be edited, moved or erased early; qualified retention still erases them', async () => {
    const r = await native();
    const id = await orderId(r.orderRef);
    const old = await legacy({ passengers: [tourist(3)] });
    const oldId = await orderId(old.orderRef);
    // Editing a document would let a later revision carry a participant_ref to another person.
    for (const [sql, values] of [
      ["UPDATE order_passenger SET document_number = '999999' WHERE order_id = $1 AND position = 1", [id]],
      ['UPDATE order_passenger SET position = 3 WHERE order_id = $1 AND position = 2', [id]],
      ['UPDATE order_passenger SET order_id = $2 WHERE order_id = $1 AND position = 1', [id, oldId]],
      ['UPDATE order_passenger SET order_id = $2, position = 3 WHERE order_id = $1', [oldId, id]],
    ] as const) await assert.rejects(db.owner.query(sql, [...values]), /NATIVE_PURCHASE_TERMS_IMMUTABLE/, sql);
    // Early deletion, without the retention marker, under a legal hold or within 24 hours, is refused.
    await assert.rejects(db.pool.query('DELETE FROM order_passenger WHERE order_id = $1', [id]), /NATIVE_PURCHASE_PD_RETENTION_ONLY/);
    await assert.rejects(db.owner.query('TRUNCATE order_passenger'), /NATIVE_PURCHASE_PD_RETENTION_ONLY/);
    // A backdated first closure does not open retention: the database stamps when it recorded it.
    await db.pool.query(`UPDATE orders SET status = 'CANCELLED', closed_at = clock_timestamp() - interval '2 days',
      closed_recorded_at = clock_timestamp() - interval '2 days', pd_erased_at = clock_timestamp() WHERE id = $1`, [id]);
    const closed = (await db.owner.query('SELECT closed_recorded_at > clock_timestamp() - interval \'1 minute\' AS fresh FROM orders WHERE id = $1', [id])).rows[0];
    assert.equal(closed.fresh, true);
    await assert.rejects(db.pool.query('DELETE FROM order_passenger WHERE order_id = $1', [id]), /NATIVE_PURCHASE_PD_RETENTION_ONLY/);
    for (const set of ["closed_at = closed_at - interval '2 days'", "pd_erased_at = pd_erased_at - interval '2 days'", 'pd_erased_at = NULL',
      "closed_recorded_at = closed_recorded_at - interval '2 days'", 'closed_recorded_at = NULL']) {
      await assert.rejects(db.owner.query(`UPDATE orders SET ${set} WHERE id = $1`, [id]), /NATIVE_PURCHASE_TERMS_IMMUTABLE/, set);
    }
    assert.equal(await count('order_passenger WHERE order_id = $1', [id]), 2);
    // Legacy tourist rows keep their previous rules.
    await db.pool.query('DELETE FROM order_passenger WHERE order_id = $1', [oldId]);
    // maintain() erases a lapsed purchase order's tourists once the period has passed, unless held.
    const held = await native({ passengers: [tourist(4)] });
    const heldId = await orderId(held.orderRef);
    await db.owner.query("UPDATE orders SET legal_hold = true, legal_hold_reason = 'claim' WHERE id = $1", [heldId]);
    const lapsed = await native({ passengers: [tourist(1)] });
    const lapsedId = await orderId(lapsed.orderRef);
    await maintain(db.pool, () => undefined, new Date(NOW.getTime() + 31 * 60_000));
    // The service clock alone cannot erase it: maintain() skips it until the database period passes,
    // and the rest of the batch still runs.
    const early = await maintain(db.pool, () => undefined, new Date(NOW.getTime() + 26 * 3_600_000));
    assert.equal(early.erased, 1, 'only the lapsed legacy order of this test');
    assert.notEqual((await order(old.orderRef)).pd_erased_at, null);
    assert.equal(await count('order_passenger WHERE order_id = $1', [lapsedId]), 1);
    await ageClosure(lapsedId);
    await ageClosure(heldId);
    await maintain(db.pool, () => undefined, new Date(NOW.getTime() + 26 * 3_600_000));
    assert.equal(await count('order_passenger WHERE order_id = $1', [lapsedId]), 0);
    assert.equal(await count('order_passenger WHERE order_id = $1', [heldId]), 1);
    await db.owner.query('UPDATE orders SET pd_erased_at = clock_timestamp() WHERE id = $1', [heldId]);
    await assert.rejects(db.pool.query('DELETE FROM order_passenger WHERE order_id = $1', [heldId]), /NATIVE_PURCHASE_PD_RETENTION_ONLY/);
    assert.equal(await count('purchase_revision_participant'), 4);
  });

  test('TRUNCATE cannot erase purchase history or lift the Refref guard', async () => {
    const r = await native();
    for (const sql of ['TRUNCATE purchase_revision_participant, purchase_revision, purchase', 'TRUNCATE purchase CASCADE',
      'TRUNCATE purchase_revision CASCADE', 'TRUNCATE purchase_revision_participant', 'TRUNCATE orders CASCADE']) {
      // TRUNCATE orders CASCADE reaches the tourist guard or the purchase guard first; both refuse.
      await assert.rejects(db.owner.query(sql), /PURCHASE_HISTORY_IMMUTABLE|NATIVE_PURCHASE_PD_RETENTION_ONLY/, sql);
    }
    assert.equal((await purchaseProfileOf(db.pool, r.orderRef))!.provenance, 'PURCHASE');
    await assert.rejects(db.pool.query("UPDATE orders SET attribution_source = 'LINK' WHERE order_ref = $1", [r.orderRef]), /NATIVE_PURCHASE_NO_REFERRAL/);
  });

  test('no-op updates of an old order and its event do not make it look new', async () => {
    const old = await legacy();
    const id = await orderId(old.orderRef);
    await db.owner.query('BEGIN');
    try {
      await db.owner.query('UPDATE orders SET status = status WHERE id = $1', [id]);
      await db.owner.query('UPDATE order_event SET event = event WHERE order_id = $1', [id]);
      await assert.rejects(db.owner.query('SELECT * FROM fn_open_native_purchase($1)', [id]), /PURCHASE_ORDER_NOT_NEW/);
    } finally { await db.owner.query('ROLLBACK'); }
    for (const set of ['created_xact_id = pg_current_xact_id()', 'created_xact_at = transaction_timestamp()', 'created_xact_id = NULL']) {
      await assert.rejects(db.owner.query(`UPDATE orders SET ${set} WHERE id = $1`, [id]), /ORDER_CREATION_PROVENANCE_IMMUTABLE/, set);
    }
    // The database stamps provenance itself; an INSERT cannot supply it.
    const stamped = (await db.owner.query('SELECT created_xact_id IS NOT NULL AND created_xact_at IS NOT NULL AS ok FROM orders WHERE id = $1', [id])).rows[0];
    assert.equal(stamped.ok, true);
    assert.equal(await count('purchase'), 0);
    assert.deepEqual(await purchaseProfileOf(db.pool, old.orderRef), { provenance: 'UNRESOLVED' });
  });

  test('a purchase is whole at commit: revision 1 exists and the last revision is current', async () => {
    await assert.rejects(partial('NO_REVISION'), /PURCHASE_INCOMPLETE/);
    assert.equal(await count('orders'), 0);
    assert.equal(await count('purchase'), 0);
    const first = await native();
    await assert.rejects(partial('NO_ADVANCE', { replacementOrderRef: first.orderRef }), /PURCHASE_INCOMPLETE/);
    assert.equal(await count('purchase_revision'), 1);
    assert.equal((await order(first.orderRef)).status, 'RESERVED');
    assert.equal((await currentPurchase(db.pool, first.purchaseRef!))!.revision, 1);
  });

  test('a participant keeps its ref by identity document, not position, across a chain of revisions', async () => {
    const refsOf = async (revision: number) =>
      (await db.owner.query('SELECT participant_refs FROM purchase_revision WHERE revision = $1', [revision])).rows[0].participant_refs as string[];
    const first = await native({ passengers: [tourist(1), tourist(2)] });
    const [ivan, anna] = await refsOf(1);
    const second = await native({ replacementOrderRef: first.orderRef, passengers: [tourist(2), tourist(1)] });
    assert.deepEqual(await refsOf(2), [anna, ivan]);
    const third = await native({ replacementOrderRef: second.orderRef, passengers: [tourist(1), tourist(3)] });
    const [ivan3, oleg] = await refsOf(3);
    assert.equal(ivan3, ivan);
    assert.ok(![ivan, anna].includes(oleg!));
    // Anna left; returning later she is a new participant, never her old ref.
    await native({ replacementOrderRef: third.orderRef, passengers: [tourist(1), tourist(2)] });
    const [ivan4, anna4] = await refsOf(4);
    assert.equal(ivan4, ivan);
    assert.notEqual(anna4, anna);
    // Same name and passport series but another document number is another person.
    const fifthOrder = (await currentPurchase(db.pool, first.purchaseRef!))!.documentOrderRef;
    await native({ replacementOrderRef: fifthOrder, passengers: [tourist(1, { document: { type: 'RU_PASSPORT', series: '3210', number: '999999' } }), tourist(2)] });
    const [notIvan, anna5] = await refsOf(5);
    assert.notEqual(notIvan, ivan);
    assert.equal(anna5, anna4);
  });

  test('forged continuity is refused: a ref from another purchase, or a carried ref on another tourist', async () => {
    await native({ passengers: [tourist(4)] });
    const first = await native({ passengers: [tourist(1)] });
    await assert.rejects(partial('FOREIGN_REF', { replacementOrderRef: first.orderRef, passengers: [tourist(1)] }), /PURCHASE_PARTICIPANT_CONTINUITY/);
    await assert.rejects(partial('WRONG_CARRY', { replacementOrderRef: first.orderRef, passengers: [tourist(3)] }), /PURCHASE_PARTICIPANT_CONTINUITY/);
    assert.equal(await count('purchase_revision'), 2);
    assert.equal((await order(first.orderRef)).status, 'RESERVED');
  });

  test('the revision hash commits to its document order', async () => {
    await native();
    const { same, moved } = (await db.owner.query(`SELECT fn_purchase_revision_hash(p.purchase_ref, r) = r.revision_hash AS same,
        fn_purchase_revision_hash(p.purchase_ref, jsonb_populate_record(r, jsonb_build_object('document_order_id', gen_random_uuid())))
          <> r.revision_hash AS moved
      FROM purchase_revision r JOIN purchase p ON p.id = r.purchase_id`)).rows[0];
    assert.deepEqual({ same, moved }, { same: true, moved: true });
  });
});
