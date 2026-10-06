import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertProductionContent, bookable, departureContract, loadCatalog, tourContract } from '../src/catalog.js';
import { MIGRATIONS_DIR } from '../src/config.js';
import { fixtureCatalog } from './helpers.js';

const now = new Date('2026-10-06T00:00:00Z');
const fixture = () => fixtureCatalog([{ slug: 'trip', startsOn: '2026-11-01', endsOn: '2026-11-04' }]);

test('a complete OPEN/listed/non-demo departure cannot bypass documented-expense qualification', () => {
  const qualified = fixture();
  assert.equal(typeof bookable(qualified, 'trip', now, false), 'object');
  assert.doesNotThrow(() => assertProductionContent(qualified));
  const blocked = { ...qualified, launchReady: true, refundPolicy: 'DOCUMENTED_EXPENSES' as const };
  for (const staging of [true, false]) assert.equal(bookable(blocked, 'trip', now, staging), 'REFUND_WORKFLOW_UNQUALIFIED');
  assert.throws(() => assertProductionContent(blocked), /REFUND_WORKFLOW_UNQUALIFIED/);
});

test('complete departure product replaces defaults; a null/partial override never borrows them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'commerce-override-'));
  cpSync(join(MIGRATIONS_DIR, '..', '..', 'content'), dir, { recursive: true });
  const d = fixture().departures.get('trip')!;
  const raw = { tour: 'altai', startDate: d.startsOn, endDate: d.endsOn, bookingStatus: 'OPEN', price: 26500,
    capacity: 40, isListed: true, isDemo: false };
  const path = join(dir, 'departures', 'trip.yml');
  const product = { ...d.contract!.tour, program: [{ title: 'Другой день', items: 'Другая экскурсия' }],
    included: 'Проезд\nПроживание', excluded: 'Сплав', route: 'Другой маршрут' };
  for (const override of [product, null, { route: 'Другой маршрут' }]) {
    writeFileSync(path, JSON.stringify({ ...raw, contract: { ...d.contract!.departure, product: override } }));
    const loaded = loadCatalog(dir).departures.get('trip')!;
    if (override === product) {
      assert.equal(loaded.contract?.tour.route, 'Другой маршрут');
      assert.deepEqual(loaded.contract?.tour.program, [{ title: 'Другой день', items: ['Другая экскурсия'] }]);
    } else assert.equal(loaded.contract, null);
  }
});

test('departure requires exact valid times and services never default to included', () => {
  const dc = fixture().departures.get('trip')!.contract!.departure;
  for (const bad of [undefined, '24:00', '06:60', 'morning']) {
    assert.equal(departureContract({ ...dc, departureTime: bad }), null);
    assert.equal(departureContract({ ...dc, returnTime: bad }), null);
  }
  assert.equal(departureContract({ ...dc, services: [{ name: 'Сплав', supplier: 'ИП Исполнитель' }] }), null);
  assert.equal(departureContract({ ...dc, services: [{ name: 'Сплав', supplier: 'ИП Исполнитель', included: false }] })?.services[0]?.included, false);
  assert.equal(tourContract({ destination: 'Алтай', route: 'Река', included: 'Проезд', risks: 'Горы', program: [] }), null);
});

test('the real Altai draft keeps supplied facts, missing conditions and closed launch boundary', () => {
  const catalog = loadCatalog(join(MIGRATIONS_DIR, '..', '..', 'content'));
  const d = catalog.departures.get('altai-1')!;
  assert.equal(catalog.launchReady, false);
  assert.equal(catalog.refundPolicy, 'DOCUMENTED_EXPENSES');
  assert.equal(d.startsOn, '2026-10-29');
  assert.equal(d.endsOn, '2026-11-01');
  assert.equal(d.priceKopecks, 2_650_000);
  assert.equal(d.capacity, 40);
  assert.equal(d.bookingStatus, 'CLOSED');
  assert.equal(d.isListed, false);
  assert.equal(d.contract, null);
});

test('production entrypoint refuses unqualified policy before identity, secrets or database connection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'commerce-unqualified-'));
  cpSync(join(MIGRATIONS_DIR, '..', '..', 'content'), dir, { recursive: true });
  const settings = join(dir, 'site-settings.yml');
  writeFileSync(settings, readFileSync(settings, 'utf8').replace('launchReady: false', 'launchReady: true'));
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/bin/serve.ts'], {
    cwd: join(MIGRATIONS_DIR, '..'), encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, COMMERCE_ENVIRONMENT: 'PRODUCTION', CONTENT_DIR: dir },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /REFUND_WORKFLOW_UNQUALIFIED/);
});

test('omitted or unknown offer refund policy fails closed at catalog load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'commerce-policy-'));
  cpSync(join(MIGRATIONS_DIR, '..', '..', 'content'), dir, { recursive: true });
  const path = join(dir, 'legal', 'oferta.yml');
  const original = readFileSync(path, 'utf8');
  for (const value of ['', 'refundPolicy: QUALIFIED']) {
    writeFileSync(path, original.replace('refundPolicy: DOCUMENTED_EXPENSES', value));
    assert.throws(() => loadCatalog(dir), /CATALOG_INVALID: oferta refundPolicy/);
  }
});
