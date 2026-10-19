// Migration 0009 (ADR v2.3 §2–§4, ART-358): content CRUD, the versioned publish of editable offers,
// classified execution changes with per-order notices, the fail-closed public projection and the
// editorial audit. Admin calls run as the admin_app login, the site's reads as commerce_app, and the
// owner login stands for direct database credentials.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import type { Bookable, Catalog } from '../src/catalog.js';
import { buildContractSnapshot, contractSnapshotHash, contractSnapshotIntact } from '../src/contract-snapshot.js';
import {
  affectedOrders, changeNotices, createContentItem, createDeparture, createTour, EditorialError, publishContentItem,
  publishDeparture, publishTour, saveContentDraft, saveDepartureDraft, saveTourDraft, type Document,
} from '../src/editorial.js';
import type { SendResult } from '../src/email.js';
import { processExecutionNotices, recordNoticeDelivery, type NoticeSender } from '../src/execution-notice.js';
import { publicDeparture, publicDepartures, publicOrganizers, publicReports, publicReviews, publicTours } from '../src/public-content.js';
import { captureLog, fixtureCatalog, freshDb, type TestDb } from './helpers.js';

let db: TestDb;
let catalog: Catalog;

before(async () => {
  db = await freshDb();
  catalog = fixtureCatalog([{ slug: 'altai-fixture', startsOn: '2027-07-01', endsOn: '2027-07-04' }]);
});
after(async () => { await db.drop(); });

const uniq = (prefix: string) => `${prefix}-${randomBytes(3).toString('hex')}`;
const fixture = () => catalog.departures.get('altai-fixture')!.contract!;
const template = (over: Record<string, unknown> = {}) => ({ ...fixture().tour, ...over }) as unknown as Document;
const facts = (): Document => {
  const { departureTime: _d, returnTime: _r, ...rest } = fixture().departure;
  return rest as unknown as Document;
};

async function tour(opts: { template?: Document | null; listed?: boolean } = {}) {
  const slug = uniq('tour');
  const id = await createTour(db.admin, slug, 'editor');
  await saveTourDraft(db.admin, id, 0, { slug, title: 'Алтай', isListed: opts.listed ?? true,
    contract: opts.template === undefined ? template() : opts.template, content: { summary: 'Тур' } }, 'editor');
  await publishTour(db.admin, id, { draftRevision: 1, publishedVersion: 0 }, 'owner');
  return { id, slug, draft: 1, version: 1 };
}

interface Dep { id: string; slug: string; tourId: string; draft: number; version: number }

const draftOf = async (id: string): Promise<Document> =>
  (await db.owner.query('SELECT document FROM departure_draft WHERE departure_id = $1', [id])).rows[0].document;

/** A departure created from its tour, its draft filled in and, by default, published. */
async function departure(opts: { tourId?: string; publish?: boolean; over?: Document } = {}): Promise<Dep> {
  const tourId = opts.tourId ?? (await tour()).id;
  const slug = uniq('altai');
  const id = await createDeparture(db.admin, tourId, slug, 'editor');
  const seeded = await draftOf(id);
  const contract = seeded.contract === null ? null : { ...(seeded.contract as Document), departure: facts() };
  await saveDepartureDraft(db.admin, id, 1, { ...seeded, startsOn: '2027-06-01', endsOn: '2027-06-04', departureTime: '06:00',
    returnTime: '21:00', timezone: 'Asia/Krasnoyarsk', priceKopecks: 3_400_000, contract,
    content: { description: 'Четыре дня на озере' }, ...opts.over }, 'editor');
  const d = { id, slug, tourId, draft: 2, version: 0 };
  if (opts.publish ?? true) await edit(d, {});
  return d;
}

/** Save `over` on top of the current draft and publish it as an ordinary edit. */
async function edit(d: Dep, over: Document, change?: Parameters<typeof publishDeparture>[4]) {
  if (Object.keys(over).length > 0) {
    d.draft = await saveDepartureDraft(db.admin, d.id, d.draft, { ...await draftOf(d.id), ...over }, 'editor');
  }
  const r = await publishDeparture(db.admin, d.id, { draftRevision: d.draft, publishedVersion: d.version }, 'owner', change);
  d.version = r.version;
  return r;
}

