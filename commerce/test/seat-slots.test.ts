// Track A / TOUR-76 A2 (migration 0021): priced seat slots without tourist data, purchase groups and
// manager links, occupancy and the 31/30 counters, companions and invitations, the staff role
// matrix and the removal of the limit of six. Real PostgreSQL, production roles
// (docs/plans/2026-11-04-track-a-schema-roles-contract.md §10).
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';

import type pg from 'pg';

import { CAPABILITY_PERMISSIONS, PERMISSIONS, ROLES, staffPermitted, type Role } from '../src/admin/auth.js';
import { createUser, grantCapability, revokeCapability, setDisabled } from '../src/admin/operator.js';
import type { Catalog } from '../src/catalog.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import { schemaHead } from '../src/migrate.js';
import { recordBankEvidence } from '../src/bank-operations.js';
import { issueCheckoutIntent, openCheckoutSession, tokenSha256 } from '../src/checkout-session.js';
import { maintain, MAX_SEATS_PER_REQUEST, setSalesOpen, type OrderDeps } from '../src/orders.js';
import { reserveNativePurchase, reserveUniformNativePurchase, retryNativePurchasePayment, SEAT_HOLD_MINUTES,
  type NativePurchaseRequest } from '../src/purchases.js';
import { fixtureCatalog, freshDb, resetOrders, seedCatalog, tourist, type TestDb } from './helpers.js';

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const SLUG = 'altai-slots';
const OTHER = 'altai-slots-other';
const CHILD_PRICE = 2_000_000;

let db: TestDb;
let catalog: Catalog;
const legalArgs = () => [catalog.terms.ref, catalog.terms.hash, catalog.pdConsent.ref, catalog.pdConsent.hash];
let adult: number;
let departureId: string;
const staff: Record<'owner' | 'manager' | 'editor', string> = { owner: '', manager: '', editor: '' };

const deps = (now = new Date()): OrderDeps => ({ pool: db.pool, catalog, log: () => undefined, allowDemo: false, now: () => now });
/** sessionOf(purchaseRef): the browser session that created the purchase (migration 0023). */
const sessions = new Map<string, string>();
const sessionOf = (purchaseRef: string) => sessions.get(purchaseRef) ?? 'x'.repeat(43);
/** A checkout request of a fresh browser session with its own server-issued checkout intent (A2b-11/12). */
const request = async (over: Partial<NativePurchaseRequest> = {}): Promise<NativePurchaseRequest> => {
  const s = await openCheckoutSession(db.pool);
  const intent = await issueCheckoutIntent(db.pool, s.token);
  assert.ok(intent.ok);
  return { session: { token: s.token }, checkoutIntent: { key: intent.key }, ...base(), ...over };
};
const base = () => ({
  departureSlug: SLUG, buyer: { fullName: 'Анна Покупатель', phone: '+7 903 907-55-47', email: 'Buyer@Example.ru' },
  tickets: { adults: 1, teens: 0, children: 0 }, ageTermsConfirmed: true,
  termsRef: catalog.terms.ref, termsHash: catalog.terms.hash,
  pdConsentConfirmed: true, pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash,
});
async function buy(over: Partial<NativePurchaseRequest> = {}, now?: Date) {
  const req = await request(over);
  const r = await reserveNativePurchase(deps(now), req);
  assert.ok(r.ok, JSON.stringify(r));
  sessions.set(r.purchaseRef, req.session.token);
  return { ...(r as Extract<typeof r, { ok: true }>), session: req.session.token };
}
const slots = async (purchaseRef: string) => (await db.owner.query(
  'SELECT * FROM seat_slot_current WHERE purchase_ref = $1 ORDER BY position', [purchaseRef])).rows;
const PROVIDER = 'alfa';
const ACCOUNT = 'mikluha-test';
/**
 * TOUR-77's calls, synthetic (migration 0022): the bank operation is recorded and fences the cycle
 * before registration; the attempt is that operation's reference. r = the hold, att = the operation.
 */
const fence = (purchaseRef: string, provider = PROVIDER) => db.pool.query(
  'SELECT hold_ref AS r, bank_operation_ref AS att FROM fn_bank_operation_open_payment($1, $2, $3, $4, $5, $6, $7, $8, $9)',
  [purchaseRef, tokenSha256(sessionOf(purchaseRef)), provider, ACCOUNT, ...legalArgs(), 'FULL']);
let payloads = 0;
/** The bank's authenticated answer about an operation, matching it (as TOUR-77 would record it). */
async function bankSays(att: string, observed: 'SUCCEEDED' | 'FAILED', payload = `payload-${++payloads}`) {
  const op = (await db.owner.query('SELECT amount_kopecks, currency FROM bank_operation WHERE bank_operation_ref = $1', [att])).rows[0];
  return recordBankEvidence(db.pool, att, { source: 'CALLBACK', observed, provider: PROVIDER, merchantAccount: ACCOUNT,
    providerOperationId: `alfa-order-${att}`, amountKopecks: op === undefined ? 1 : Number(op.amount_kopecks), currency: op?.currency ?? 'RUB', payload });
}
/** What a success changed in the seats (nothing, when it changed no status). */
const confirmed = async (_purchaseRef: string, att: string) => {
  const r = await bankSays(att, 'SUCCEEDED');
  return r.effect === 'STATUS_CHANGED' ? { confirmed: r.confirmed, no_seat: r.noSeat } : { confirmed: 0, no_seat: 0 };
};
const failed = (_purchaseRef: string, att: string) => bankSays(att, 'FAILED');
/** A paid cycle: fence and confirm. Returns the attempt. */
async function pay(purchaseRef: string) {
  const att: string = (await fence(purchaseRef)).rows[0].att;
  assert.equal((await confirmed(purchaseRef, att)).no_seat, 0);
  return att;
}
/** A proven failure of a recorded attempt. Returns the attempt (a late success may follow). */
async function fail(purchaseRef: string) {
  const att: string = (await fence(purchaseRef)).rows[0].att;
  await failed(purchaseRef, att);
  return att;
}
/**
 * Test-only passage of time. Holds and retry windows run on the database clock and their columns are
 * immutable for every login; only this disposable database's superuser can suspend triggers to age them.
 */
async function asOwnerWithoutTriggers(sql: string, values: unknown[]) {
  await db.owner.query('BEGIN');
  try {
    await db.owner.query('SET LOCAL session_replication_role = replica');
    await db.owner.query(sql, values);
    await db.owner.query('COMMIT');
  } catch (e) { await db.owner.query('ROLLBACK'); throw e; }
}
/** The purchase's open hold reached its five minutes. */
const lapse = (purchaseRef: string) => asOwnerWithoutTriggers(`UPDATE seat_hold SET expires_at = clock_timestamp() - interval '1 second'
  WHERE closed_at IS NULL AND purchase_id = (SELECT id FROM purchase WHERE purchase_ref = $1)`, [purchaseRef]);
/** 24 hours passed since the purchase was created (the retry window). */
const ageRetryWindow = (purchaseRef: string) => asOwnerWithoutTriggers(
  "UPDATE purchase SET created_at = created_at - interval '25 hours' WHERE purchase_ref = $1", [purchaseRef]);
const orderStatus = async (orderRef: string) => (await db.owner.query('SELECT status FROM orders WHERE order_ref = $1', [orderRef])).rows[0].status;

/**
 * Stand-in for a future TOUR-79 amendment revision (contract A2b-3): 0021 gives no service login a
 * way to cancel a confirmed seat, so only this disposable database's owner can.
 */
const cancelByAmendment = (slotRef: string) => db.owner.query("UPDATE seat_slot SET state = 'CANCELLED' WHERE seat_slot_ref = $1", [slotRef]);
const projection = async (slug = SLUG) =>
  (await db.pool.query('SELECT * FROM departure_seat_projection WHERE slug = $1', [slug])).rows[0];
const taken = async (now = new Date(), slug = SLUG) =>
  Number((await db.pool.query('SELECT fn_departure_taken_seats($1, $2) AS n', [slug, now])).rows[0].n);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(24).toString('base64url');
/**
 * The departure's minors' terms (child price, permission, minimum age). Only the departure's
 * publication writes them (OWNER decision 3, A2b-8, migration 0024; tested in minor-terms.test.ts).
 * A publication is also a new departure version, which these tests must not see; so the fixture sets
 * the columns as this disposable database's superuser with triggers suspended, bumping the version
 * the pricing basis records, as a publication would.
 */
const minorSettings = async (allowed: boolean, minAge: number | null = null, childPrice: number | null = CHILD_PRICE, id = departureId) => {
  await asOwnerWithoutTriggers(`UPDATE departure SET minors_allowed = $2, minor_min_age = $3, child_price_kopecks = $4,
    minor_settings_version = minor_settings_version + 1 WHERE id = $1`,
    // As a publication would allow (0024): no minimum age or child price when minors are not sold, and a
    // child price exactly when 0–13 seats can be sold (no minimum age, or one below 14).
    [id, allowed, allowed ? minAge : null, allowed && (minAge === null || minAge < 14) ? childPrice : null]);
};
const pause = async (who: string, paused: boolean) => {
  const v = (await db.owner.query('SELECT minor_settings_version AS v FROM departure WHERE id = $1', [departureId])).rows[0].v;
  return db.admin.query('SELECT fn_admin_minor_sales_pause($1, $2, $3, $4, $5)', [who, departureId, v, paused, 'test pause']);
};
const groupOf = async (purchaseRef: string) => (await db.owner.query(`SELECT g.purchase_group_ref FROM purchase p
  JOIN purchase_group_member m ON m.purchase_id = p.id JOIN purchase_group g ON g.id = m.group_id WHERE p.purchase_ref = $1`, [purchaseRef])).rows[0].purchase_group_ref;
type Tickets = { adults: number; teens: number; children: number };
const issueLink = async (groupRef: string, tickets: Tickets = { adults: 1, teens: 0, children: 0 }, who = staff.manager) => {
  const t = token();
  await db.admin.query('SELECT fn_group_link_issue($1, $2, $3, $4, $5, $6)', [who, groupRef, sha(t), tickets.adults, tickets.teens, tickets.children]);
  return t;
};

