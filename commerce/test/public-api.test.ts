// GET /public/v1/catalog (TOUR-60): the projection the SSR site renders, read as commerce_app over
// HTTP. Only published and listed content; a saved draft never shows; never cached, no cookie.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import type { Catalog } from '../src/catalog.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import {
  createDeparture, createTour, publishDeparture, publishTour, saveDepartureDraft, saveTourDraft, type Document,
} from '../src/editorial.js';
import { readMigrations } from '../src/migration-integrity.js';
import { createPublicApiHandler, PUBLIC_CATALOG_PATH, PUBLIC_CATALOG_SCHEMA, type PublicCatalog } from '../src/public-api.js';
import { createCommerceServer } from '../src/server.js';
import { fixtureCatalog, freshDb, type TestDb } from './helpers.js';

let db: TestDb;
let catalog: Catalog;
let server: Server;
let base: string;

before(async () => {
  db = await freshDb();
  catalog = fixtureCatalog([{ slug: 'altai-fixture', startsOn: '2027-07-01', endsOn: '2027-07-04' }]);
  server = createCommerceServer({ pool: db.pool, catalog, schemaHead: readMigrations(MIGRATIONS_DIR).length, sourceCommit: null,
    startedAt: new Date() }, createPublicApiHandler(db.pool));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await db.drop();
});

const uniq = (prefix: string) => `${prefix}-${randomBytes(3).toString('hex')}`;
const contract = () => catalog.departures.get('altai-fixture')!.contract!;

async function publishedDeparture(): Promise<{ tourSlug: string; slug: string; id: string }> {
  const tourSlug = uniq('tour');
  const tourId = await createTour(db.admin, tourSlug, 'editor');
  await saveTourDraft(db.admin, tourId, 0, { slug: tourSlug, title: 'Алтай', isListed: true,
    contract: contract().tour as unknown as Document, content: { shortDescription: 'Четыре дня' } }, 'editor');
  await publishTour(db.publisher, tourId, { draftRevision: 1, publishedVersion: 0 }, 'owner');
  const slug = uniq('altai');
  const id = await createDeparture(db.admin, tourId, slug, 'editor');
  const seeded = (await db.owner.query('SELECT document FROM departure_draft WHERE departure_id = $1', [id])).rows[0].document;
  const { departureTime: _d, returnTime: _r, ...facts } = contract().departure;
  await saveDepartureDraft(db.admin, id, 1, { ...seeded, startsOn: '2027-06-01', endsOn: '2027-06-04', departureTime: '06:00',
    returnTime: '21:00', timezone: 'Asia/Krasnoyarsk', priceKopecks: 3_400_000,
    contract: { ...(seeded.contract as Document), departure: facts as unknown as Document }, content: {} }, 'editor');
  await publishDeparture(db.publisher, id, { draftRevision: 2, publishedVersion: 0 }, 'owner');
  await db.owner.query('UPDATE departure SET is_listed = true WHERE id = $1', [id]);
  return { tourSlug, slug, id };
}

describe('public catalog API', () => {
  test('serves the published projection, uncached and without a cookie', async () => {
    const d = await publishedDeparture();
    const res = await fetch(`${base}${PUBLIC_CATALOG_PATH}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('set-cookie'), null);
    assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
    const body = await res.json() as PublicCatalog;
    assert.equal(body.schema, PUBLIC_CATALOG_SCHEMA);
    assert.ok(body.tours.some((t) => t.slug === d.tourSlug && t.content.shortDescription === 'Четыре дня'));
    const dep = body.departures.find((x) => x.slug === d.slug)!;
    assert.equal(dep.tourSlug, d.tourSlug);
    assert.equal(dep.priceKopecks, 3_400_000);
    assert.equal(dep.contract?.departure.departureTime, '06:00');
    assert.deepEqual(Object.keys(body).sort(), ['departures', 'organizers', 'reports', 'reviews', 'schema', 'tours']);
  });

  test('a saved draft never reaches the catalog until it is published', async () => {
    const d = await publishedDeparture();
    const draft = (await db.owner.query('SELECT document FROM departure_draft WHERE departure_id = $1', [d.id])).rows[0].document;
    await saveDepartureDraft(db.admin, d.id, 2, { ...draft, priceKopecks: 9_900_000 }, 'editor');
    const body = await (await fetch(`${base}${PUBLIC_CATALOG_PATH}`)).json() as PublicCatalog;
    assert.equal(body.departures.find((x) => x.slug === d.slug)!.priceKopecks, 3_400_000);
    await db.owner.query('UPDATE departure SET is_listed = false WHERE id = $1', [d.id]);
    const hidden = await (await fetch(`${base}${PUBLIC_CATALOG_PATH}`)).json() as PublicCatalog;
    assert.ok(!hidden.departures.some((x) => x.slug === d.slug));
  });

  test('only GET; other paths are left to the next handler', async () => {
    const post = await fetch(`${base}${PUBLIC_CATALOG_PATH}`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET');
    assert.equal((await fetch(`${base}/public/v1/catalog/extra`)).status, 404);
  });
});
