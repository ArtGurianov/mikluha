// Track A / TOUR-76 A2 (migration 0021): priced seat slots without tourist data, purchase groups and
// manager links, occupancy and the 31/30 counters, companions and invitations, the staff role
// matrix and the removal of the limit of six. Real PostgreSQL, production roles
// (docs/plans/2026-11-04-track-a-schema-roles-contract.md §10).
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';

import { CAPABILITY_PERMISSIONS, PERMISSIONS, ROLES, staffPermitted, type Role } from '../src/admin/auth.js';
import { createUser, grantCapability, revokeCapability, setDisabled } from '../src/admin/operator.js';
import type { Catalog } from '../src/catalog.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import { schemaHead } from '../src/migrate.js';
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
let adult: number;
let departureId: string;
const staff: Record<'owner' | 'manager' | 'editor', string> = { owner: '', manager: '', editor: '' };

const deps = (now = new Date()): OrderDeps => ({ pool: db.pool, catalog, log: () => undefined, allowDemo: false, now: () => now });
const request = (over: Partial<NativePurchaseRequest> = {}): NativePurchaseRequest => ({
  departureSlug: SLUG, buyer: { fullName: 'Анна Покупатель', phone: '+7 903 907-55-47', email: 'Buyer@Example.ru' },
  tickets: { adults: 1, teens: 0, children: 0 }, ageTermsConfirmed: true,
  termsRef: catalog.terms.ref, termsHash: catalog.terms.hash,
  pdConsentConfirmed: true, pdConsentRef: catalog.pdConsent.ref, pdConsentHash: catalog.pdConsent.hash, ...over,
});
async function buy(over: Partial<NativePurchaseRequest> = {}, now?: Date) {
  const r = await reserveNativePurchase(deps(now), request(over));
  assert.ok(r.ok, JSON.stringify(r));
  return r as Extract<typeof r, { ok: true }>;
}
const slots = async (purchaseRef: string) => (await db.owner.query(
  'SELECT * FROM seat_slot_current WHERE purchase_ref = $1 ORDER BY position', [purchaseRef])).rows;
let attempts = 0;
const attempt = () => `alfa:attempt-${++attempts}`;
/** TOUR-77's calls, synthetic: record the attempt before registration, then the bank's outcome. */
const fence = (purchaseRef: string, att: string | null) => db.pool.query('SELECT fn_purchase_hold_fence($1, $2) AS r', [purchaseRef, att]);
const confirmed = async (purchaseRef: string, att: string) =>
  (await db.pool.query('SELECT * FROM fn_purchase_payment_confirmed($1, $2)', [purchaseRef, att])).rows[0];