/** Sales open and the departure listed: ART-366's transitions, done here directly by the owner. */
const openForSale = (d: Dep) => db.owner.query(`UPDATE departure SET booking_status = 'OPEN', is_listed = true WHERE id = $1`, [d.id]);

/** An order of a database departure as reserve() would write it, with its contact. */
async function order(d: Dep, opts: { reservedUntil?: Date; contact?: boolean } = {}): Promise<{ id: string; ref: string }> {
  const pub = (await publicDeparture(db.owner as never, d.slug)) ?? await (async () => {
    await db.owner.query('UPDATE departure SET is_listed = true WHERE id = $1', [d.id]);
    return (await publicDeparture(db.owner as never, d.slug))!;
  })();
  const snapshot = buildContractSnapshot(pub as Bookable, pub.timezone);
  const ref = `mk-${randomBytes(6).toString('hex')}`;
  const { rows } = await db.owner.query(`INSERT INTO orders (order_ref, departure_id, departure_slug, trip_starts_on, trip_ends_on, seats,
      unit_price_kopecks, amount_kopecks, status, reserved_until, legal_release_ref, legal_release_hash, legal_release_content,
      pd_consent_ref, pd_consent_hash, pd_consent_content, pd_consent_accepted_at, adults_only_confirmed, trip_departure_time,
      trip_return_time, trip_timezone, contract_snapshot, contract_snapshot_sha256)
    VALUES ($1, $2, $3, $4, $5, 1, $6, $6, 'RESERVED', $7, 'oferta@2026-10-04', $8, 'offer', 'soglasie-pd@2026-10-04', $8, 'consent',
      now(), true, $9, $10, $11, $12, $13) RETURNING id`,
  [ref, d.id, d.slug, pub.startsOn, pub.endsOn, pub.priceKopecks, opts.reservedUntil ?? new Date(Date.now() + 30 * 60_000),
    `sha256:${'a'.repeat(64)}`, pub.departureTime, pub.returnTime, pub.timezone, snapshot,
    contractSnapshotHash(snapshot)]);
  if (opts.contact ?? true) {
    await db.owner.query(`INSERT INTO order_contact (order_id, full_name, phone, email) VALUES ($1, 'Иван Петров', '+79039075547', $2)`,
      [rows[0].id, `${ref}@example.ru`]);
  }
  return { id: rows[0].id, ref };
}

const snapshotText = async (ref: string) =>
  (await db.owner.query('SELECT contract_snapshot::text AS s, contract_snapshot_sha256 AS h, contract_snapshot AS j FROM orders WHERE order_ref = $1', [ref])).rows[0];

const newProgramme = () => ({ ...(fixture().tour as unknown as Document),
  program: [{ title: 'День 1. Телецкое озеро', items: ['Теплоход заменён катером того же класса'] }] });

const refused = (code: string) => (e: unknown) => e instanceof EditorialError && e.code === code;

describe('a new database', () => {
  test('holds no content: nothing is imported from content/ YAML', async () => {
    const fresh = await freshDb();
    try {
      const { rows } = await fresh.owner.query(`SELECT (SELECT count(*) FROM tour) + (SELECT count(*) FROM departure)
        + (SELECT count(*) FROM content_item) + (SELECT count(*) FROM editorial_audit) AS n`);
      assert.equal(Number(rows[0].n), 0);
    } finally { await fresh.drop(); }
  });

  test('has no offer clone, offerRevision or departure_contract_version', async () => {
    const { rows } = await db.owner.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
      AND table_name ~ '(offer_?revision|contract_version|clone)'`);
    assert.deepEqual(rows, []);
    const cols = await db.owner.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public'
      AND column_name ~ '(offer_?revision|cloned_from)'`);
    assert.deepEqual(cols.rows, []);
  });
});

