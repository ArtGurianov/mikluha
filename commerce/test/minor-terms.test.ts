// Track A / A2b-8 for TOUR-28/35/65 (migration 0024): the child price, the permission to sell minors'
// seats and the minimum age are written only by the departure's publication and accepted in the
// contract snapshot v2 (contract §16; OWNER 3/6A; v1.9.1 §6, G-PRICE-PUB). Real PostgreSQL, production roles.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import type pg from 'pg';

import { createUser } from '../src/admin/operator.js';
import type { Catalog } from '../src/catalog.js';
import { issueCheckoutIntent, openCheckoutSession } from '../src/checkout-session.js';
import { CONTRACT_SNAPSHOT_SCHEMA_V2, contractSnapshotIntact } from '../src/contract-snapshot.js';
import { setSalesOpen, type OrderDeps } from '../src/orders.js';
import { reserveNativePurchase, type NativePurchaseRequest } from '../src/purchases.js';
import { fixtureCatalog, freshDb, resetOrders, seedCatalog, type TestDb } from './helpers.js';

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const SLUG = 'altai-minor-terms';
const CHILD = 1_500_000;

let db: TestDb;
let catalog: Catalog;
let departureId: string;
const staff = { owner: '', manager: '' };

type Terms = { allowed: boolean; minAge: number | null; childPriceKopecks: number | null };
const columns = async () => (await db.owner.query(`SELECT minors_allowed AS allowed, minor_min_age AS "minAge",
  child_price_kopecks AS "childPriceKopecks", minor_settings_version AS version, minor_sales_paused AS paused, published_version AS published
  FROM departure WHERE id = $1`, [departureId])).rows[0];
/** draft → check → publish, as the Control Room does (admin_app saves, admin_publisher publishes). */
async function publish(terms: Terms | undefined, extra: Record<string, unknown> = {}) {
  const draft = (await db.owner.query('SELECT revision, document FROM departure_draft WHERE departure_id = $1', [departureId])).rows[0];
  const document = { ...draft.document, ...extra };
  delete document.minorTerms;
  if (terms !== undefined) document.minorTerms = terms;
  const revision = (await db.admin.query('SELECT fn_save_departure_draft($1, $2, $3, $4) AS r',
    [departureId, draft.revision, document, 'fixture'])).rows[0].r;
  const published = (await columns()).published;
  return db.publisher.query('SELECT fn_publish_departure($1, $2, $3, $4) AS v', [departureId, revision, published, 'owner-publication']);
}
const deps = (pool: pg.Pool = db.pool): OrderDeps => ({ pool, catalog, log: () => undefined, allowDemo: false });
async function request(tickets = { adults: 1, teens: 0, children: 1 }): Promise<NativePurchaseRequest> {
  const s = await openCheckoutSession(db.pool);
  const intent = await issueCheckoutIntent(db.pool, s.token);
  assert.ok(intent.ok);
  return { departureSlug: SLUG, buyer: { fullName: 'Анна Покупатель', phone: '+7 903 907-55-47', email: 'buyer@example.ru' },
    tickets, ageTermsConfirmed: true, termsRef: catalog.terms.ref, termsHash: catalog.terms.hash,
    pdConsentConfirmed: true, pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash,
    session: { token: s.token }, checkoutIntent: { key: intent.key } };
}
/** A pool whose clients rewrite the order INSERT's contract snapshot: a service path that lies about terms. */
function rewritingSnapshot(pool: pg.Pool, rewrite: (s: Record<string, unknown>) => Record<string, unknown>): pg.Pool {
  return new Proxy(pool, { get(target, prop) {
    if (prop !== 'connect') return Reflect.get(target, prop);
    return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(c, p) {
        if (p !== 'query') { const v = Reflect.get(c, p); return typeof v === 'function' ? v.bind(c) : v; }
        return (sql: unknown, values?: unknown[]) => {
          if (typeof sql === 'string' && sql.includes('INSERT INTO orders') && Array.isArray(values)) {
            values = values.map((v) => (v !== null && typeof v === 'object' && 'schema' in (v as object) ? rewrite({ ...(v as Record<string, unknown>) }) : v));
          }
          return (c.query as (...a: unknown[]) => unknown)(sql, values);
        };
      } });
    };
  } }) as pg.Pool;
}

