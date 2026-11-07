// Track A / A2b (OWNER A2b-10 decision of 06.11.2026, migration 0025): no payment starts under terms
// replaced since the buyer accepted them; an operation already registered completes on its own terms.
// Real PostgreSQL, production roles (contract §17).
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';

import pg from 'pg';

import { currentTermsOf, openCollection, recordBankEvidence, releaseStaleHold } from '../src/bank-operations.js';
import type { Catalog } from '../src/catalog.js';
import { issueCheckoutIntent, openCheckoutSession, resumeView, tokenSha256 } from '../src/checkout-session.js';
import { setSalesOpen, type OrderDeps } from '../src/orders.js';
import { reserveNativePurchase, retryNativePurchasePayment } from '../src/purchases.js';
import { fixtureCatalog, freshDb, resetOrders, seedCatalog, type TestDb } from './helpers.js';

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const SLUG = 'altai-terms-guard';

let db: TestDb;
let catalog: Catalog;
let departureId: string;
let adult: number;

const deps = (c: Catalog = catalog): OrderDeps => ({ pool: db.pool, catalog: c, log: () => undefined, allowDemo: false });
const newOffer = () => ({ ...catalog, terms: { ...catalog.terms, ref: 'oferta@next', hash: `sha256:${'7'.repeat(64)}` } });
const newConsent = () => ({ ...catalog, pdConsent: { ...catalog.pdConsent, hash: `sha256:${'8'.repeat(64)}` } });
async function buy() {
  const s = await openCheckoutSession(db.pool);
  const intent = await issueCheckoutIntent(db.pool, s.token);
  assert.ok(intent.ok);
  const r = await reserveNativePurchase(deps(), {
    departureSlug: SLUG, buyer: { fullName: 'Анна Покупатель', phone: '+7 903 907-55-47', email: 'buyer@example.ru' },
    tickets: { adults: 2, teens: 0, children: 0 }, ageTermsConfirmed: true, termsRef: catalog.terms.ref, termsHash: catalog.terms.hash,
    pdConsentConfirmed: true, pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash,
    session: { token: s.token }, checkoutIntent: { key: intent.key } });
  assert.ok(r.ok, JSON.stringify(r));
  return { ...r, token: s.token };
}
const open = (p: { purchaseRef: string; token: string }, c: Catalog = catalog) =>
  openCollection(db.pool, p.purchaseRef, p.token, 'alfa', 'mikluha-test', currentTermsOf(c));
const states = async (purchaseRef: string) => (await db.owner.query(
  'SELECT state FROM seat_slot_current WHERE purchase_ref = $1 ORDER BY position', [purchaseRef])).rows.map((r) => r.state);
const operations = async () => Number((await db.owner.query('SELECT count(*) AS n FROM bank_operation')).rows[0].n);
/** The organizer publishes a new revision of the departure (test-only copy of the current one). */
const PUBLISH = [`INSERT INTO departure_revision (departure_id, version, draft_revision, document, document_sha256, published_by, login_role, published_at)
    SELECT r.departure_id, r.version + 1, r.draft_revision, r.document, r.document_sha256, r.published_by, r.login_role, now()
      FROM departure_revision r JOIN departure d ON d.id = r.departure_id AND r.version = d.published_version WHERE d.id = $1`,
  'UPDATE departure SET published_version = published_version + 1 WHERE id = $1'];
async function publishNewRevision() {
  await db.owner.query('BEGIN');
  try {
    await db.owner.query('SET LOCAL session_replication_role = replica');
    for (const sql of PUBLISH) await db.owner.query(sql, [departureId]);
    await db.owner.query('COMMIT');
  } catch (e) { await db.owner.query('ROLLBACK'); throw e; }
}

before(async () => {
  db = await freshDb();
  catalog = fixtureCatalog([{ slug: SLUG, startsOn: day(30), endsOn: day(33), capacity: 10 }]);
  await seedCatalog(db, catalog);
  departureId = (await db.owner.query('SELECT id FROM departure WHERE slug = $1', [SLUG])).rows[0].id;
  adult = catalog.departures.get(SLUG)!.priceKopecks!;
  await setSalesOpen(db.operator, true, 'test', 'open for the test');
});
after(async () => { await db?.drop(); });
beforeEach(async () => { await resetOrders(db.owner); });