describe('roles', () => {
  test('the service reads only the public projection; Admin writes only through the commands', async () => {
    await departure();
    for (const sql of ['SELECT * FROM content_item', 'SELECT * FROM content_item_draft', 'SELECT * FROM editorial_audit',
      'SELECT * FROM departure_draft', "SELECT fn_create_tour('rogue', 'service')"]) {
      await assert.rejects(db.pool.query(sql), /permission denied/, sql);
    }
    assert.ok((await db.pool.query('SELECT * FROM public_departure')).rowCount! >= 0);
    for (const sql of ["INSERT INTO tour (slug) VALUES ('direct')", "INSERT INTO content_item (kind, slug) VALUES ('review', 'x')",
      'UPDATE content_item SET is_listed = true', "UPDATE execution_change_notice SET state = 'DELIVERED'",
      'DELETE FROM editorial_audit', 'SELECT * FROM order_contact']) {
      await assert.rejects(db.admin.query(sql), /permission denied/, sql);
    }
  });
});

describe('templates resolve once', () => {
  test('at creation: later template edits reach only departures created later', async () => {
    const t = await tour({ template: template({ route: 'Маршрут A' }) });
    const first = await departure({ tourId: t.id });
    await saveTourDraft(db.admin, t.id, 1, { slug: t.slug, title: 'Алтай', isListed: true, contract: template({ route: 'Маршрут B' }),
      content: { summary: 'Тур' } }, 'editor');
    await publishTour(db.admin, t.id, { draftRevision: 2, publishedVersion: 1 }, 'owner');
    await edit(first, { priceKopecks: 3_500_000 });
    const second = await departure({ tourId: t.id });
    const route = async (d: Dep) => (await db.owner.query(`SELECT contract #>> '{tour,route}' AS r, template_tour_version AS v
      FROM departure WHERE id = $1`, [d.id])).rows[0];
    assert.deepEqual(await route(first), { r: 'Маршрут A', v: 1 });
    assert.deepEqual(await route(second), { r: 'Маршрут B', v: 2 });
  });

  test('at first publication when the tour had none at creation, whole and never again', async () => {
    const t = await tour({ template: null });
    const d = await departure({ tourId: t.id, publish: false });
    assert.equal((await draftOf(d.id)).contract, null);
    await saveTourDraft(db.admin, t.id, 1, { slug: t.slug, title: 'Алтай', isListed: true, contract: template({ route: 'Поздний шаблон' }),
      content: {} }, 'editor');
    await publishTour(db.admin, t.id, { draftRevision: 2, publishedVersion: 1 }, 'owner');
    const r = await publishDeparture(db.admin, d.id, { draftRevision: 2, publishedVersion: 0 }, 'owner');
    assert.equal(r.outcome, 'PUBLISHED');
    const row = (await db.owner.query('SELECT contract, template_tour_version FROM departure WHERE id = $1', [d.id])).rows[0];
    assert.equal(row.contract.tour.route, 'Поздний шаблон');
    assert.equal(row.contract.departure, null);
    assert.equal(row.template_tour_version, 2);
    // The draft advanced to what was published: the editor's stale revision conflicts, the next one saves.
    await assert.rejects(saveDepartureDraft(db.admin, d.id, 2, await draftOf(d.id), 'tab'), refused('DRAFT_REVISION_CONFLICT'));
    assert.equal((await draftOf(d.id) as { contract: { tour: { route: string } } }).contract.tour.route, 'Поздний шаблон');
    await assert.rejects(db.owner.query('UPDATE departure SET template_tour_version = NULL, template_sha256 = NULL WHERE id = $1', [d.id]),
      /DEPARTURE_TEMPLATE_RESOLVED_ONCE/);
  });

  test('a departure override replaces the template whole; an incomplete tour template is refused', async () => {
    const d = await departure({ over: { contract: { tour: newProgramme(), departure: facts() } } });
    const c = (await db.owner.query('SELECT contract, contract_complete FROM departure WHERE id = $1', [d.id])).rows[0];
    assert.deepEqual(c.contract.tour.program, newProgramme().program);
    assert.equal(c.contract_complete, true);
    const slug = uniq('tour');
    const id = await createTour(db.admin, slug, 'editor');
    await saveTourDraft(db.admin, id, 0, { slug, title: 'Алтай', contract: template({ route: '' }), content: {} }, 'editor');
    await assert.rejects(publishTour(db.admin, id, { draftRevision: 1, publishedVersion: 0 }, 'owner'), refused('TOUR_DOCUMENT_INVALID'));
  });
});