before(async () => {
  db = await freshDb();
  catalog = fixtureCatalog([{ slug: SLUG, startsOn: day(30), endsOn: day(33), capacity: 12 },
    { slug: OTHER, startsOn: day(40), endsOn: day(43), capacity: 12 }]);
  await seedCatalog(db, catalog);
  adult = catalog.departures.get(SLUG)!.priceKopecks;
  departureId = (await db.owner.query('SELECT id FROM departure WHERE slug = $1', [SLUG])).rows[0].id;
  for (const [k, role] of [['owner', 'OWNER'], ['manager', 'MANAGER'], ['editor', 'EDITOR']] as const) {
    staff[k] = await createUser(db.adminOperator, `slots-${k}`, role, 'correct horse battery staple 42', 'test');
  }
  await setSalesOpen(db.operator, true, 'test', 'open for the test');
});
after(async () => { await db?.drop(); });
beforeEach(async () => {
  await resetOrders(db.owner);
  await minorSettings(true);
});

describe('migration 0021 and the limit of six', () => {
  test('0021 is installed; UNIFORM revisions keep their hashes; seven tourists fit one UNIFORM purchase', async () => {
    assert.ok(schemaHead(MIGRATIONS_DIR) >= 21);
    assert.equal(MAX_SEATS_PER_REQUEST, 500);
    const r = await reserveUniformNativePurchase(deps(), {
      departureSlug: SLUG, contact: { phone: '+79039075547', email: 'ivan@example.ru' },
      passengers: Array.from({ length: 7 }, (_, i) => tourist(1, { document: { type: 'RU_PASSPORT', series: '3210', number: String(654400 + i) } })),
      adultsOnlyConfirmed: true, termsRef: catalog.terms.ref, termsHash: catalog.terms.hash,
      pdConsentConfirmed: true, pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash });
    assert.ok(r.ok, JSON.stringify(r));
    const row = (await db.owner.query(`SELECT r.revision_hash = fn_purchase_revision_hash(p.purchase_ref, r) AS same, r.seats, r.slot_model
      FROM purchase_revision r JOIN purchase p ON p.id = r.purchase_id WHERE p.purchase_ref = $1`, [r.purchaseRef])).rows[0];
    assert.deepEqual(row, { same: true, seats: 7, slot_model: 'UNIFORM' });
    assert.equal(await taken(), 7);
  });

  test('G-01/G-13: 5×18+, 1×14–17, 1×0–13 is one purchase of 7 priced seats, no tourist data', async () => {
    const r = await buy({ tickets: { adults: 5, teens: 1, children: 1 } });
    assert.equal(r.amountKopecks, 6 * adult + CHILD_PRICE);
    assert.equal(r.reservedUntil.getTime() - Date.now() <= SEAT_HOLD_MINUTES * 60_000, true);
    assert.match(r.purchaseGroupRef, /^mg-[0-9a-f]{20}$/);
    const s = await slots(r.purchaseRef);
    assert.deepEqual(s.map((x) => [x.position, x.ticket_type, Number(x.price_kopecks), x.state]), [
      [1, 'AGE_18_PLUS', adult, 'HELD'], [2, 'AGE_18_PLUS', adult, 'HELD'], [3, 'AGE_18_PLUS', adult, 'HELD'],
      [4, 'AGE_18_PLUS', adult, 'HELD'], [5, 'AGE_18_PLUS', adult, 'HELD'], [6, 'AGE_14_17', adult, 'HELD'],
      [7, 'AGE_0_13', CHILD_PRICE, 'HELD']]);
    const o = (await db.owner.query('SELECT * FROM orders WHERE order_ref = $1', [r.orderRef])).rows[0];
    assert.deepEqual([o.seat_model, o.seats, Number(o.unit_price_kopecks), Number(o.amount_kopecks), o.adults_only_confirmed, o.age_terms_confirmed],
      ['PRICED_SLOTS', 7, adult, 6 * adult + CHILD_PRICE, false, true]);
    assert.equal(Number((await db.owner.query('SELECT count(*) AS n FROM order_passenger WHERE order_id = $1', [o.id])).rows[0].n), 0);
    assert.equal((await db.owner.query('SELECT full_name FROM order_contact WHERE order_id = $1', [o.id])).rows[0].full_name, 'Анна Покупатель');
    const rev = (await db.owner.query(`SELECT r.*, r.revision_hash = fn_purchase_revision_hash(p.purchase_ref, r) AS hash_ok,
        r.lines_sha256 = fn_purchase_lines_sha256(r.purchase_id, 1) AS lines_ok, p.lifecycle_profile
      FROM purchase_revision r JOIN purchase p ON p.id = r.purchase_id WHERE p.purchase_ref = $1`, [r.purchaseRef])).rows[0];
    assert.deepEqual([rev.slot_model, rev.seats, rev.participant_refs, Number(rev.total_kopecks), rev.hash_ok, rev.lines_ok, rev.lifecycle_profile],
      ['PRICED_SLOTS', 7, [], 6 * adult + CHILD_PRICE, true, true, 'NATIVE_NO_REFERRAL']);
    const basis = (await db.owner.query('SELECT * FROM pricing_basis WHERE document_order_id = $1', [o.id])).rows;
    assert.equal(basis.length, 1);
    assert.deepEqual([Number(basis[0].adult_price_kopecks), Number(basis[0].child_price_kopecks), basis[0].source],
      [adult, CHILD_PRICE, 'PUBLISHED_GRID']);
    assert.equal(await taken(), 7);
  });

  test('twelve seats pass in one purchase; 501 and 0 are refused; the quota bounds the rest', async () => {
    await buy({ tickets: { adults: 12, teens: 0, children: 0 } });
    assert.deepEqual(await reserveNativePurchase(deps(), await request()), { ok: false, refusal: 'NOT_ENOUGH_SEATS' });
    for (const tickets of [{ adults: 501, teens: 0, children: 0 }, { adults: 0, teens: 0, children: 0 }, { adults: -1, teens: 2, children: 0 },
      { adults: 1.5, teens: 0, children: 0 }]) {
      assert.deepEqual(await reserveNativePurchase(deps(), await request({ tickets })), { ok: false, refusal: 'SEATS_INVALID' });
    }
    assert.deepEqual(await reserveNativePurchase(deps(), await request({ ageTermsConfirmed: false })), { ok: false, refusal: 'AGE_TERMS_NOT_CONFIRMED' });
  });

  test('a PRICED_SLOTS order takes no tourist rows and its seat model is fixed', async () => {
    const r = await buy();
    const id = (await db.owner.query('SELECT id FROM orders WHERE order_ref = $1', [r.orderRef])).rows[0].id;
    await assert.rejects(db.owner.query(`INSERT INTO order_passenger (order_id, position, full_name, date_of_birth, citizenship, document_type,
      document_series, document_number) VALUES ($1, 1, 'Иван Петров', '1990-05-17', 'RU', 'RU_PASSPORT', '3210', '654321')`, [id]),
      /PRICED_SLOTS_NO_TOURIST_DATA/);
    await assert.rejects(db.owner.query("UPDATE orders SET seat_model = 'UNIFORM' WHERE id = $1", [id]), /ORDER_SEAT_MODEL_IMMUTABLE/);
  });
});

describe('minors on checkout', () => {
  test('minors need permission, no pause, the minimum age and an adult in the purchase', async () => {
    await minorSettings(false, null);
    assert.deepEqual(await reserveNativePurchase(deps(), await request({ tickets: { adults: 1, teens: 1, children: 0 } })),
      { ok: false, refusal: 'MINORS_NOT_ALLOWED' });
    await buy(); // adults are not affected
    await minorSettings(true, 14);
    assert.deepEqual(await reserveNativePurchase(deps(), await request({ tickets: { adults: 1, teens: 0, children: 1 } })),
      { ok: false, refusal: 'TICKET_TYPE_NOT_ALLOWED' });
    await buy({ tickets: { adults: 1, teens: 1, children: 0 } });
    await minorSettings(true, null);
    assert.deepEqual(await reserveNativePurchase(deps(), await request({ tickets: { adults: 0, teens: 1, children: 1 } })),
      { ok: false, refusal: 'MINORS_WITHOUT_ADULT' });
    assert.equal(await taken(), 3);
  });

  test('OWNER 3A: a manager or the owner pauses, only the owner resumes; a child price equal to the adult one is published explicitly', async () => {
    await assert.rejects(pause(staff.editor, true), /STAFF_FORBIDDEN/);
    await pause(staff.manager, true);
    assert.deepEqual(await reserveNativePurchase(deps(), await request({ tickets: { adults: 1, teens: 0, children: 1 } })),
      { ok: false, refusal: 'MINOR_SALES_PAUSED' });
    await assert.rejects(pause(staff.manager, false), /STAFF_FORBIDDEN: minor_sales.resume/);
    await pause(staff.owner, false);
    // Review of PR #89: 0–13 seats with no published child price are not sold at the adult price by default.
    await asOwnerWithoutTriggers(`UPDATE departure SET child_price_kopecks = NULL, minor_settings_version = minor_settings_version + 1
      WHERE id = $1`, [departureId]);
    assert.deepEqual(await reserveNativePurchase(deps(), await request({ tickets: { adults: 1, teens: 0, children: 1 } })),
      { ok: false, refusal: 'MINOR_TERMS_NOT_PUBLISHED' });
    await minorSettings(true, null, adult);
    const r = await buy({ tickets: { adults: 1, teens: 0, children: 1 } });
    assert.equal(r.amountKopecks, 2 * adult);
    const events = (await db.owner.query('SELECT action, actor FROM departure_minor_event WHERE departure_id = $1 ORDER BY id', [departureId])).rows;
    assert.deepEqual(events.slice(-2).map((e) => [e.action, e.actor]), [['PAUSE', 'staff:slots-manager'], ['RESUME', 'staff:slots-owner']]);
    // The pricing basis names the settings version whose child price it froze.
    const basis = (await db.owner.query(`SELECT b.minor_settings_version, b.child_price_kopecks FROM pricing_basis b
      JOIN orders o ON o.id = b.document_order_id WHERE o.order_ref = $1`, [r.orderRef])).rows[0];
    const version = (await db.owner.query('SELECT minor_settings_version AS v FROM departure WHERE id = $1', [departureId])).rows[0].v;
    assert.deepEqual([basis.minor_settings_version, Number(basis.child_price_kopecks)], [version, adult]);
    await assert.rejects(db.admin.query('SELECT fn_admin_minor_sales_pause($1, $2, $3, $4, $5)', [staff.owner, departureId, 0, true, 'stale']),
      /DEPARTURE_MINOR_CONFLICT/);
    // OWNER decision 3: no separate command writes the child price or the minors' terms.
    await assert.rejects(db.admin.query('SELECT fn_admin_departure_minor_settings($1, $2, 0, true, null, null, $3)', [staff.owner, departureId, 'x']),
      /does not exist/);
  });
});