const failed = (purchaseRef: string, att: string) => db.pool.query('SELECT fn_purchase_payment_failed($1, $2) AS n', [purchaseRef, att]);
/** A paid cycle: fence and confirm. Returns the attempt. */
async function pay(purchaseRef: string) {
  const att = attempt();
  await fence(purchaseRef, att);
  assert.equal((await confirmed(purchaseRef, att)).no_seat, 0);
  return att;
}
/** A proven failure of a recorded attempt. Returns the attempt (a late success may follow). */
async function fail(purchaseRef: string) {
  const att = attempt();
  await fence(purchaseRef, att);
  await failed(purchaseRef, att);
  return att;
}
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
const minorSettings = async (allowed: boolean, minAge: number | null = null, childPrice: number | null = CHILD_PRICE, id = departureId) => {
  const v = (await db.owner.query('SELECT minor_settings_version AS v FROM departure WHERE id = $1', [id])).rows[0].v;
  await db.admin.query('SELECT fn_admin_departure_minor_settings($1, $2, $3, $4, $5, $6, $7)',
    [staff.owner, id, v, allowed, minAge, childPrice, 'test settings']);
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
  test('0021 is the head; UNIFORM revisions keep their hashes; seven tourists fit one UNIFORM purchase', async () => {
    assert.equal(schemaHead(MIGRATIONS_DIR), 21);
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
    assert.deepEqual(await reserveNativePurchase(deps(), request()), { ok: false, refusal: 'NOT_ENOUGH_SEATS' });
    for (const tickets of [{ adults: 501, teens: 0, children: 0 }, { adults: 0, teens: 0, children: 0 }, { adults: -1, teens: 2, children: 0 },
      { adults: 1.5, teens: 0, children: 0 }]) {
      assert.deepEqual(await reserveNativePurchase(deps(), request({ tickets })), { ok: false, refusal: 'SEATS_INVALID' });
    }
    assert.deepEqual(await reserveNativePurchase(deps(), request({ ageTermsConfirmed: false })), { ok: false, refusal: 'AGE_TERMS_NOT_CONFIRMED' });
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
    assert.deepEqual(await reserveNativePurchase(deps(), request({ tickets: { adults: 1, teens: 1, children: 0 } })),
      { ok: false, refusal: 'MINORS_NOT_ALLOWED' });
    await buy(); // adults are not affected
    await minorSettings(true, 14);
    assert.deepEqual(await reserveNativePurchase(deps(), request({ tickets: { adults: 1, teens: 0, children: 1 } })),
      { ok: false, refusal: 'TICKET_TYPE_NOT_ALLOWED' });
    await buy({ tickets: { adults: 1, teens: 1, children: 0 } });
    await minorSettings(true, null);
    assert.deepEqual(await reserveNativePurchase(deps(), request({ tickets: { adults: 0, teens: 1, children: 1 } })),
      { ok: false, refusal: 'MINORS_WITHOUT_ADULT' });
    assert.equal(await taken(), 3);
  });

  test('the pause and resume are the owner\'s (PROPOSED for managers); null child price means the adult price', async () => {
    await assert.rejects(pause(staff.manager, true), /STAFF_FORBIDDEN: minor_sales.pause/);
    await assert.rejects(pause(staff.editor, true), /STAFF_FORBIDDEN/);
    await pause(staff.owner, true);
    assert.deepEqual(await reserveNativePurchase(deps(), request({ tickets: { adults: 1, teens: 0, children: 1 } })),
      { ok: false, refusal: 'MINOR_SALES_PAUSED' });
    await assert.rejects(pause(staff.manager, false), /STAFF_FORBIDDEN: minor_sales.resume/);
    await pause(staff.owner, false);
    await minorSettings(true, null, null);
    const r = await buy({ tickets: { adults: 1, teens: 0, children: 1 } });
    assert.equal(r.amountKopecks, 2 * adult);
    const events = (await db.owner.query('SELECT action, actor, version FROM departure_minor_event WHERE departure_id = $1 ORDER BY id', [departureId])).rows;
    assert.deepEqual(events.slice(-3).map((e) => [e.action, e.actor]),
      [['PAUSE', 'staff:slots-owner'], ['RESUME', 'staff:slots-owner'], ['SETTINGS', 'staff:slots-owner']]);
    // The pricing basis names the audited settings version whose child price it froze.
    const basis = (await db.owner.query(`SELECT b.minor_settings_version, b.child_price_kopecks FROM pricing_basis b
      JOIN orders o ON o.id = b.document_order_id WHERE o.order_ref = $1`, [r.orderRef])).rows[0];
    assert.deepEqual([basis.minor_settings_version, basis.child_price_kopecks], [events.at(-1)!.version, null]);
    await assert.rejects(db.admin.query('SELECT fn_admin_minor_sales_pause($1, $2, $3, $4, $5)', [staff.owner, departureId, 0, true, 'stale']),
      /DEPARTURE_MINOR_CONFLICT/);
  });
});