describe('0025: no new bank operation under replaced terms', () => {
  test('a live hold after a new departure revision: registration refused, nothing recorded; the hold can be released at once', async () => {
    const a = await buy();
    await publishNewRevision();
    assert.deepEqual(await open(a), { ok: false, refusal: 'DEPARTURE_CHANGED' });
    assert.equal(await operations(), 0, 'no operation is recorded for refused terms');
    assert.deepEqual(await states(a.purchaseRef), ['HELD', 'HELD']);
    // Current terms: nothing to release. Stale terms: released once, idempotently.
    assert.equal(await releaseStaleHold(db.pool, a.purchaseRef, a.token, currentTermsOf(catalog)), true, 'the departure itself changed');
    assert.equal(await releaseStaleHold(db.pool, a.purchaseRef, a.token, currentTermsOf(catalog)), false, 'idempotent');
    assert.deepEqual(await states(a.purchaseRef), ['RELEASED', 'RELEASED']);
    const reasons = (await db.owner.query(`SELECT e.reason FROM seat_slot_event e JOIN seat_slot s ON s.id = e.seat_slot_id
      JOIN purchase p ON p.id = s.purchase_id WHERE p.purchase_ref = $1 ORDER BY e.id`, [a.purchaseRef])).rows.map((r) => r.reason);
    assert.deepEqual(reasons.slice(-2), ['TERMS_CHANGED', 'TERMS_CHANGED']);
    assert.equal((await resumeView(db.pool, a.purchaseRef, a.token))!.state, 'RELEASED');
    // A new cycle under the old terms is refused too (0021 checks the current revision's departure version).
    assert.deepEqual(await retryNativePurchasePayment(deps(), a.purchaseRef, a.token), { ok: false, refusal: 'DEPARTURE_CHANGED' });
  });

  test('a new offer or PD consent: registration and a new cycle refused in the database; a registered operation still replays', async () => {
    for (const changed of [newOffer(), newConsent()]) {
      await resetOrders(db.owner);
      const a = await buy();
      assert.deepEqual(await open(a, changed), { ok: false, refusal: 'LEGAL_TERMS_CHANGED' });
      assert.equal(await releaseStaleHold(db.pool, a.purchaseRef, a.token, currentTermsOf(catalog)), false, 'terms current: nothing released');
      // Registered before the change: its identity is returned after the change, unchanged.
      const b = await buy();
      const first = await open(b);
      assert.ok(first.ok);
      const replay = await open(b, changed);
      assert.ok(replay.ok, JSON.stringify(replay));
      assert.deepEqual([replay.bankOperationRef, replay.replayed], [first.bankOperationRef, true]);
      assert.equal(await releaseStaleHold(db.pool, b.purchaseRef, b.token, currentTermsOf(changed)), false, 'a fenced hold is never released');
      // After a proven failure, no new cycle under the replaced release, whoever calls the SQL.
      await recordBankEvidence(db.pool, first.bankOperationRef, { source: 'CALLBACK', observed: 'FAILED', provider: 'alfa',
        merchantAccount: 'mikluha-test', payload: `failed-${changed.terms.ref}-${changed.pdConsent.hash}` });
      assert.deepEqual(await retryNativePurchasePayment(deps(changed), b.purchaseRef, b.token), { ok: false, refusal: 'LEGAL_TERMS_CHANGED' });
      const c = currentTermsOf(changed);
      await assert.rejects(db.pool.query('SELECT * FROM fn_purchase_rehold_current($1, $2, $3, $4, $5, $6)',
        [b.purchaseRef, tokenSha256(b.token), c.termsRef, c.termsHash, c.pdConsentRef, c.pdConsentHash]), /LEGAL_TERMS_CHANGED/);
      assert.equal((await retryNativePurchasePayment(deps(), b.purchaseRef, b.token)).ok, true, 'under the accepted release it proceeds');
    }
  });

  test('the 0023 entry points without the terms are no longer the service\'s', async () => {
    const a = await buy();
    for (const sql of [`SELECT * FROM fn_bank_operation_open_owned('${a.purchaseRef}', '${tokenSha256(a.token)}', 'alfa', 'x')`,
      `SELECT * FROM fn_purchase_rehold_owned('${a.purchaseRef}', '${tokenSha256(a.token)}')`]) {
      await assert.rejects(db.pool.query(sql), /permission denied/);
    }
    assert.deepEqual(await open(a, { ...catalog, terms: { ...catalog.terms, hash: '' } }), { ok: false, refusal: 'LEGAL_TERMS_CHANGED' });
  });
});

describe('0025: registration and publication serialize on the departure', () => {
  /** A second superuser connection that publishes under the departure lock, as fn_publish_departure_change. */
  async function lockedPublisher() {
    const c = new pg.Client({ connectionString: db.url.toString() });
    await c.connect();
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    return {
      async lockAndPublish() {
        await c.query('SELECT 1 FROM departure WHERE id = $1 FOR NO KEY UPDATE', [departureId]);
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended('departure:' || $1, 0))", [SLUG]);
        for (const sql of PUBLISH) await c.query(sql, [departureId]);
      },
      async commit() { try { await c.query('COMMIT'); } finally { await c.end(); } },
    };
  }

  test('publication first: the waiting registration sees the new revision and is refused', async () => {
    const a = await buy();
    const pub = await lockedPublisher();
    await pub.lockAndPublish();
    let settled = false;
    const pending = open(a).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(settled, false, 'the registration waits for the publication');
    await pub.commit();
    assert.deepEqual(await pending, { ok: false, refusal: 'DEPARTURE_CHANGED' });
    assert.equal(await operations(), 0);
  });

  test('registration first: the publication waits; the registered operation then completes on its terms', async () => {
    const a = await buy();
    const c = await db.pool.connect();
    const t = currentTermsOf(catalog);
    let opRef: string;
    try {
      await c.query('BEGIN');
      opRef = (await c.query('SELECT bank_operation_ref FROM fn_bank_operation_open_payment($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [a.purchaseRef, tokenSha256(a.token), 'alfa', 'mikluha-test', t.termsRef, t.termsHash, t.pdConsentRef, t.pdConsentHash, 'FULL'])).rows[0].bank_operation_ref;
      const pub = await lockedPublisher();
      let published = false;
      const publication = pub.lockAndPublish().then(() => { published = true; });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(published, false, 'the publication waits for the registration');
      await c.query('COMMIT');
      await publication;
      await pub.commit();
    } finally { c.release(); }
    const replay = await open(a);
    assert.ok(replay.ok, JSON.stringify(replay));
    assert.deepEqual([replay.bankOperationRef, replay.replayed], [opRef, true], 'registered before the change: replayed after it');
    const done = await recordBankEvidence(db.pool, opRef, { source: 'CALLBACK', observed: 'SUCCEEDED', provider: 'alfa',
      merchantAccount: 'mikluha-test', providerOperationId: 'alfa-registered-before', amountKopecks: 2 * adult, currency: 'RUB', payload: 'ok' });
    assert.deepEqual([done.status, done.seatEffect], ['SUCCEEDED', 'SEATS_CONFIRMED']);
  });
});