describe('editable offers', () => {
  test('price and description edits with sales open reach the next render and new quotes; orders keep theirs', async () => {
    const d = await departure();
    await openForSale(d);
    const o = await order(d);
    const before = await snapshotText(o.ref);
    // Save draft changes nothing public.
    d.draft = await saveDepartureDraft(db.admin, d.id, d.draft, { ...await draftOf(d.id), priceKopecks: 2_900_000,
      content: { description: 'Новое описание' } }, 'editor');
    assert.equal((await publicDeparture(db.pool, d.slug))!.priceKopecks, 3_400_000);
    const r = await edit(d, {});
    assert.deepEqual([r.outcome, r.affectedOrders], ['PUBLISHED', 0]);
    const page = (await publicDeparture(db.pool, d.slug))!;
    assert.equal(page.priceKopecks, 2_900_000);
    assert.deepEqual(page.content, { description: 'Новое описание' });
    assert.equal(page.publishedVersion, 2);
    const quote = buildContractSnapshot(page as Bookable, page.timezone);
    assert.equal(quote.unitPriceKopecks, 2_900_000);
    const after = await snapshotText(o.ref);
    assert.equal(after.s, before.s);
    assert.equal(after.j.unitPriceKopecks, 3_400_000);
    assert.ok(contractSnapshotIntact(after.j, after.h));
    assert.equal((await db.owner.query('SELECT unit_price_kopecks FROM orders WHERE order_ref = $1', [o.ref])).rows[0].unit_price_kopecks, '3400000');
  });

  test('a stale draft revision or published version is a typed conflict', async () => {
    const d = await departure();
    await assert.rejects(publishDeparture(db.admin, d.id, { draftRevision: d.draft, publishedVersion: 0 }, 'tab'),
      (e: unknown) => e instanceof EditorialError && e.code === 'PUBLISHED_VERSION_CONFLICT' && e.conflict);
    await assert.rejects(saveDepartureDraft(db.admin, d.id, d.draft - 1, await draftOf(d.id), 'tab'),
      (e: unknown) => e instanceof EditorialError && e.code === 'DRAFT_REVISION_CONFLICT' && e.conflict);
    const both = await Promise.allSettled([1, 2].map(() =>
      publishDeparture(db.admin, d.id, { draftRevision: d.draft, publishedVersion: d.version }, 'tab')));
    assert.deepEqual(both.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
    const lost = both.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    assert.equal((lost.reason as EditorialError).code, 'PUBLISHED_VERSION_CONFLICT');
  });

  test('dates lock with an active order; without orders they change', async () => {
    const d = await departure();
    await edit(d, { startsOn: '2027-06-08', endsOn: '2027-06-11' });
    await order(d);
    await assert.rejects(edit(d, { startsOn: '2027-06-15', endsOn: '2027-06-18' }), refused('DEPARTURE_SCHEDULE_LOCKED'));
  });

  test('an open sale cannot be left without a complete offer', async () => {
    const d = await departure();
    await openForSale(d);
    await assert.rejects(edit(d, { priceKopecks: null }), refused('DEPARTURE_OPEN_REQUIRES_COMPLETE_OFFER'));
    await assert.rejects(edit(d, { contract: { tour: fixture().tour as unknown as Document, departure: null } }),
      refused('DEPARTURE_OPEN_REQUIRES_COMPLETE_OFFER'));
    // CLOSED, an incomplete contract publishes as a page that cannot be sold.
    const closed = await departure();
    await edit(closed, { contract: { tour: fixture().tour as unknown as Document, departure: null } });
    await db.owner.query('UPDATE departure SET is_listed = true WHERE id = $1', [closed.id]);
    assert.equal((await publicDeparture(db.pool, closed.slug))!.contract, null);
  });
});

describe('execution changes on a sold departure', () => {
  test('a programme edit demands classification; without orders it is an ordinary edit', async () => {
    const free = await departure();
    await edit(free, { contract: { tour: newProgramme(), departure: facts() } });
    await assert.rejects(edit(free, { content: { description: 'x' } }, { classification: 'EQUIVALENT', notice: 'x' }),
      refused('EXECUTION_CHANGE_NOT_REQUIRED'));
    const d = await departure();
    await order(d);
    await assert.rejects(edit(d, { contract: { tour: newProgramme(), departure: facts() } }), refused('EXECUTION_CHANGE_CLASSIFICATION_REQUIRED'));
    await assert.rejects(db.admin.query('SELECT fn_publish_departure($1, $2, $3, $4)', [d.id, d.draft, d.version, 'owner']),
      /EXECUTION_CHANGE_CLASSIFICATION_REQUIRED/);
    await assert.rejects(edit(d, {}, { classification: 'EQUIVALENT', notice: '  ' }), refused('EXECUTION_CHANGE_NOTICE_INVALID'));
    assert.equal((await db.owner.query('SELECT published_version FROM departure WHERE id = $1', [d.id])).rows[0].published_version, 1);
  });

  test('EQUIVALENT is applied with exactly one notice per affected order; snapshots stay byte-identical', async () => {
    const d = await departure();
    const a = await order(d);
    const b = await order(d);
    const expired = await order(d, { reservedUntil: new Date(Date.now() - 60_000) });
    const before = await snapshotText(a.ref);
    assert.deepEqual((await affectedOrders(db.admin, d.id)).map((x) => x.orderRef).sort(), [a.ref, b.ref].sort());
    d.draft = await saveDepartureDraft(db.admin, d.id, d.draft, { ...await draftOf(d.id),
      contract: { tour: newProgramme(), departure: facts() } }, 'editor');
    const r = await edit(d, {}, { classification: 'EQUIVALENT', notice: 'Теплоход заменён катером того же класса.' });
    assert.deepEqual([r.outcome, r.version, r.affectedOrders], ['APPLIED', 2, 2]);
    const notices = await changeNotices(db.admin, r.changeId!);
    assert.deepEqual(notices.map((n) => n.orderId).sort(), [a.id, b.id].sort());
    assert.ok(notices.every((n) => n.state === 'PENDING'));
    const events = (await db.owner.query(`SELECT o.order_ref FROM order_event e JOIN orders o ON o.id = e.order_id
      WHERE e.event = 'EXECUTION_CHANGE_EQUIVALENT' AND e.detail = $1`, [r.changeId])).rows.map((x) => x.order_ref).sort();
    assert.deepEqual(events, [a.ref, b.ref].sort());
    assert.equal((await snapshotText(a.ref)).s, before.s);
    assert.equal((await snapshotText(expired.ref)).j.contract.tour.program.length, 2);
    await assert.rejects(db.owner.query(`INSERT INTO execution_change_notice (change_id, order_id, idempotency_key, state, next_attempt_at, created_at)
      VALUES ($1, $2, 'again', 'PENDING', now(), now())`, [r.changeId, a.id]), /duplicate key/);
    await assert.rejects(db.owner.query('UPDATE departure_execution_change SET notice = $2 WHERE id = $1', [r.changeId, 'x']),
      /EDITORIAL_HISTORY_IMMUTABLE/);
    assert.equal((await publicDeparture(db.owner as never, d.slug))!.contract!.tour.program[0]!.title, 'День 1. Телецкое озеро');
  });

  test('MATERIAL is recorded for move/cancel and nothing is published', async () => {
    const d = await departure();
    const o = await order(d);
    d.draft = await saveDepartureDraft(db.admin, d.id, d.draft, { ...await draftOf(d.id),
      contract: { tour: newProgramme(), departure: { ...facts(), accommodation: { ...(facts().accommodation as Document), name: 'Палатки' } } } }, 'editor');
    const r = await edit(d, {}, { classification: 'MATERIAL', notice: 'Гостевой дом недоступен: размещение в палатках.' });
    assert.deepEqual([r.outcome, r.version, r.affectedOrders], ['ROUTED_TO_MOVE_CANCEL', 1, 1]);
    const row = (await db.owner.query('SELECT published_version, contract FROM departure WHERE id = $1', [d.id])).rows[0];
    assert.equal(row.published_version, 1);
    assert.equal(row.contract.departure.accommodation.name, 'Гостевой дом «Озеро»');
    const change = (await db.owner.query('SELECT classification, outcome, to_version, affected_order_refs FROM departure_execution_change WHERE id = $1',
      [r.changeId])).rows[0];
    assert.deepEqual(change, { classification: 'MATERIAL', outcome: 'ROUTED_TO_MOVE_CANCEL', to_version: null, affected_order_refs: [o.ref] });
    assert.equal((await db.owner.query('SELECT count(*)::int AS n FROM execution_change_notice WHERE change_id = $1', [r.changeId])).rows[0].n, 0);
    assert.equal((await db.owner.query(`SELECT count(*)::int AS n FROM order_event WHERE event = 'EXECUTION_CHANGE_MATERIAL' AND detail = $1`,
      [r.changeId])).rows[0].n, 1);
  });
});

describe('notice delivery', () => {
  class FakeSender implements NoticeSender {
    readonly sent: string[] = [];
    constructor(private readonly results: SendResult[]) {}
    async sendExecutionNotice(input: { recipient: string; orderRef: string; notice: string; noticeKey: string }): Promise<SendResult> {
      this.sent.push(input.orderRef);
      return this.results.shift() ?? { kind: 'ACCEPTED', jobId: '9001' };
    }
  }

  async function equivalentChange(contacts: boolean[]) {
    const d = await departure();
    const orders = [];
    for (const contact of contacts) orders.push(await order(d, { contact }));
    d.draft = await saveDepartureDraft(db.admin, d.id, d.draft, { ...await draftOf(d.id),
      contract: { tour: newProgramme(), departure: facts() } }, 'editor');
    const r = await edit(d, {}, { classification: 'EQUIVALENT', notice: 'Замена теплохода.' });
    return { orders, changeId: r.changeId! };
  }

  const state = async (changeId: string, orderId: string) => (await db.owner.query(
    'SELECT id, state, attempts, last_error_code, provider_job_id FROM execution_change_notice WHERE change_id = $1 AND order_id = $2',
    [changeId, orderId])).rows[0];

  test('acceptance is not delivery; a delivery report is', async () => {
    const { orders: [o], changeId } = await equivalentChange([true]);
    const { log, lines } = captureLog();
    const sender = new FakeSender([]);
    while (await processExecutionNotices(db.pool, sender, log) > 0) { /* drain other tests' notices too */ }
    const n = await state(changeId, o!.id);
    assert.deepEqual([n.state, n.provider_job_id], ['ACCEPTED', '9001']);
    assert.ok(!lines.join('\n').includes('@example.ru'));
    assert.equal(await recordNoticeDelivery(db.pool, n.id, 'delivered'), true);
    assert.equal((await state(changeId, o!.id)).state, 'DELIVERED');
    assert.equal(await recordNoticeDelivery(db.pool, n.id, 'delivered'), false);
    await assert.rejects(db.owner.query(`UPDATE execution_change_notice SET state = 'PENDING' WHERE id = $1`, [n.id]), /EXECUTION_NOTICE_TRANSITION/);
  });

  test('retried only when provably not sent; never sent twice; an erased contact needs a person', async () => {
    const { orders: [first, second, erased], changeId } = await equivalentChange([true, true, false]);
    const clock = () => new Date(Date.now() + 3_600_000);
    const sender = new FakeSender([{ kind: 'NOT_SENT', code: 'HTTP_429', retryAfterMs: 0 }, { kind: 'AMBIGUOUS', code: 'TIMEOUT' }]);
    const drain = async () => { while (await processExecutionNotices(db.pool, sender, () => undefined, clock) > 0) { /* drain */ } };
    await drain();
    const states = [];
    for (const o of [first, second, erased]) states.push(await state(changeId, o!.id));
    assert.deepEqual(states.map((s) => s.state).sort(), ['ACCEPTED', 'ATTENTION', 'ATTENTION']);
    assert.equal(states[2].last_error_code, 'NO_RECIPIENT');
    const ambiguous = states.find((s) => s.last_error_code === 'TIMEOUT');
    assert.ok(ambiguous);
    const retried = states.find((s) => s.state === 'ACCEPTED');
    assert.equal(retried.attempts, 2);
    const sentBefore = sender.sent.length;
    await drain();
    assert.equal(sender.sent.length, sentBefore);
  });
});

describe('reports, reviews, organizers and legal drafts', () => {
  async function item(kind: 'report' | 'review' | 'organizer' | 'legal', doc: (slug: string) => Document) {
    const slug = uniq(kind);
    const id = await createContentItem(db.admin, kind, slug, 'editor');
    await saveContentDraft(db.admin, id, 0, doc(slug), 'editor');
    return { id, slug };
  }
  const publish = (id: string, draftRevision = 1, publishedVersion = 0) =>
    publishContentItem(db.admin, id, { draftRevision, publishedVersion }, 'owner');

  test('the graph is checked at publish', async () => {
    const draftTour = await createTour(db.admin, uniq('draft-tour'), 'editor');
    const draftSlug = (await db.owner.query('SELECT slug FROM tour WHERE id = $1', [draftTour])).rows[0].slug;
    const r1 = await item('report', (slug) => ({ slug, title: 'Отчёт', tour: draftSlug, departure: null, date: null,
      isListed: true, noindex: false, content: {} }));
    await assert.rejects(publish(r1.id), refused('RELATION_NOT_PUBLISHED'));
    const t1 = await tour();
    const other = await departure();
    const r2 = await item('report', (slug) => ({ slug, title: 'Отчёт', tour: t1.slug, departure: other.slug, date: '2026-06-15',
      isListed: true, noindex: false, content: {} }));
    await assert.rejects(publish(r2.id), refused('RELATION_MISMATCH'));
    const d = await departure({ publish: false });
    const d2 = await departure({ publish: false, over: { organizers: ['nobody-here'] } });
    await assert.rejects(edit(d2, {}), refused('RELATION_NOT_PUBLISHED'));
    const bad = await item('review', (slug) => ({ slug, authorName: 'Олег', tour: null, isListed: true, content: {} }));
    await assert.rejects(publish(bad.id), refused('CONTENT_DOCUMENT_INVALID'));
    await edit(d, {});
  });

  test('legal pages keep drafts and are never published from here', async () => {
    const l = await item('legal', (slug) => ({ slug, title: 'Оферта', content: { text: 'Новая редакция' } }));
    await saveContentDraft(db.admin, l.id, 1, { slug: l.slug, title: 'Оферта', content: { text: 'Ещё правка' } }, 'editor');
    await assert.rejects(publish(l.id, 2), refused('LEGAL_PUBLICATION_NOT_ADMITTED'));
  });

  test('listing is fail-closed and follows the graph', async () => {
    const t = await tour();
    const d = await departure({ tourId: t.id });
    await db.owner.query('UPDATE departure SET is_listed = true WHERE id = $1', [d.id]);
    const org = await item('organizer', (slug) => ({ slug, name: 'Артур', isListed: true, isDemo: false, content: { bio: 'Организатор' } }));
    await publish(org.id);
    await edit(d, { organizers: [org.slug] });
    const report = await item('report', (slug) => ({ slug, title: 'Июнь', tour: t.slug, departure: d.slug, date: '2027-06-01',
      isListed: true, noindex: true, content: {} }));
    await publish(report.id);
    const listed = await item('review', (slug) => ({ slug, authorName: 'Олег', tour: t.slug, isListed: true, isDemo: false, content: {} }));
    await publish(listed.id);
    const hidden = await item('review', (slug) => ({ slug, authorName: 'Яна', tour: t.slug, isListed: false, isDemo: false, content: {} }));
    await publish(hidden.id);
    const unpublished = await item('review', (slug) => ({ slug, authorName: 'Ира', tour: null, isListed: true, isDemo: false, content: {} }));
    const slugs = async () => ({
      reviews: (await publicReviews(db.pool)).map((r) => r.slug), reports: (await publicReports(db.pool)).map((r) => r.slug),
      tours: (await publicTours(db.pool)).map((x) => x.slug), departures: (await publicDepartures(db.pool, t.slug)).map((x) => x.slug),
      organizers: (await publicOrganizers(db.pool)).map((x) => x.slug),
    });
    let s = await slugs();
    assert.ok(s.reviews.includes(listed.slug));
    assert.ok(!s.reviews.includes(hidden.slug) && !s.reviews.includes(unpublished.slug));
    assert.ok(s.reports.includes(report.slug));
    assert.ok(s.organizers.includes(org.slug));
    assert.deepEqual((await publicDeparture(db.pool, d.slug))!.organizers, [org.slug]);
    // Unlisting the tour hides everything that hangs on it.
    await db.admin.query('SELECT fn_save_tour_draft($1, 1, $2, $3)', [t.id, { slug: t.slug, title: 'Алтай', isListed: false,
      contract: template(), content: {} }, 'editor']);
    await publishTour(db.admin, t.id, { draftRevision: 2, publishedVersion: 1 }, 'owner');
    s = await slugs();
    assert.ok(!s.tours.includes(t.slug));
    assert.deepEqual(s.departures, []);
    assert.ok(!s.reviews.includes(listed.slug));
    assert.ok(!s.reports.includes(report.slug));
    assert.equal(await publicDeparture(db.pool, d.slug), null);
    // A tour document without isListed is not listed.
    const quiet = await createTour(db.admin, uniq('quiet'), 'editor');
    const quietSlug = (await db.owner.query('SELECT slug FROM tour WHERE id = $1', [quiet])).rows[0].slug;
    await saveTourDraft(db.admin, quiet, 0, { slug: quietSlug, title: 'Тихий', contract: null, content: {} }, 'editor');
    await publishTour(db.admin, quiet, { draftRevision: 1, publishedVersion: 0 }, 'owner');
    assert.ok(!(await slugs()).tours.includes(quietSlug));
  });

  test('published identity and history are fixed', async () => {
    const org = await item('organizer', (slug) => ({ slug, name: 'Артур', isListed: true, isDemo: false, content: {} }));
    await publish(org.id);
    await saveContentDraft(db.admin, org.id, 1, { slug: uniq('renamed'), name: 'Артур', isListed: true, isDemo: false, content: {} }, 'editor');
    await assert.rejects(publish(org.id, 2, 1), refused('CONTENT_IDENTITY_IMMUTABLE'));
    await assert.rejects(db.owner.query('DELETE FROM content_item WHERE id = $1', [org.id]), /CONTENT_ITEM_PUBLISHED_UNDELETABLE/);
    await assert.rejects(db.owner.query('DELETE FROM content_item_revision WHERE item_id = $1', [org.id]), /EDITORIAL_HISTORY_IMMUTABLE/);
    await assert.rejects(db.owner.query("UPDATE content_item SET kind = 'review' WHERE id = $1", [org.id]), /CONTENT_IDENTITY_IMMUTABLE/);
    await assert.rejects(createContentItem(db.admin, 'organizer', org.slug, 'editor'), refused('SLUG_TAKEN'));
  });
});

describe('audit', () => {
  test('every command is audited with its actor and login; a direct write is audited too; the audit is append-only', async () => {
    const d = await departure();
    const { rows } = await db.owner.query(`SELECT action, actor, login_role, draft_revision, version FROM editorial_audit
      WHERE entity = 'departure' AND entity_id = $1 ORDER BY id`, [d.id]);
    assert.deepEqual(rows.map((r) => [r.action, r.actor, r.login_role, r.draft_revision, r.version]), [
      ['CREATE', 'editor', 'commerce_test_admin', 1, null],
      ['SAVE_DRAFT', 'editor', 'commerce_test_admin', 2, null],
      ['PUBLISH', 'owner', 'commerce_test_admin', 2, 1],
    ]);
    await db.owner.query('UPDATE departure SET is_listed = true WHERE id = $1', [d.id]);
    const direct = (await db.owner.query(`SELECT action, actor, detail FROM editorial_audit WHERE entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [d.id])).rows[0];
    assert.deepEqual(direct, { action: 'DIRECT_WRITE', actor: null, detail: { op: 'UPDATE' } });
    await assert.rejects(db.owner.query('DELETE FROM editorial_audit WHERE entity_id = $1', [d.id]), /EDITORIAL_HISTORY_IMMUTABLE/);
    await assert.rejects(db.owner.query('TRUNCATE editorial_audit'), /EDITORIAL_HISTORY_IMMUTABLE/);
  });
});