describe('groups and manager links (TOUR-90 / v1.9.0 §2–§3)', () => {
  test('a children-only purchase joins through a link only once the group has a confirmed adult', async () => {
    const a = await buy();
    const group = await groupOf(a.purchaseRef);
    const t = await issueLink(group, { adults: 0, teens: 0, children: 1 });
    const childOnly = { tickets: { adults: 0, teens: 0, children: 1 }, groupLink: { token: t, idempotencyKey: 'attempt-0001' } };
    assert.deepEqual(await reserveNativePurchase(deps(), request(childOnly)), { ok: false, refusal: 'MINORS_WITHOUT_ADULT' });
    // A paid-no-seat exception is no adult either: A's attempt fails, the departure fills, A's bank success comes late.
    const lateA = await fail(a.purchaseRef);
    const full = await buy({ tickets: { adults: 12, teens: 0, children: 0 } });
    await pay(full.purchaseRef);
    assert.deepEqual(await confirmed(a.purchaseRef, lateA), { confirmed: 0, no_seat: 1 });
    const s = await slots(full.purchaseRef);
    await cancelByAmendment(s[0].seat_slot_ref);
    await cancelByAmendment(s[1].seat_slot_ref);
    assert.deepEqual(await reserveNativePurchase(deps(), request(childOnly)), { ok: false, refusal: 'MINORS_WITHOUT_ADULT' });
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
      assert.deepEqual(await reserveNativePurchase(deps(), request({ tickets, groupLink: link })), { ok: false, refusal: 'GROUP_LINK_TICKETS_MISMATCH' });
    }
    const b = await buy({ tickets: { adults: 1, teens: 0, children: 1 }, groupLink: link });
    // Lost response: the same attempt replays, also with sales closed; no new seats are created.
    await setSalesOpen(db.operator, false, 'test', 'closed during the replay');
    try {
      assert.deepEqual(await reserveNativePurchase(deps(), request()), { ok: false, refusal: 'SALES_CLOSED' });
      const again = await buy({ tickets: { adults: 1, teens: 0, children: 1 }, groupLink: link });
      assert.deepEqual([again.replayed, again.purchaseRef, again.orderRef, again.amountKopecks], [true, b.purchaseRef, b.orderRef, b.amountKopecks]);
      // The same key with another request is a conflict, not a replay.
      assert.deepEqual(await reserveNativePurchase(deps(), request({ tickets: { adults: 0, teens: 0, children: 2 }, groupLink: link })),
        { ok: false, refusal: 'IDEMPOTENCY_CONFLICT' });
      assert.deepEqual(await reserveNativePurchase(deps(), request({ departureSlug: OTHER, tickets: { adults: 1, teens: 0, children: 1 }, groupLink: link })),
        { ok: false, refusal: 'IDEMPOTENCY_CONFLICT' });
    } finally { await setSalesOpen(db.operator, true, 'test', 'reopen'); }
    // Another key on the consumed link cannot buy again.
    assert.deepEqual(await reserveNativePurchase(deps(), request({ tickets: { adults: 1, teens: 0, children: 1 },
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
    assert.deepEqual(await reserveNativePurchase(deps(), request({ groupLink: { token: t, idempotencyKey: 'attempt-0001' } })),
      { ok: false, refusal: 'GROUP_LINK_INVALID' });
    assert.deepEqual(await reserveNativePurchase(deps(), request({ groupLink: { token: token(), idempotencyKey: 'attempt-0001' } })),
      { ok: false, refusal: 'GROUP_LINK_INVALID' });
    const other = await issueLink(group);
    assert.deepEqual(await reserveNativePurchase(deps(), request({ departureSlug: OTHER, groupLink: { token: other, idempotencyKey: 'attempt-0003' } })),
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
    assert.match((await fence(b.purchaseRef, 'alfa:reg-1')).rows[0].r, /^sh-[0-9a-f]{20}$/);
    const later = new Date(Date.now() + (SEAT_HOLD_MINUTES + 1) * 60_000);
    assert.equal(await taken(later), 3);
    let m = await maintain(db.pool, () => undefined, later);
    assert.equal(m.expired, 0, 'a lapsed purchase may still start a new payment cycle');
    assert.deepEqual((await slots(a.purchaseRef)).map((s) => s.state), ['RELEASED', 'RELEASED']);
    assert.deepEqual((await slots(b.purchaseRef)).map((s) => s.state), ['HELD', 'HELD', 'HELD']);
    m = await maintain(db.pool, () => undefined, new Date(Date.now() + 25 * 3_600_000));
    assert.equal(m.expired, 1);
    const statuses = (await db.owner.query('SELECT status FROM orders ORDER BY created_at')).rows.map((o) => o.status);
    assert.deepEqual(statuses, ['EXPIRED', 'RESERVED']);
    assert.deepEqual((await retryNativePurchasePayment(deps(), a.purchaseRef)), { ok: false, refusal: 'PURCHASE_CLOSED' });
    await assert.rejects(fence(b.purchaseRef, null), /BANK_OPERATION_REQUIRED/);
  });

  test('review: an expired, unfenced hold is never confirmed after another buyer took the seats', async () => {
    // A's hold lapsed five minutes ago and maintain() has not run yet: its seats are not occupancy.
    const a = await buy({ tickets: { adults: 12, teens: 0, children: 0 } }, new Date(Date.now() - (SEAT_HOLD_MINUTES + 1) * 60_000));
    assert.equal(await taken(), 0);
    const b = await buy({ tickets: { adults: 12, teens: 0, children: 0 } });
    // No attempt can be recorded after the hold lapsed, so no outcome can ever confirm it.
    await assert.rejects(fence(a.purchaseRef, attempt()), /HOLD_EXPIRED/);
    for (const att of ['alfa:attempt-forged', 'alfa:attempt-1']) await assert.rejects(confirmed(a.purchaseRef, att), /ATTEMPT_UNKNOWN/);
    // Not even the owner's DML confirms a seat whose hold did not close PAID.
    await assert.rejects(db.owner.query("UPDATE seat_slot SET state = 'CONFIRMED' WHERE purchase_id = (SELECT id FROM purchase WHERE purchase_ref = $1)",
      [a.purchaseRef]), /SEAT_SLOT_TRANSITION_INVALID/);
    await pay(b.purchaseRef);
    const p = await projection();
    assert.deepEqual([Number(p.taken_seats), Number(p.confirmed_seats), Number(p.paid_seat_claims), p.over_quota], [12, 12, 12, false]);
  });

  test('review: outcomes bind to the recorded attempt; UNKNOWN keeps the seats; no forged release or no-seat', async () => {
    const a = await buy({ tickets: { adults: 2, teens: 0, children: 0 } });
    await assert.rejects(confirmed(a.purchaseRef, 'alfa:never-recorded'), /ATTEMPT_UNKNOWN/);
    await assert.rejects(failed(a.purchaseRef, 'alfa:never-recorded'), /ATTEMPT_UNKNOWN/);
    const att = attempt();
    const hold = (await fence(a.purchaseRef, att)).rows[0].r;
    assert.equal((await fence(a.purchaseRef, att)).rows[0].r, hold, 'recording the same attempt again is idempotent');
    await assert.rejects(fence(a.purchaseRef, attempt()), /HOLD_ALREADY_FENCED/);
    await assert.rejects(failed(a.purchaseRef, 'alfa:other'), /ATTEMPT_UNKNOWN/);
    await assert.rejects(confirmed(a.purchaseRef, 'alfa:other'), /ATTEMPT_UNKNOWN/);
    // UNKNOWN: hours later, maintenance releases nothing; nobody can release or re-attribute the seats.
    await maintain(db.pool, () => undefined, new Date(Date.now() + 2 * 3_600_000));
    assert.deepEqual((await slots(a.purchaseRef)).map((s) => s.state), ['HELD', 'HELD']);
    assert.equal(await taken(new Date(Date.now() + 2 * 3_600_000)), 2);
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
    await assert.rejects(failed(a.purchaseRef, att), /ATTEMPT_UNKNOWN/);
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
    const r = await retryNativePurchasePayment(deps(), a.purchaseRef);
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual((await slots(a.purchaseRef)).map((s) => [s.state, s.hold_ref, Number(s.price_kopecks)]),
      [['HELD', r.holdRef, adult], ['HELD', r.holdRef, adult]]);
    assert.deepEqual(await retryNativePurchasePayment(deps(), a.purchaseRef), { ok: false, refusal: 'REHOLD_NOT_ALLOWED' });
    const second = await pay(a.purchaseRef);
    assert.notEqual(second, first);
    assert.deepEqual((await slots(a.purchaseRef)).map((s) => s.state), ['CONFIRMED', 'CONFIRMED']);
    // The earlier attempt's late success is a double collection: manual reconciliation, no seat change.
    await assert.rejects(confirmed(a.purchaseRef, first), /NEWER_CYCLE_EXISTS/);
    const holds = (await db.owner.query(`SELECT cycle, outcome, attempt_ref FROM seat_hold h JOIN purchase p ON p.id = h.purchase_id
      WHERE p.purchase_ref = $1 ORDER BY cycle`, [a.purchaseRef])).rows;
    assert.deepEqual(holds, [{ cycle: 1, outcome: 'PAYMENT_FAILED', attempt_ref: first }, { cycle: 2, outcome: 'PAID', attempt_ref: second }]);
    assert.equal(Number((await db.owner.query('SELECT count(*) AS n FROM purchase')).rows[0].n), 1);

    // A retry is a new hold under the general rules: the quota, the sales switch, T−24.
    const b = await buy({ tickets: { adults: 2, teens: 0, children: 0 } });
    await fail(b.purchaseRef);
    const c = await buy({ tickets: { adults: 9, teens: 0, children: 0 } });
    assert.deepEqual(await retryNativePurchasePayment(deps(), b.purchaseRef), { ok: false, refusal: 'NOT_ENOUGH_SEATS' });
    await fail(c.purchaseRef);
    await setSalesOpen(db.operator, false, 'test', 'closed');
    try { assert.deepEqual(await retryNativePurchasePayment(deps(), b.purchaseRef), { ok: false, refusal: 'SALES_CLOSED' }); }
    finally { await setSalesOpen(db.operator, true, 'test', 'reopen'); }
    assert.equal((await retryNativePurchasePayment(deps(), b.purchaseRef)).ok, true);
    // A hold that lapsed before any attempt may be retried too.
    const d = await buy();
    await maintain(db.pool, () => undefined, new Date(Date.now() + (SEAT_HOLD_MINUTES + 1) * 60_000));
    assert.equal((await slots(d.purchaseRef))[0].state, 'RELEASED');
    assert.equal((await retryNativePurchasePayment(deps(), d.purchaseRef)).ok, true);
    await assert.rejects(db.pool.query("SELECT fn_purchase_rehold($1, now() + interval '1 hour')", [d.purchaseRef]), /REHOLD_NOT_ALLOWED|HOLD_WINDOW_INVALID/);
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
    await db.pool.query('SELECT fn_seat_slot_refund_settled($1, $2)', [(await slots(e.purchaseRef))[1].seat_slot_ref, 'alfa:refund-1']);
    p = await projection();
    assert.deepEqual([Number(p.confirmed_seats), Number(p.paid_no_seat), Number(p.paid_seat_claims), p.over_quota], [12, 0, 12, false]);
    const events = (await db.owner.query(`SELECT from_state, to_state, actor, bank_operation_ref FROM seat_slot_event e
      JOIN seat_slot s ON s.id = e.seat_slot_id WHERE s.seat_slot_ref = $1 ORDER BY e.id`, [aSlot.seat_slot_ref])).rows
      .map((x) => [x.from_state, x.to_state, x.actor, x.bank_operation_ref]);
    assert.deepEqual(events, [[null, 'HELD', 'checkout', null], ['HELD', 'HELD', 'payment', lateA], ['HELD', 'RELEASED', 'payment', lateA],
      ['RELEASED', 'PAID_NO_SEAT_EXCEPTION', 'payment', lateA], ['PAID_NO_SEAT_EXCEPTION', 'CONFIRMED', 'staff:slots-owner', null]]);
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
    // PROPOSED rows are not yet the manager's (review of 411218c).
    for (const permission of ['minor_sales.pause', 'minor_sales.resume', 'departure.quota.exception', 'refund.execute', 'paid_no_seat.resolve']) {
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