before(async () => {
  db = await freshDb();
  catalog = fixtureCatalog([{ slug: SLUG, startsOn: day(30), endsOn: day(33), capacity: 10 }]);
  await seedCatalog(db, catalog);
  departureId = (await db.owner.query('SELECT id FROM departure WHERE slug = $1', [SLUG])).rows[0].id;
  staff.owner = await createUser(db.adminOperator, 'terms-owner', 'OWNER', 'correct horse battery staple 42', 'test');
  staff.manager = await createUser(db.adminOperator, 'terms-manager', 'MANAGER', 'correct horse battery staple 42', 'test');
  await setSalesOpen(db.operator, true, 'test', 'open for the test');
});
after(async () => { await db?.drop(); });
beforeEach(async () => { await resetOrders(db.owner); });

describe('A2b-8: the publication is the only writer of the minor terms', () => {
  test('publishing minorTerms writes them, versions them once and audits them; republishing the same changes nothing', async () => {
    const before = await columns();
    assert.deepEqual([before.allowed, before.minAge, before.childPriceKopecks], [false, null, null]);
    await publish({ allowed: true, minAge: 7, childPriceKopecks: CHILD });
    let c = await columns();
    assert.deepEqual([c.allowed, c.minAge, Number(c.childPriceKopecks), c.version], [true, 7, CHILD, before.version + 1]);
    const event = (await db.owner.query(`SELECT actor, action, version, details FROM departure_minor_event WHERE departure_id = $1
      ORDER BY id DESC LIMIT 1`, [departureId])).rows[0];
    assert.deepEqual([event.actor, event.action, event.version, event.details.childPriceKopecks, event.details.departureVersion],
      ['owner-publication', 'SETTINGS', c.version, CHILD, c.published]);
    await publish({ allowed: true, minAge: 7, childPriceKopecks: CHILD });
    assert.equal((await columns()).version, c.version, 'the same terms are not a new version');
    // A publication without minorTerms: minors are not sold, no orphan price or age.
    await publish(undefined);
    c = await columns();
    assert.deepEqual([c.allowed, c.minAge, c.childPriceKopecks], [false, null, null]);
  });

  test('invalid terms are refused at publication; no login writes the columns directly; the pause rewrites nothing', async () => {
    for (const bad of [{ allowed: false, minAge: null, childPriceKopecks: CHILD }, { allowed: true, minAge: 18, childPriceKopecks: null },
      { allowed: true, minAge: null, childPriceKopecks: 0 }, { allowed: 'yes', minAge: null, childPriceKopecks: null },
      // Review of PR #89: 0–13 seats sellable without an explicit child price; a child price where no 0–13 seat exists.
      { allowed: true, minAge: null, childPriceKopecks: null }, { allowed: true, minAge: 7, childPriceKopecks: null },
      { allowed: true, minAge: 14, childPriceKopecks: CHILD }]) {
      await assert.rejects(publish(bad as unknown as Terms), /DEPARTURE_DOCUMENT_INVALID/, JSON.stringify(bad));
    }
    await assert.rejects(publish({ allowed: true, minAge: null, childPriceKopecks: null, note: 'x' } as unknown as Terms), /DEPARTURE_DOCUMENT_INVALID/);
    // Valid: teenagers only (no child price), and a child price deliberately equal to the adult price.
    await publish({ allowed: true, minAge: 14, childPriceKopecks: null });
    assert.deepEqual([(await columns()).minAge, (await columns()).childPriceKopecks], [14, null]);
    const adultPrice = catalog.departures.get(SLUG)!.priceKopecks!;
    await publish({ allowed: true, minAge: null, childPriceKopecks: adultPrice });
    assert.equal(Number((await columns()).childPriceKopecks), adultPrice);
    await publish({ allowed: true, minAge: null, childPriceKopecks: CHILD });
    await assert.rejects(db.owner.query('UPDATE departure SET child_price_kopecks = 1 WHERE id = $1', [departureId]),
      /DEPARTURE_MINOR_TERMS_PUBLICATION_ONLY/);
    await assert.rejects(db.owner.query('UPDATE departure SET minors_allowed = false WHERE id = $1', [departureId]),
      /DEPARTURE_MINOR_TERMS_PUBLICATION_ONLY/);
    for (const pool of [db.admin, db.pool, db.operator]) {
      await assert.rejects(pool.query('UPDATE departure SET minor_min_age = 14 WHERE id = $1', [departureId]), /permission denied/);
    }
    const c = await columns();
    await db.admin.query('SELECT fn_admin_minor_sales_pause($1, $2, $3, true, $4)', [staff.manager, departureId, c.version, 'incident']);
    const paused = await columns();
    assert.deepEqual([paused.paused, paused.allowed, Number(paused.childPriceKopecks), paused.version], [true, true, CHILD, c.version + 1]);
    await db.admin.query('SELECT fn_admin_minor_sales_pause($1, $2, $3, false, $4)', [staff.owner, departureId, paused.version, 'resolved']);
    const projected = (await db.pool.query(`SELECT minors_allowed, minor_min_age, child_price_kopecks, minor_sales_paused
      FROM public_departure WHERE slug = $1`, [SLUG])).rows[0];
    assert.deepEqual([projected.minors_allowed, projected.minor_min_age, Number(projected.child_price_kopecks), projected.minor_sales_paused],
      [true, null, CHILD, false]);
  });
});