describe('groups and manager links (TOUR-90 / v1.9.0 §2–§3)', () => {
  test('a children-only purchase joins through a link only once the group has a confirmed adult', async () => {
    const a = await buy();
    const group = await groupOf(a.purchaseRef);
    const t = await issueLink(group, { adults: 0, teens: 0, children: 1 });
    const childOnly = { tickets: { adults: 0, teens: 0, children: 1 }, groupLink: { token: t, idempotencyKey: 'attempt-0001' } };
    assert.deepEqual(await reserveNativePurchase(deps(), await request(childOnly)), { ok: false, refusal: 'MINORS_WITHOUT_ADULT' });
    // A paid-no-seat exception is no adult either: A's attempt fails, the departure fills, A's bank success comes late.
    const lateA = await fail(a.purchaseRef);
    const full = await buy({ tickets: { adults: 12, teens: 0, children: 0 } });
    await pay(full.purchaseRef);
    assert.deepEqual(await confirmed(a.purchaseRef, lateA), { confirmed: 0, no_seat: 1 });
    const s = await slots(full.purchaseRef);
    await cancelByAmendment(s[0].seat_slot_ref);
    await cancelByAmendment(s[1].seat_slot_ref);
    assert.deepEqual(await reserveNativePurchase(deps(), await request(childOnly)), { ok: false, refusal: 'MINORS_WITHOUT_ADULT' });
    await db.admin.query('SELECT fn_seat_slot_assign_no_seat($1, $2, $3)', [staff.owner, (await slots(a.purchaseRef))[0].seat_slot_ref, 'seat freed']);
    const b = await buy(childOnly);
    assert.equal(b.purchaseGroupRef, group);
    assert.notEqual(b.purchaseRef, a.purchaseRef);
    assert.equal(b.amountKopecks, CHILD_PRICE);
    const member = (await db.owner.query(`SELECT m.joined_via FROM purchase_group_member m JOIN purchase p ON p.id = m.purchase_id
      WHERE p.purchase_ref = $1`, [b.purchaseRef])).rows[0];
    assert.equal(member.joined_via, 'STAFF_LINK');
    const g = (await db.pool.query('SELECT * FROM purchase_group_projection WHERE purchase_group_ref = $1', [group])).rows[0];
    assert.deepEqual([Number(g.purchases), Number(g.confirmed_adults), Number(g.held), Number(g.paid_no_seat), g.has_active_adult], [2, 1, 1, 0, true]);
  });

  test('review: the link fixes the manager\'s tickets; a repeated key replays only the same request, even after sales closed', async () => {
    const a = await buy();
    await pay(a.purchaseRef);
    const t = await issueLink(await groupOf(a.purchaseRef), { adults: 1, teens: 0, children: 1 });
    const link = { token: t, idempotencyKey: 'attempt-0001' };
    for (const tickets of [{ adults: 0, teens: 0, children: 2 }, { adults: 1, teens: 0, children: 0 }, { adults: 2, teens: 0, children: 1 },
      { adults: 1, teens: 1, children: 0 }]) {
      assert.deepEqual(await reserveNativePurchase(deps(), await request({ tickets, groupLink: link })), { ok: false, refusal: 'GROUP_LINK_TICKETS_MISMATCH' });
    }
    const b = await buy({ tickets: { adults: 1, teens: 0, children: 1 }, groupLink: link });
    // Lost response: the same attempt replays, also with sales closed; no new seats are created.
    await setSalesOpen(db.operator, false, 'test', 'closed during the replay');
    try {
      assert.deepEqual(await reserveNativePurchase(deps(), await request()), { ok: false, refusal: 'SALES_CLOSED' });
      const again = await buy({ tickets: { adults: 1, teens: 0, children: 1 }, groupLink: link });
      assert.deepEqual([again.replayed, again.purchaseRef, again.orderRef, again.amountKopecks], [true, b.purchaseRef, b.orderRef, b.amountKopecks]);
      // The same key with another request is a conflict, not a replay.
      assert.deepEqual(await reserveNativePurchase(deps(), await request({ tickets: { adults: 0, teens: 0, children: 2 }, groupLink: link })),
        { ok: false, refusal: 'IDEMPOTENCY_CONFLICT' });
      assert.deepEqual(await reserveNativePurchase(deps(), await request({ departureSlug: OTHER, tickets: { adults: 1, teens: 0, children: 1 }, groupLink: link })),
        { ok: false, refusal: 'IDEMPOTENCY_CONFLICT' });
    } finally { await setSalesOpen(db.operator, true, 'test', 'reopen'); }
    // Another key on the consumed link cannot buy again.
    assert.deepEqual(await reserveNativePurchase(deps(), await request({ tickets: { adults: 1, teens: 0, children: 1 },
      groupLink: { token: t, idempotencyKey: 'attempt-0002' } })), { ok: false, refusal: 'GROUP_LINK_INVALID' });
    assert.equal(Number((await db.owner.query('SELECT count(*) AS n FROM purchase')).rows[0].n), 2);
    await assert.rejects(db.admin.query('SELECT fn_group_link_issue($1, $2, $3, 0, 0, 0)', [staff.manager, await groupOf(a.purchaseRef), sha(token())]),
      /SEATS_INVALID/);
  });

  test('revoked, unknown and foreign-departure links are refused; only staff with the right issue them', async () => {
    const a = await buy();
    const group = await groupOf(a.purchaseRef);
    const t = await issueLink(group, undefined, staff.owner);
    const ref = (await db.owner.query('SELECT group_link_ref FROM purchase_group_link WHERE token_sha256 = $1', [sha(t)])).rows[0].group_link_ref;
    await db.admin.query('SELECT fn_group_link_revoke($1, $2, $3)', [staff.manager, ref, 'reissued']);
    await assert.rejects(db.admin.query('SELECT fn_group_link_revoke($1, $2, $3)', [staff.manager, ref, 'again']), /GROUP_LINK_ALREADY_FINAL/);
    assert.deepEqual(await reserveNativePurchase(deps(), await request({ groupLink: { token: t, idempotencyKey: 'attempt-0001' } })),
      { ok: false, refusal: 'GROUP_LINK_INVALID' });
    assert.deepEqual(await reserveNativePurchase(deps(), await request({ groupLink: { token: token(), idempotencyKey: 'attempt-0001' } })),
      { ok: false, refusal: 'GROUP_LINK_INVALID' });
    const other = await issueLink(group);
    assert.deepEqual(await reserveNativePurchase(deps(), await request({ departureSlug: OTHER, groupLink: { token: other, idempotencyKey: 'attempt-0003' } })),
      { ok: false, refusal: 'GROUP_LINK_DEPARTURE_MISMATCH' });
    await assert.rejects(issueLink(group, undefined, staff.editor), /STAFF_FORBIDDEN: group_link.issue/);
    await assert.rejects(db.pool.query('SELECT fn_group_link_issue($1, $2, $3, 1, 0, 0)', [staff.owner, group, sha(token())]), /permission denied/);
    // The token itself is never readable by the services.
    await assert.rejects(db.pool.query('SELECT token_sha256 FROM purchase_group_link'), /permission denied/);
  });
});