describe('A2b-8: the buyer accepts the published terms in the contract snapshot v2', () => {
  test('a priced purchase carries /2 with the published terms; the basis freezes the same child price', async () => {
    await publish({ allowed: true, minAge: null, childPriceKopecks: CHILD });
    const r = await reserveNativePurchase(deps(), await request());
    assert.ok(r.ok, JSON.stringify(r));
    const o = (await db.owner.query('SELECT id, contract_snapshot, contract_snapshot_sha256, accepted_departure_version FROM orders WHERE order_ref = $1',
      [r.orderRef])).rows[0];
    assert.equal(o.contract_snapshot.schema, CONTRACT_SNAPSHOT_SCHEMA_V2);
    assert.deepEqual(o.contract_snapshot.minorTerms, { allowed: true, minAge: null, childPriceKopecks: CHILD });
    assert.equal(contractSnapshotIntact(o.contract_snapshot, o.contract_snapshot_sha256), true);
    const basis = (await db.owner.query('SELECT child_price_kopecks, minor_settings_version FROM pricing_basis WHERE document_order_id = $1', [o.id])).rows[0];
    assert.deepEqual([Number(basis.child_price_kopecks), basis.minor_settings_version], [CHILD, (await columns()).version]);
    assert.equal(r.amountKopecks, catalog.departures.get(SLUG)!.priceKopecks + CHILD);
  });

  test('a snapshot whose terms differ from the published ones, or a /1 snapshot for priced seats, is refused', async () => {
    await publish({ allowed: true, minAge: null, childPriceKopecks: CHILD });
    await assert.rejects(reserveNativePurchase(deps(rewritingSnapshot(db.pool, (s) => ({ ...s, minorTerms: { allowed: true, minAge: null,
      childPriceKopecks: CHILD - 1 } }))), await request()), /ORDER_MINOR_TERMS_MISMATCH/);
    await assert.rejects(reserveNativePurchase(deps(rewritingSnapshot(db.pool, (s) => {
      const { minorTerms: _drop, ...rest } = s;
      return { ...rest, schema: 'mikluha.order-contract/1' };
    })), await request()), /orders_contract_snapshot_model|ORDER_MINOR_TERMS_MISMATCH/);
    assert.equal(Number((await db.owner.query('SELECT count(*) AS n FROM orders')).rows[0].n), 0);
  });

});