describe('payment cycles, occupancy and the paid-no-seat exception (3A)', () => {
  test('a lapsed hold frees its seats; a fenced one keeps them; the order ends after the retry window', async () => {
    const a = await buy({ tickets: { adults: 2, teens: 0, children: 0 } });
    const b = await buy({ tickets: { adults: 3, teens: 0, children: 0 } });
    assert.match((await fence(b.purchaseRef)).rows[0].r, /^sh-[0-9a-f]{20}$/);
    await lapse(a.purchaseRef);
    await lapse(b.purchaseRef);
    assert.equal(await taken(), 3);
    let m = await maintain(db.pool, () => undefined);
    assert.equal(m.expired, 0, 'a lapsed purchase may still start a new payment cycle');
    assert.deepEqual((await slots(a.purchaseRef)).map((s) => s.state), ['RELEASED', 'RELEASED']);
    assert.deepEqual((await slots(b.purchaseRef)).map((s) => s.state), ['HELD', 'HELD', 'HELD']);
    await ageRetryWindow(a.purchaseRef);
    m = await maintain(db.pool, () => undefined);
    assert.equal(m.expired, 1);
    const statuses = (await db.owner.query('SELECT status FROM orders ORDER BY created_at')).rows.map((o) => o.status);
    assert.deepEqual(statuses, ['EXPIRED', 'RESERVED']);
    assert.deepEqual((await retryNativePurchasePayment(deps(), a.purchaseRef, sessionOf(a.purchaseRef))), { ok: false, refusal: 'PURCHASE_CLOSED' });
    await assert.rejects(fence(b.purchaseRef, 'ALFA!'), /BANK_OPERATION_INVALID/);
  });

  test('review: an expired, unfenced hold is never confirmed after another buyer took the seats', async () => {
    // A's hold lapsed and maintain() has not run yet: its seats are not occupancy.
    const a = await buy({ tickets: { adults: 12, teens: 0, children: 0 } });
    await lapse(a.purchaseRef);
    assert.equal(await taken(), 0);
    const b = await buy({ tickets: { adults: 12, teens: 0, children: 0 } });
    // No attempt can be recorded after the hold lapsed, so no outcome can ever confirm it.
    await assert.rejects(fence(a.purchaseRef), /HOLD_EXPIRED/);
    assert.equal(Number((await db.owner.query('SELECT count(*) AS n FROM bank_operation')).rows[0].n), 0, 'no operation for a lapsed hold');
    for (const att of ['alfa:attempt-forged', 'bo-00000000000000000000']) await assert.rejects(confirmed(a.purchaseRef, att), /BANK_OPERATION_UNKNOWN/);
    // Not even the owner's DML confirms a seat whose hold did not close PAID.
    await assert.rejects(db.owner.query("UPDATE seat_slot SET state = 'CONFIRMED' WHERE purchase_id = (SELECT id FROM purchase WHERE purchase_ref = $1)",
      [a.purchaseRef]), /SEAT_SLOT_TRANSITION_INVALID/);
    await pay(b.purchaseRef);
    const p = await projection();
    assert.deepEqual([Number(p.taken_seats), Number(p.confirmed_seats), Number(p.paid_seat_claims), p.over_quota], [12, 12, 12, false]);
  });

  test('review: outcomes bind to the recorded attempt; UNKNOWN keeps the seats; no forged release or no-seat', async () => {
    const a = await buy({ tickets: { adults: 2, teens: 0, children: 0 } });
    await assert.rejects(confirmed(a.purchaseRef, 'alfa:never-recorded'), /BANK_OPERATION_UNKNOWN/);
    await assert.rejects(failed(a.purchaseRef, 'alfa:never-recorded'), /BANK_OPERATION_UNKNOWN/);
    // Since 0022 the service reaches 0021's fence and outcomes only through a bank operation.
    for (const sql of ["SELECT fn_purchase_hold_fence('mp-x', 'alfa:x')", "SELECT * FROM fn_purchase_payment_confirmed('mp-x', 'alfa:x')",
      "SELECT fn_purchase_payment_failed('mp-x', 'alfa:x')"]) await assert.rejects(db.pool.query(sql), /permission denied/);
    const opened = (await fence(a.purchaseRef)).rows[0];
    const att: string = opened.att;
    assert.deepEqual((await fence(a.purchaseRef)).rows[0], opened, 'recording the same attempt again is idempotent');
    await assert.rejects(fence(a.purchaseRef, 'sbp'), /HOLD_ALREADY_FENCED/);
    await assert.rejects(failed(a.purchaseRef, 'bo-ffffffffffffffffffff'), /BANK_OPERATION_UNKNOWN/);
    await assert.rejects(confirmed(a.purchaseRef, 'bo-ffffffffffffffffffff'), /BANK_OPERATION_UNKNOWN/);
    // UNKNOWN: past its five minutes, maintenance releases nothing; nobody can release or re-attribute the seats.
    await lapse(a.purchaseRef);
    await maintain(db.pool, () => undefined, new Date(Date.now() + 2 * 3_600_000));
    assert.deepEqual((await slots(a.purchaseRef)).map((s) => s.state), ['HELD', 'HELD']);
    assert.equal(await taken(), 2);
    await assert.rejects(db.owner.query("UPDATE seat_slot SET state = 'RELEASED' WHERE purchase_id = (SELECT id FROM purchase WHERE purchase_ref = $1)",
      [a.purchaseRef]), /SEAT_SLOT_TRANSITION_INVALID/);
    await assert.rejects(db.owner.query("UPDATE seat_slot SET state = 'PAID_NO_SEAT_EXCEPTION' WHERE purchase_id = (SELECT id FROM purchase WHERE purchase_ref = $1)",
      [a.purchaseRef]), /SEAT_SLOT_TRANSITION_INVALID/);
    await assert.rejects(db.owner.query('UPDATE seat_hold SET attempt_ref = $1', ['alfa:other']), /SEAT_HOLD_HISTORY_IMMUTABLE/);
    // The generic transition of 411218c is gone; the services cannot write seats directly.
    await assert.rejects(db.pool.query("SELECT fn_seat_slot_transition('x', 'RELEASED', 'a', 'b', 'c')"), /does not exist/);
    await assert.rejects(db.pool.query("UPDATE seat_slot SET state = 'RELEASED'"), /permission denied/);
    assert.deepEqual(await confirmed(a.purchaseRef, att), { confirmed: 2, no_seat: 0 });
    assert.deepEqual(await confirmed(a.purchaseRef, att), { confirmed: 0, no_seat: 0 }, 'a repeated confirmation changes nothing');
    // A failure after the bank confirmed the money changes nothing: contradictory evidence, manual settlement.
    const contradiction = await failed(a.purchaseRef, att);
    assert.deepEqual([contradiction.status, contradiction.effect, contradiction.settlementCaseRef !== null], ['SUCCEEDED', 'CONTRADICTORY', true]);
    assert.deepEqual((await slots(a.purchaseRef)).map((s) => s.state), ['CONFIRMED', 'CONFIRMED']);
  });

  test('review: a confirmed seat cannot be cancelled by any service login without a TOUR-79 amendment', async () => {
    const a = await buy();
    await pay(a.purchaseRef);
    const [s] = await slots(a.purchaseRef);
    for (const pool of [db.pool, db.admin, db.operator, db.adminOperator]) {
      await assert.rejects(pool.query("UPDATE seat_slot SET state = 'CANCELLED' WHERE seat_slot_ref = $1", [s.seat_slot_ref]), /permission denied/);
      const cancellers = (await pool.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef AND has_function_privilege(current_user, p.oid, 'EXECUTE')
          AND pg_get_functiondef(p.oid) ~ 'UPDATE seat_slot' AND pg_get_functiondef(p.oid) ~ 'CANCELLED'`)).rows.map((r) => r.proname);
      assert.deepEqual(cancellers, [], 'no executable SECURITY DEFINER function writes CANCELLED');
    }
    assert.equal((await slots(a.purchaseRef))[0].state, 'CONFIRMED');
  });

  test('review: after a proven failure the same purchase starts a new payment cycle', async () => {
    const a = await buy({ tickets: { adults: 2, teens: 0, children: 0 } });
    const first = await fail(a.purchaseRef);
    assert.deepEqual((await slots(a.purchaseRef)).map((s) => s.state), ['RELEASED', 'RELEASED']);
    const r = await retryNativePurchasePayment(deps(), a.purchaseRef, sessionOf(a.purchaseRef));
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual((await slots(a.purchaseRef)).map((s) => [s.state, s.hold_ref, Number(s.price_kopecks)]),
      [['HELD', r.holdRef, adult], ['HELD', r.holdRef, adult]]);
    assert.deepEqual(await retryNativePurchasePayment(deps(), a.purchaseRef, sessionOf(a.purchaseRef)), { ok: false, refusal: 'REHOLD_NOT_ALLOWED' });
    const second = await pay(a.purchaseRef);
    assert.notEqual(second, first);
    assert.deepEqual((await slots(a.purchaseRef)).map((s) => s.state), ['CONFIRMED', 'CONFIRMED']);
    // The earlier attempt's late success is a double collection: manual reconciliation, no seat change.
    const double = await bankSays(first, 'SUCCEEDED');
    assert.deepEqual([double.status, double.seatEffect, double.settlementCaseRef !== null], ['SUCCEEDED', 'NEWER_CYCLE_EXISTS', true]);
    const holds = (await db.owner.query(`SELECT cycle, outcome, attempt_ref FROM seat_hold h JOIN purchase p ON p.id = h.purchase_id
      WHERE p.purchase_ref = $1 ORDER BY cycle`, [a.purchaseRef])).rows;
    assert.deepEqual(holds, [{ cycle: 1, outcome: 'PAYMENT_FAILED', attempt_ref: first }, { cycle: 2, outcome: 'PAID', attempt_ref: second }]);
    assert.equal(Number((await db.owner.query('SELECT count(*) AS n FROM purchase')).rows[0].n), 1);

    // A retry is a new hold under the general rules: the quota, the sales switch, T−24.
    const b = await buy({ tickets: { adults: 2, teens: 0, children: 0 } });
    await fail(b.purchaseRef);
    const c = await buy({ tickets: { adults: 9, teens: 0, children: 0 } });
    assert.deepEqual(await retryNativePurchasePayment(deps(), b.purchaseRef, sessionOf(b.purchaseRef)), { ok: false, refusal: 'NOT_ENOUGH_SEATS' });
    await fail(c.purchaseRef);
    await setSalesOpen(db.operator, false, 'test', 'closed');
    try { assert.deepEqual(await retryNativePurchasePayment(deps(), b.purchaseRef, sessionOf(b.purchaseRef)), { ok: false, refusal: 'SALES_CLOSED' }); }
    finally { await setSalesOpen(db.operator, true, 'test', 'reopen'); }
    assert.equal((await retryNativePurchasePayment(deps(), b.purchaseRef, sessionOf(b.purchaseRef))).ok, true);
    // A hold that lapsed before any attempt may be retried too.
    const d = await buy();
    await lapse(d.purchaseRef);
    await maintain(db.pool, () => undefined);
    assert.equal((await slots(d.purchaseRef))[0].state, 'RELEASED');
    assert.equal((await retryNativePurchasePayment(deps(), d.purchaseRef, sessionOf(d.purchaseRef))).ok, true);
    await assert.rejects(db.pool.query('SELECT * FROM fn_purchase_rehold_current($1, $2, $3, $4, $5, $6)', [d.purchaseRef, tokenSha256(sessionOf(d.purchaseRef)), ...legalArgs()]), /REHOLD_NOT_ALLOWED/);
  });

  test('31/30: a late success with no room is a claim, not occupancy; the database decides, the owner assigns a freed seat', async () => {
    const a = await buy();
    const lateA = await fail(a.purchaseRef);
    const e = await buy({ tickets: { adults: 2, teens: 0, children: 0 } });
    const lateE = await fail(e.purchaseRef);
    const b = await buy({ tickets: { adults: 12, teens: 0, children: 0 } });
    await pay(b.purchaseRef);
    assert.deepEqual(await confirmed(a.purchaseRef, lateA), { confirmed: 0, no_seat: 1 });
    let p = await projection();
    const viaFunction = (await db.owner.query('SELECT fn_departure_taken_seats($1, now()) AS n', [SLUG])).rows[0].n;
    assert.equal(Number(p.taken_seats), Number(viaFunction));
    assert.deepEqual([p.online_quota, Number(p.taken_seats), Number(p.confirmed_seats), Number(p.paid_no_seat), Number(p.paid_seat_claims), p.over_quota],
      [12, 12, 12, 1, 13, true]);
    // One seat frees: E's late success gets it for its first seat, and an exception for its second.
    const bs = await slots(b.purchaseRef);
    await cancelByAmendment(bs[0].seat_slot_ref);
    assert.deepEqual(await confirmed(e.purchaseRef, lateE), { confirmed: 1, no_seat: 1 });
    assert.deepEqual(await confirmed(e.purchaseRef, lateE), { confirmed: 0, no_seat: 0 });
    const [aSlot] = await slots(a.purchaseRef);
    await assert.rejects(db.admin.query('SELECT fn_seat_slot_assign_no_seat($1, $2, $3)', [staff.manager, aSlot.seat_slot_ref, 'x']),
      /STAFF_FORBIDDEN: paid_no_seat.resolve/);
    await assert.rejects(db.admin.query('SELECT fn_seat_slot_assign_no_seat($1, $2, $3)', [staff.owner, aSlot.seat_slot_ref, 'seat freed']),
      /NO_SEAT_AVAILABLE/);
    await cancelByAmendment(bs[1].seat_slot_ref);
    await db.admin.query('SELECT fn_seat_slot_assign_no_seat($1, $2, $3)', [staff.owner, aSlot.seat_slot_ref, 'seat freed by cancellation']);
    // The no-seat refund settles only with a refund the bank confirmed for that purchase (0022).
    const eSlot = (await slots(e.purchaseRef))[1].seat_slot_ref;
    await assert.rejects(db.pool.query('SELECT fn_seat_slot_refund_settled($1, $2)', [eSlot, 'alfa:refund-1']), /REFUND_NOT_CONFIRMED/);
    const refund = (await db.admin.query('SELECT fn_bank_refund_open($1, $2, $3, $4) AS r', [staff.owner, lateE, adult, 'no seat'])).rows[0].r;
    await assert.rejects(db.pool.query('SELECT fn_seat_slot_refund_settled($1, $2)', [eSlot, refund]), /REFUND_NOT_CONFIRMED/);
    await bankSays(refund, 'SUCCEEDED');
    await db.pool.query('SELECT fn_seat_slot_refund_settled($1, $2)', [eSlot, refund]);
    p = await projection();
    assert.deepEqual([Number(p.confirmed_seats), Number(p.paid_no_seat), Number(p.paid_seat_claims), p.over_quota], [12, 0, 12, false]);
    const events = (await db.owner.query(`SELECT from_state, to_state, actor, bank_operation_ref FROM seat_slot_event e
      JOIN seat_slot s ON s.id = e.seat_slot_id WHERE s.seat_slot_ref = $1 ORDER BY e.id`, [aSlot.seat_slot_ref])).rows
      .map((x) => [x.from_state, x.to_state, x.actor, x.bank_operation_ref]);
    assert.deepEqual(events, [[null, 'HELD', 'checkout', null], ['HELD', 'HELD', 'payment', lateA], ['HELD', 'RELEASED', 'payment', lateA],
      ['RELEASED', 'PAID_NO_SEAT_EXCEPTION', 'payment', lateA], ['PAID_NO_SEAT_EXCEPTION', 'CONFIRMED', 'staff:slots-owner', null]]);
  });
});

describe('review 2: the database, not the caller, decides admission and time', () => {
  test('a direct SQL retry as commerce_app cannot pass a closed switch, a closed departure, T−24 or the retry window', async () => {
    const a = await buy({ tickets: { adults: 2, teens: 0, children: 0 } });
    await fail(a.purchaseRef);
    const rehold = () => db.pool.query('SELECT * FROM fn_purchase_rehold_current($1, $2, $3, $4, $5, $6)', [a.purchaseRef, tokenSha256(sessionOf(a.purchaseRef)), ...legalArgs()]);
    await setSalesOpen(db.operator, false, 'test', 'closed');
    try { await assert.rejects(rehold(), /SALES_CLOSED/); }
    finally { await setSalesOpen(db.operator, true, 'test', 'reopen'); }
    await db.owner.query("UPDATE departure SET booking_status = 'CLOSED' WHERE id = $1", [departureId]);
    try { await assert.rejects(rehold(), /DEPARTURE_NOT_OPEN/); }
    finally { await db.owner.query("UPDATE departure SET booking_status = 'OPEN' WHERE id = $1", [departureId]); }
    // T−24 by the database clock: the departure moves to tomorrow morning (test-only, triggers suspended).
    const startsOn = (await db.owner.query('SELECT starts_on::text AS d FROM departure WHERE id = $1', [departureId])).rows[0].d;
    await asOwnerWithoutTriggers("UPDATE departure SET starts_on = (clock_timestamp() AT TIME ZONE timezone)::date + 1 WHERE id = $1", [departureId]);
    try {
      const cutoff = (await db.owner.query('SELECT fn_departure_cutoff($1) <= clock_timestamp() AS passed', [departureId])).rows[0].passed;
      if (cutoff) await assert.rejects(rehold(), /BOOKING_CUTOFF_REACHED/);
      await asOwnerWithoutTriggers("UPDATE departure SET starts_on = (clock_timestamp() AT TIME ZONE timezone)::date WHERE id = $1", [departureId]);
      await assert.rejects(rehold(), /BOOKING_CUTOFF_REACHED/);
    } finally { await asOwnerWithoutTriggers('UPDATE departure SET starts_on = $2::date WHERE id = $1', [departureId, startsOn]); }
    await ageRetryWindow(a.purchaseRef);
    await assert.rejects(rehold(), /RETRY_WINDOW_CLOSED/);
    assert.deepEqual(await retryNativePurchasePayment(deps(), a.purchaseRef, sessionOf(a.purchaseRef)), { ok: false, refusal: 'RETRY_WINDOW_CLOSED' });
    // The window is absolute: retries never extend it, and the order then closes.
    assert.equal((await maintain(db.pool, () => undefined)).expired, 1);
    assert.equal(await orderStatus(a.orderRef), 'EXPIRED');
  });

  test('a checkout whose application clock is wrong is still held to the database clock (T−24, quota, five minutes)', async () => {
    // The quota: the application believes the other holds lapsed; the database knows they did not.
    await buy({ tickets: { adults: 12, teens: 0, children: 0 } });
    const farFuture = new Date(Date.now() + 2 * 3_600_000);
    assert.equal(await taken(farFuture), 0);
    assert.deepEqual(await reserveNativePurchase(deps(farFuture), await request()), { ok: false, refusal: 'NOT_ENOUGH_SEATS' });
    await resetOrders(db.owner);
    // The hold's end is the database's, whatever the application's clock says.
    const r = await buy({}, new Date(Date.now() + 3_600_000));
    const h = (await db.owner.query(`SELECT h.expires_at - h.created_at <= interval '5 minutes' AS bounded, h.expires_at > clock_timestamp() AS live
      FROM seat_hold h JOIN purchase p ON p.id = h.purchase_id WHERE p.purchase_ref = $1`, [r.purchaseRef])).rows[0];
    assert.deepEqual(h, { bounded: true, live: true });
    assert.equal(r.reservedUntil.getTime() <= Date.now() + 5 * 60_000 + 1_000, true);
    // T−24: the application's clock says three days earlier; the database refuses after T−24.
    const startsOn = (await db.owner.query('SELECT starts_on::text AS d FROM departure WHERE id = $1', [departureId])).rows[0].d;
    await resetOrders(db.owner);
    await asOwnerWithoutTriggers("UPDATE departure SET starts_on = (clock_timestamp() AT TIME ZONE timezone)::date WHERE id = $1", [departureId]);
    try {
      assert.deepEqual(await reserveNativePurchase(deps(new Date(Date.now() - 3 * 86_400_000)), await request()),
        { ok: false, refusal: 'BOOKING_CUTOFF_REACHED' });
    } finally { await asOwnerWithoutTriggers('UPDATE departure SET starts_on = $2::date WHERE id = $1', [departureId, startsOn]); }
    // No caller time ends a live hold: the lapse function takes none, and maintain(+1 day) keeps it.
    const live = await buy();
    await assert.rejects(db.pool.query("SELECT fn_seat_holds_close_lapsed(now() + interval '1 day')"), /does not exist/);
    await maintain(db.pool, () => undefined, new Date(Date.now() + 86_400_000));
    assert.equal((await slots(live.purchaseRef))[0].state, 'HELD');
    // A hold longer than five minutes is refused for every login, the owner's included.
    const purchaseId = (await db.owner.query('SELECT id FROM purchase WHERE purchase_ref = $1', [live.purchaseRef])).rows[0].id;
    await assert.rejects(db.owner.query(`INSERT INTO seat_hold (hold_ref, purchase_id, cycle, expires_at)
      VALUES ('sh-00000000000000000001', $1, 2, clock_timestamp() + interval '10 minutes')`, [purchaseId]), /HOLD_WINDOW_INVALID/);
  });

  test('a retry and the closure of the unpaid order serialize on the order row, in both orders', async () => {
    // Closure first: the retry waits for it, then sees the closed order.
    const a = await buy();
    await fail(a.purchaseRef);
    await ageRetryWindow(a.purchaseRef);
    const closer = await db.pool.connect();
    try {
      await closer.query('BEGIN');
      assert.equal((await closer.query('SELECT id FROM fn_priced_document_orders_close() AS id')).rows.length, 1);
      let settled = false;
      const retry = db.pool.query('SELECT * FROM fn_purchase_rehold_current($1, $2, $3, $4, $5, $6)', [a.purchaseRef, tokenSha256(sessionOf(a.purchaseRef)), ...legalArgs()]).finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(settled, false, 'the retry waits for the closure');
      await closer.query('COMMIT');
      await assert.rejects(retry, /PURCHASE_CLOSED/);
    } finally { closer.release(); }

    // Retry first: the closure skips the order it holds, then finds an open hold and leaves it open.
    const b = await buy();
    await fail(b.purchaseRef);
    const retrier = await db.pool.connect();
    try {
      await retrier.query('BEGIN');
      await retrier.query('SELECT * FROM fn_purchase_rehold_current($1, $2, $3, $4, $5, $6)', [b.purchaseRef, tokenSha256(sessionOf(b.purchaseRef)), ...legalArgs()]);
      await ageRetryWindow(b.purchaseRef);
      assert.equal((await maintain(db.pool, () => undefined)).expired, 0, 'the closure skips the order the retry holds');
      await retrier.query('COMMIT');
    } finally { retrier.release(); }
    assert.equal((await maintain(db.pool, () => undefined)).expired, 0, 'an open hold keeps the order open');
    assert.equal(await orderStatus(b.orderRef), 'RESERVED');
    assert.deepEqual((await slots(b.purchaseRef)).map((s) => s.state), ['HELD']);
    // Once that hold lapses, the window being over, the order closes: never an open hold on a closed order.
    await lapse(b.purchaseRef);
    assert.equal((await maintain(db.pool, () => undefined)).expired, 1);
    assert.equal(Number((await db.owner.query(`SELECT count(*) AS n FROM seat_hold h JOIN purchase p ON p.id = h.purchase_id
      JOIN orders o ON o.id = p.origin_order_id WHERE h.closed_at IS NULL AND o.status <> 'RESERVED'`)).rows[0].n), 0);
  });

  test('a replay is the same attempt by the same buyer, answered from history after new terms are published', async () => {
    const a = await buy();
    await pay(a.purchaseRef);
    const t = await issueLink(await groupOf(a.purchaseRef));
    const link = { token: t, idempotencyKey: 'attempt-0001' };
    const b = await buy({ groupLink: link });
    for (const buyer of [{ fullName: 'Ольга Другая', phone: '+7 903 907-55-47', email: 'Buyer@Example.ru' },
      { fullName: 'Анна Покупатель', phone: '+7 903 000-00-00', email: 'Buyer@Example.ru' },
      { fullName: 'Анна Покупатель', phone: '+7 903 907-55-47', email: 'other@example.ru' }]) {
      assert.deepEqual(await reserveNativePurchase(deps(), await request({ buyer, groupLink: link })), { ok: false, refusal: 'IDEMPOTENCY_CONFLICT' });
    }
    // New terms published: the old attempt still replays from its accepted history; nothing new is sold on old terms.
    const published = { ...catalog, terms: { ...catalog.terms, ref: 'oferta@2', hash: `sha256:${'1'.repeat(64)}` } };
    const replay = await reserveNativePurchase({ ...deps(), catalog: published }, await request({ groupLink: link }));
    assert.ok(replay.ok && replay.replayed && replay.purchaseRef === b.purchaseRef, JSON.stringify(replay));
    assert.deepEqual(await reserveNativePurchase({ ...deps(), catalog: published }, await request()), { ok: false, refusal: 'TERMS_NOT_CURRENT' });
  });
});

describe('review 3: concurrency of companions and of a double click', () => {
  /** A confirmed adult of purchase A with an open participant, and a confirmed child of a linked purchase B. */
  async function companionScene() {
    const a = await buy({ tickets: { adults: 1, teens: 0, children: 0 } });
    await pay(a.purchaseRef);
    const [adultSlot] = await slots(a.purchaseRef);
    const participant = (await db.pool.query('SELECT fn_seat_participant_open($1) AS r', [adultSlot.seat_slot_ref])).rows[0].r as string;
    const t = await issueLink(await groupOf(a.purchaseRef), { adults: 0, teens: 0, children: 1 });
    const b = await buy({ tickets: { adults: 0, teens: 0, children: 1 }, groupLink: { token: t, idempotencyKey: 'attempt-0001' } });
    await pay(b.purchaseRef);
    const [child] = await slots(b.purchaseRef);
    return { participant, child: child.seat_slot_ref as string };
  }
  const assign = (who: pg.Pool | pg.PoolClient, child: string, participant: string) =>
    who.query('SELECT fn_companion_assign_staff($1, $2, $3, $4) AS r', [staff.manager, child, participant, 'parent of the child']);
  const activeOfEnded = async () => Number((await db.owner.query(`SELECT count(*) AS n FROM companion_assignment a
    JOIN seat_participant p ON p.participant_ref = a.companion_participant_ref WHERE a.revoked_at IS NULL AND p.ended_at IS NOT NULL`)).rows[0].n);

  test('the companion leaves first: the waiting staff assignment then refuses', async () => {
    const { participant, child } = await companionScene();
    const leaver = await db.pool.connect();
    try {
      await leaver.query('BEGIN');
      await leaver.query('SELECT fn_seat_participant_end($1, $2)', [participant, 'WITHDRAWN']);
      let settled = false;
      const assignment = assign(db.admin, child, participant).finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(settled, false, 'the assignment waits for the leaving');
      await leaver.query('COMMIT');
      await assert.rejects(assignment, /COMPANION_INVALID/);
    } finally { leaver.release(); }
    assert.equal(await activeOfEnded(), 0);
  });

  test('the staff assignment runs first: the waiting leaving then revokes it and its invitation', async () => {
    const { participant, child } = await companionScene();
    const admin = await db.admin.connect();
    let companion: string;
    try {
      await admin.query('BEGIN');
      companion = (await assign(admin, child, participant)).rows[0].r;
      let settled = false;
      const leaving = db.pool.query('SELECT fn_seat_participant_end($1, $2)', [participant, 'WITHDRAWN']).finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(settled, false, 'the leaving waits for the assignment');
      await admin.query('COMMIT');
      await leaving;
    } finally { admin.release(); }
    assert.equal(await activeOfEnded(), 0, 'no active assignment of a companion who left');
    const revoked = (await db.owner.query('SELECT revoke_reason FROM companion_assignment WHERE companion_ref = $1', [companion!])).rows[0];
    assert.equal(revoked.revoke_reason, 'COMPANION_PARTICIPANT_ENDED');
    await assert.rejects(db.pool.query('SELECT fn_seat_invitation_issue($1, $2, $3, $4)', [child, 'MINOR_VIA_COMPANION', sha(token()), companion!]),
      /COMPANION_INVALID|INVITATION_PURPOSE_INVALID/);
  });

  test('an invitation of a companion who has left is never live, even if its assignment row were left behind', async () => {
    const { participant, child } = await companionScene();
    const companion = (await assign(db.admin, child, participant)).rows[0].r;
    const t = token();
    const invitation = (await db.pool.query('SELECT fn_seat_invitation_issue($1, $2, $3, $4) AS r',
      [child, 'MINOR_VIA_COMPANION', sha(t), companion])).rows[0].r;
    assert.equal((await db.pool.query('SELECT fn_seat_invitation_live($1) AS ok', [invitation])).rows[0].ok, true);
    // Test-only: end the participant with the cascade suspended, as if a revocation were missed.
    await asOwnerWithoutTriggers("UPDATE seat_participant SET ended_at = clock_timestamp(), end_reason = 'WITHDRAWN' WHERE participant_ref = $1",
      [participant]);
    assert.equal((await db.pool.query('SELECT fn_seat_invitation_live($1) AS ok', [invitation])).rows[0].ok, false);
    assert.equal((await db.pool.query('SELECT * FROM fn_seat_invitation_claimable($1)', [sha(t)])).rows.length, 0);
  });

  test('a double click: both identical requests return the one purchase, its seats created once', async () => {
    const a = await buy();
    await pay(a.purchaseRef);
    for (let round = 0; round < 5; round += 1) {
      const t = await issueLink(await groupOf(a.purchaseRef), { adults: 1, teens: 0, children: 1 });
      const same = await request({ tickets: { adults: 1, teens: 0, children: 1 }, groupLink: { token: t, idempotencyKey: `double-click-${round}` } });
      const [x, y] = await Promise.all([reserveNativePurchase(deps(), same), reserveNativePurchase(deps(), same)]);
      assert.ok(x.ok && y.ok, JSON.stringify([x, y]));
      assert.equal(x.purchaseRef, y.purchaseRef);
      assert.equal(x.orderRef, y.orderRef);
      assert.deepEqual([x.replayed, y.replayed].sort(), [false, true]);
      assert.equal((await slots(x.purchaseRef)).length, 2);
    }
    assert.equal(Number((await db.owner.query('SELECT count(*) AS n FROM purchase')).rows[0].n), 6);
    assert.equal(await taken(), 11);
  });
});

describe('OWNER decisions of 06.11.2026', () => {
  test('8B: the buyer data of a closed unpaid purchase is erased at closure; history, money facts and audit stay', async () => {
    const a = await buy();
    await fail(a.purchaseRef);
    const orderId = (await db.owner.query('SELECT id FROM orders WHERE order_ref = $1', [a.orderRef])).rows[0].id;
    await db.owner.query(`INSERT INTO email_outbox (order_id, type, recipient_email, access_token, idempotency_key, state, next_attempt_at, created_at)
      VALUES ($1, 'BOOKING_CONFIRMATION', 'buyer@example.ru', $2, $3, 'PENDING', now(), now())`, [orderId, 'a'.repeat(43), `slots-${a.orderRef}`]);
    // A purchase whose attempt is UNKNOWN is not closed, so nothing of it is erased.
    const unknown = await buy();
    await fence(unknown.purchaseRef);
    // A purchase under a legal hold closes but keeps its data.
    const held = await buy();
    await fail(held.purchaseRef);
    await db.owner.query("UPDATE orders SET legal_hold = true, legal_hold_reason = 'TEST_HOLD' WHERE order_ref = $1", [held.orderRef]);
    for (const r of [a, unknown, held]) await ageRetryWindow(r.purchaseRef);
    const m = await maintain(db.pool, () => undefined);
    assert.deepEqual([m.expired, m.erased], [2, 1], 'closed and erased in the same run, with no further delay');
    const contact = async (orderRef: string) => Number((await db.owner.query(`SELECT count(*) AS n FROM order_contact c JOIN orders o ON o.id = c.order_id
      WHERE o.order_ref = $1`, [orderRef])).rows[0].n);
    assert.deepEqual([await contact(a.orderRef), await contact(unknown.orderRef), await contact(held.orderRef)], [0, 1, 1]);
    assert.equal((await db.owner.query('SELECT recipient_email FROM email_outbox WHERE order_id = $1', [orderId])).rows[0].recipient_email, null);
    assert.deepEqual([await orderStatus(a.orderRef), await orderStatus(unknown.orderRef), await orderStatus(held.orderRef)],
      ['EXPIRED', 'RESERVED', 'EXPIRED']);
    // What stays: the purchase, its seats and prices, its cycles and attempts, the seat events, the order events.
    const stays = (await db.owner.query(`SELECT (SELECT count(*) FROM seat_slot s WHERE s.purchase_id = p.id) AS seats,
        (SELECT count(*) FROM seat_hold h WHERE h.purchase_id = p.id AND h.attempt_ref IS NOT NULL) AS attempts,
        (SELECT count(*) FROM seat_slot_event e JOIN seat_slot s ON s.id = e.seat_slot_id WHERE s.purchase_id = p.id) AS events,
        (SELECT count(*) FROM purchase_revision_line l WHERE l.purchase_id = p.id) AS lines,
        (SELECT count(*) FROM order_event e WHERE e.order_id = p.origin_order_id AND e.event = 'PD_ERASED') AS erased
      FROM purchase p WHERE p.purchase_ref = $1`, [a.purchaseRef])).rows[0];
    assert.deepEqual(Object.values(stays).map(Number), [1, 1, 3, 1, 1]);
  });

  test('review 4: a late bank success after the purchase closed changes no seat; it goes to manual settlement', async () => {
    const a = await buy();
    const late = await fail(a.purchaseRef);
    await ageRetryWindow(a.purchaseRef);
    const m = await maintain(db.pool, () => undefined);
    assert.deepEqual([m.expired, m.erased], [1, 1]);
    assert.equal(await orderStatus(a.orderRef), 'EXPIRED');
    // The bank now reports the old attempt paid: room exists, but the closed purchase gets no seat.
    const lateMoney = await bankSays(late, 'SUCCEEDED');
    assert.deepEqual([lateMoney.status, lateMoney.seatEffect, lateMoney.settlementCaseRef !== null],
      ['SUCCEEDED', 'PURCHASE_CLOSED_LATE_PAYMENT', true], 'the money is kept as a fact and goes to manual settlement');
    assert.deepEqual((await slots(a.purchaseRef)).map((x) => x.state), ['RELEASED']);
    assert.equal((await projection()).paid_seat_claims, '0');
    // Within the window (the order still open) a late success is still decided by the database.
    const b = await buy();
    const lateB = await fail(b.purchaseRef);
    assert.deepEqual(await confirmed(b.purchaseRef, lateB), { confirmed: 1, no_seat: 0 });
  });

  test('2: no new attempt after the departure or the legal terms changed; an attempt already registered still completes', async () => {
    const a = await buy();
    await fail(a.purchaseRef);
    const b = await buy();
    const registered: string = (await fence(b.purchaseRef)).rows[0].att;
    // The organizer publishes a new revision of the departure (test-only: copy of the current one).
    await asOwnerWithoutTriggers(`INSERT INTO departure_revision (departure_id, version, draft_revision, document, document_sha256, published_by, login_role, published_at)
      SELECT r.departure_id, r.version + 1, r.draft_revision, r.document, r.document_sha256, r.published_by, r.login_role, now()
        FROM departure_revision r JOIN departure d ON d.id = r.departure_id AND r.version = d.published_version WHERE d.id = $1`, [departureId]);
    await asOwnerWithoutTriggers('UPDATE departure SET published_version = published_version + 1 WHERE id = $1', [departureId]);
    assert.deepEqual(await retryNativePurchasePayment(deps(), a.purchaseRef, sessionOf(a.purchaseRef)), { ok: false, refusal: 'DEPARTURE_CHANGED' });
    await assert.rejects(db.pool.query('SELECT * FROM fn_purchase_rehold_current($1, $2, $3, $4, $5, $6)', [a.purchaseRef, tokenSha256(sessionOf(a.purchaseRef)), ...legalArgs()]), /DEPARTURE_CHANGED/);
    // The attempt registered before the change completes on the terms it was registered under.
    assert.deepEqual(await confirmed(b.purchaseRef, registered), { confirmed: 1, no_seat: 0 });
    // New legal terms published: a purchase accepted under the old offer cannot start a new attempt.
    const c = await buy();
    await fail(c.purchaseRef);
    const published = { ...catalog, terms: { ...catalog.terms, ref: 'oferta@2', hash: `sha256:${'2'.repeat(64)}` } };
    assert.deepEqual(await retryNativePurchasePayment({ ...deps(), catalog: published }, c.purchaseRef, sessionOf(c.purchaseRef)), { ok: false, refusal: 'LEGAL_TERMS_CHANGED' });
    const consent = { ...catalog, pdConsent: { ...catalog.pdConsent, hash: `sha256:${'3'.repeat(64)}` } };
    assert.deepEqual(await retryNativePurchasePayment({ ...deps(), catalog: consent }, c.purchaseRef, sessionOf(c.purchaseRef)), { ok: false, refusal: 'LEGAL_TERMS_CHANGED' });
    assert.equal((await retryNativePurchasePayment(deps(), c.purchaseRef, sessionOf(c.purchaseRef))).ok, true);
  });
});

describe('companions and invitations (v1.9.0 §3, G-GROUP-02/03 at the database)', () => {
  test('in-purchase companions by the buyer; across purchases only by staff; leaving revokes access at once', async () => {
    const a = await buy({ tickets: { adults: 2, teens: 1, children: 0 } });
    await pay(a.purchaseRef);
    const [a1, a2, teen] = await slots(a.purchaseRef);
    await assert.rejects(db.pool.query('SELECT fn_companion_assign_in_purchase($1, $2)', [teen.seat_slot_ref, teen.seat_slot_ref]), /COMPANION_INVALID|violates check/);
    const inPurchase = (await db.pool.query('SELECT fn_companion_assign_in_purchase($1, $2) AS r', [teen.seat_slot_ref, a1.seat_slot_ref])).rows[0].r;
    await assert.rejects(db.pool.query('SELECT fn_companion_assign_in_purchase($1, $2)', [teen.seat_slot_ref, a2.seat_slot_ref]), /COMPANION_ACTIVE/);
    await db.pool.query('SELECT fn_companion_revoke($1, $2)', [inPurchase, 'reallocated']);

    // A children-only purchase of the group; the adult of purchase A is its companion.
    const link = await issueLink(await groupOf(a.purchaseRef), { adults: 0, teens: 0, children: 1 });
    const b = await buy({ tickets: { adults: 0, teens: 0, children: 1 }, groupLink: { token: link, idempotencyKey: 'attempt-0001' } });
    await pay(b.purchaseRef);
    const [child] = await slots(b.purchaseRef);
    await assert.rejects(db.pool.query('SELECT fn_companion_assign_in_purchase($1, $2)', [child.seat_slot_ref, a1.seat_slot_ref]), /COMPANION_INVALID/);
    const adultParticipant = (await db.pool.query('SELECT fn_seat_participant_open($1) AS r', [a1.seat_slot_ref])).rows[0].r;
    await assert.rejects(db.pool.query('SELECT fn_seat_participant_open($1)', [a1.seat_slot_ref]), /PARTICIPANT_ALREADY_ACTIVE/);
    // Nobody assigns themselves: the service login cannot call the staff command, and EDITOR lacks the right.
    await assert.rejects(db.pool.query('SELECT fn_companion_assign_staff($1, $2, $3, $4)', [staff.manager, child.seat_slot_ref, adultParticipant, 'x']),
      /permission denied/);
    await assert.rejects(db.admin.query('SELECT fn_companion_assign_staff($1, $2, $3, $4)', [staff.editor, child.seat_slot_ref, adultParticipant, 'x']),
      /STAFF_FORBIDDEN/);
    const companion = (await db.admin.query('SELECT fn_companion_assign_staff($1, $2, $3, $4) AS r',
      [staff.manager, child.seat_slot_ref, adultParticipant, 'parent travels in purchase A'])).rows[0].r;
    await db.pool.query('SELECT fn_companion_confirm($1, $2)', [companion, adultParticipant]);
    await assert.rejects(db.pool.query('SELECT fn_companion_revoke($1, $2)', [companion, 'buyer tries']), /COMPANION_NOT_ACTIVE/);
    const t = token();
    const invitation = (await db.pool.query('SELECT fn_seat_invitation_issue($1, $2, $3, $4) AS r',
      [child.seat_slot_ref, 'MINOR_VIA_COMPANION', sha(t), companion])).rows[0].r;
    assert.equal((await db.pool.query('SELECT * FROM fn_seat_invitation_claimable($1)', [sha(t)])).rows.length, 1);
    await db.pool.query('SELECT fn_seat_invitation_claim($1)', [sha(t)]);
    const live = async () => (await db.pool.query('SELECT fn_seat_invitation_live($1) AS ok', [invitation])).rows[0].ok;
    assert.equal(await live(), true);

    // The companion's seat is cancelled (a TOUR-79 amendment): assignment, invitation and participant end in the same transaction.
    await cancelByAmendment(a1.seat_slot_ref);
    assert.equal(await live(), false);
    const state = (await db.owner.query(`SELECT a.revoke_reason, i.revoke_reason AS invitation, p.end_reason FROM companion_assignment a
      JOIN seat_invitation i ON i.companion_assignment_id = a.id JOIN seat_participant p ON p.participant_ref = a.companion_participant_ref
      WHERE a.companion_ref = $1`, [companion])).rows[0];
    assert.deepEqual(state, { revoke_reason: 'COMPANION_SEAT_ENDED', invitation: 'COMPANION_REVOKED', end_reason: 'SLOT_ENDED' });
    // The child's purchase is not cancelled.
    assert.equal((await slots(b.purchaseRef))[0].state, 'CONFIRMED');

    // Reassignment to another adult works across the same group only.
    const other = (await db.pool.query('SELECT fn_seat_participant_open($1) AS r', [a2.seat_slot_ref])).rows[0].r;
    await db.admin.query('SELECT fn_companion_assign_staff($1, $2, $3, $4)', [staff.owner, child.seat_slot_ref, other, 'new companion']);
    const stranger = await buy();
    await pay(stranger.purchaseRef);
    const strangerParticipant = (await db.pool.query('SELECT fn_seat_participant_open($1) AS r', [(await slots(stranger.purchaseRef))[0].seat_slot_ref])).rows[0].r;
    await assert.rejects(db.admin.query('SELECT fn_companion_assign_staff($1, $2, $3, $4)', [staff.owner, child.seat_slot_ref, strangerParticipant, 'x']),
      /COMPANION_INVALID/);
  });

  test('review: invitations open only on confirmed seats; the bearer token is single-use, the claimed invitation lives by its ref', async () => {
    const a = await buy({ tickets: { adults: 1, teens: 1, children: 0 } });
    const [adultSlot, teen] = await slots(a.purchaseRef);
    await assert.rejects(db.pool.query('SELECT fn_seat_invitation_issue($1, $2, $3, $4)', [adultSlot.seat_slot_ref, 'SELF', sha(token()), null]),
      /SEAT_SLOT_NOT_CONFIRMED/);
    await pay(a.purchaseRef);
    await assert.rejects(db.pool.query('SELECT fn_seat_invitation_issue($1, $2, $3, $4)', [teen.seat_slot_ref, 'SELF', sha(token()), null]),
      /INVITATION_PURPOSE_INVALID/);
    const t1 = token();
    const ref = (await db.pool.query('SELECT fn_seat_invitation_issue($1, $2, $3, $4) AS r', [adultSlot.seat_slot_ref, 'SELF', sha(t1), null])).rows[0].r;
    await assert.rejects(db.pool.query('SELECT fn_seat_invitation_issue($1, $2, $3, $4)', [adultSlot.seat_slot_ref, 'SELF', sha(token()), null]),
      /INVITATION_ACTIVE/);
    assert.equal((await db.pool.query('SELECT fn_seat_invitation_claim($1) AS r', [sha(t1)])).rows[0].r, ref);
    // After the claim the token alone finds nothing; the session checks the invitation by its ref.
    assert.equal((await db.pool.query('SELECT * FROM fn_seat_invitation_claimable($1)', [sha(t1)])).rows.length, 0);
    await assert.rejects(db.pool.query('SELECT fn_seat_invitation_claim($1)', [sha(t1)]), /INVITATION_NOT_ACTIVE/);
    assert.equal((await db.pool.query('SELECT fn_seat_invitation_live($1) AS ok', [ref])).rows[0].ok, true);
    await db.pool.query('SELECT fn_seat_invitation_revoke($1, $2)', [ref, 'reissued before submission']);
    assert.equal((await db.pool.query('SELECT fn_seat_invitation_live($1) AS ok', [ref])).rows[0].ok, false);
    await db.pool.query('SELECT fn_seat_invitation_issue($1, $2, $3, $4)', [adultSlot.seat_slot_ref, 'SELF', sha(token()), null]);
    await assert.rejects(db.pool.query('SELECT token_sha256 FROM seat_invitation'), /permission denied/);
  });
});

describe('staff role matrix (contract §7)', () => {
  test('the TypeScript matrix equals the database matrix for every role and permission', async () => {
    for (const role of ROLES) {
      for (const [permission, roles] of Object.entries(PERMISSIONS)) {
        const sql = (await db.owner.query('SELECT fn_staff_role_permits($1, $2) AS ok', [role, permission])).rows[0].ok;
        assert.equal(sql, (roles as readonly Role[]).includes(role), `${role} ${permission}`);
      }
      for (const permission of Object.keys(CAPABILITY_PERMISSIONS)) {
        assert.equal((await db.owner.query('SELECT fn_staff_role_permits($1, $2) AS ok', [role, permission])).rows[0].ok, false);
      }
    }
    // OWNER decisions 3A/4A (06.11.2026).
    assert.deepEqual(PERMISSIONS['minor_sales.pause'], ['OWNER', 'MANAGER']);
    for (const permission of ['minor_sales.resume', 'departure.quota.exception', 'refund.execute', 'paid_no_seat.resolve']) {
      assert.deepEqual(PERMISSIONS[permission as keyof typeof PERMISSIONS], ['OWNER'], permission);
    }
    await assert.rejects(staffPermitted(db.admin, staff.owner, 'no.such' as never), /STAFF_PERMISSION_UNKNOWN/);
  });

  test('review: a staff command and a revocation are serialized on the account row', async () => {
    const group = await groupOf((await buy()).purchaseRef);
    // The revocation commits first: the waiting command then sees it and refuses.
    const operator = await db.adminOperator.connect();
    try {
      await operator.query('BEGIN');
      await operator.query('SELECT fn_admin_set_disabled($1, true, $2, $3)', ['slots-manager', 'test', 'disabled mid-request']);
      let settled = false;
      const command = issueLink(group).finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(settled, false, 'the command waits for the revocation');
      await operator.query('COMMIT');
      await assert.rejects(command, /STAFF_FORBIDDEN/);
    } finally { operator.release(); }
    await setDisabled(db.adminOperator, 'slots-manager', false, 'test', 'back');
    // The command runs first: the revocation waits for it, so nothing commits after it under a revoked right.
    const admin = await db.admin.connect();
    try {
      await admin.query('BEGIN');
      await admin.query('SELECT fn_group_link_issue($1, $2, $3, 1, 0, 0)', [staff.manager, group, sha(token())]);
      let revoked = false;
      const revocation = setDisabled(db.adminOperator, 'slots-manager', true, 'test', 'disabled').then(() => { revoked = true; });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(revoked, false, 'the revocation waits for the running command');
      await admin.query('COMMIT');
      await revocation;
    } finally { admin.release(); }
    await assert.rejects(issueLink(group), /STAFF_FORBIDDEN/);
    await setDisabled(db.adminOperator, 'slots-manager', false, 'test', 'back');
  });

  test('documents.* follow the moderator cabinet grant only; revocation and disabling end them at once', async () => {
    for (const id of [staff.owner, staff.manager, staff.editor]) {
      assert.equal(await staffPermitted(db.admin, id, 'documents.verify'), false);
    }
    await grantCapability(db.adminOperator, 'slots-editor', 'MODERATOR_CABINET', 'test', 'joins the moderator cabinet');
    await assert.rejects(grantCapability(db.adminOperator, 'slots-editor', 'MODERATOR_CABINET', 'test', 'twice'), /STAFF_GRANT_ACTIVE/);
    assert.equal(await staffPermitted(db.admin, staff.editor, 'documents.read'), true);
    assert.equal(await staffPermitted(db.admin, staff.editor, 'documents.verify'), true);
    // documents.verify gives no legal hold, PD correction or money.
    assert.equal(await staffPermitted(db.admin, staff.editor, 'legal_hold.manage'), false);
    assert.equal(await staffPermitted(db.admin, staff.editor, 'participants.pd.correct'), false);
    assert.equal(await staffPermitted(db.admin, staff.editor, 'refund.execute'), false);
    assert.equal(await revokeCapability(db.adminOperator, 'slots-editor', 'MODERATOR_CABINET', 'test', 'left the cabinet'), true);
    assert.equal(await staffPermitted(db.admin, staff.editor, 'documents.read'), false);
    assert.equal(await staffPermitted(db.admin, staff.editor, 'documents.verify'), false);
    await grantCapability(db.adminOperator, 'slots-owner', 'LEGAL_HOLD', 'test', 'legal hold authority');
    assert.equal(await staffPermitted(db.admin, staff.owner, 'legal_hold.manage'), true);
    assert.equal(await staffPermitted(db.admin, staff.owner, 'documents.verify'), false);
    await setDisabled(db.adminOperator, 'slots-owner', true, 'test', 'left the company');
    assert.equal(await staffPermitted(db.admin, staff.owner, 'legal_hold.manage'), false);
    assert.equal(await staffPermitted(db.admin, staff.owner, 'editorial.publish'), false);
    await setDisabled(db.adminOperator, 'slots-owner', false, 'test', 'back');
    // Grant history: no edits, no deletes; the services cannot grant.
    await assert.rejects(db.owner.query("UPDATE admin_capability_grant SET grant_reason = 'x'"), /STAFF_GRANT_HISTORY_IMMUTABLE/);
    await assert.rejects(db.owner.query('DELETE FROM admin_capability_grant'), /STAFF_GRANT_HISTORY_IMMUTABLE/);
    await assert.rejects(db.admin.query('SELECT fn_admin_grant_capability($1, $2, $3, $4)', ['slots-editor', 'MODERATOR_CABINET', 'x', 'y']),
      /permission denied|ADMIN_OPERATOR_SERVICE_LOGIN/);
    assert.equal(Number((await db.owner.query("SELECT count(*) AS n FROM admin_audit WHERE action LIKE 'CAPABILITY.%'")).rows[0].n), 3);
  });
});

describe('append-only history', () => {
  test('pricing bases, lines, holds, events, groups and links are not rewritten, deleted or truncated', async () => {
    const a = await buy();
    await assert.rejects(db.owner.query('UPDATE pricing_basis SET adult_price_kopecks = 1'), /PURCHASE_HISTORY_IMMUTABLE/);
    await assert.rejects(db.owner.query('DELETE FROM purchase_revision_line'), /PURCHASE_HISTORY_IMMUTABLE/);
    await assert.rejects(db.owner.query('UPDATE seat_slot_event SET actor = $1', ['x']), /PURCHASE_HISTORY_IMMUTABLE/);
    await assert.rejects(db.owner.query('DELETE FROM purchase_group_member'), /PURCHASE_HISTORY_IMMUTABLE/);
    await assert.rejects(db.owner.query("UPDATE seat_hold SET expires_at = now() + interval '1 day'"), /SEAT_HOLD_HISTORY_IMMUTABLE/);
    await assert.rejects(db.owner.query('DELETE FROM seat_hold'), /SEAT_HOLD_HISTORY_IMMUTABLE/);
    for (const t of ['seat_slot', 'seat_hold', 'pricing_basis', 'purchase_revision_line', 'purchase_group', 'purchase_group_link', 'seat_invitation']) {
      await assert.rejects(db.owner.query(`TRUNCATE ${t} CASCADE`), /PURCHASE_HISTORY_IMMUTABLE|GROUP_LINK_HISTORY_IMMUTABLE/);
    }
    // No slot, hold cycle or group membership can be added to an existing purchase outside its rules.
    const p = (await db.owner.query('SELECT p.id, s.pricing_basis_id FROM purchase p JOIN seat_slot s ON s.purchase_id = p.id WHERE p.purchase_ref = $1',
      [a.purchaseRef])).rows[0];
    await assert.rejects(db.owner.query(`INSERT INTO seat_slot (seat_slot_ref, purchase_id, position, pricing_basis_id, state)
      VALUES ('ss-00000000000000000000', $1, 2, $2, 'HELD')`, [p.id, p.pricing_basis_id]), /SEAT_SLOT_CREATION_INVALID/);
    await assert.rejects(db.owner.query(`INSERT INTO seat_hold (hold_ref, purchase_id, cycle, expires_at)
      VALUES ('sh-00000000000000000000', $1, 2, now() + interval '1 minute')`, [p.id]), /SEAT_HOLD_SEQUENCE|seat_hold_open/);
    const t = await issueLink(await groupOf(a.purchaseRef));
    await buy({ groupLink: { token: t, idempotencyKey: 'attempt-0001' } });
    await assert.rejects(db.owner.query('UPDATE purchase_group_link SET consumed_key_sha256 = $1', [sha('x')]), /GROUP_LINK_HISTORY_IMMUTABLE/);
    await assert.rejects(db.owner.query('UPDATE purchase_group_link SET children = 5'), /GROUP_LINK_HISTORY_IMMUTABLE/);
  });
});
