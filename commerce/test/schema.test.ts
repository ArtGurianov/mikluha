import { loadCatalog, sourceFixtureDir } from './retired/catalog.js';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import pg from 'pg';

import { MIGRATIONS_DIR } from '../src/config.js';
import { migrate, schemaHead } from '../src/migrate.js';
import { readiness } from '../src/server.js';
import { fixtureCatalog, freshDb, type TestDb } from './helpers.js';

let db: TestDb;
before(async () => { db = await freshDb(); });
after(async () => { await db.drop(); });

test('migrations apply once; an applied migration that changed is refused', async () => {
  assert.deepEqual(await migrate(db.owner, MIGRATIONS_DIR), []);
  const dir = mkdtempSync(join(tmpdir(), 'commerce-migrations-'));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  writeFileSync(join(dir, '0001_orders.sql'), '-- rewritten history\n');
  try { await assert.rejects(migrate(db.owner, dir), /MIGRATION_CHANGED/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('0010 upgrades populated schema 9 without rewriting its history and closes organizer visibility', async () => {
  const name = `${db.name}_upgrade`;
  const url = new URL(db.url);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  const dir = mkdtempSync(join(tmpdir(), 'commerce-schema9-'));
  await db.owner.query(`CREATE DATABASE ${name}`);
  try {
    await client.connect();
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    truncateMigrations(dir, 9);
    assert.deepEqual(await migrate(client, dir), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const history = (await client.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
    const tour = (await client.query("SELECT fn_create_tour('upgrade-tour', 'owner') AS id")).rows[0].id;
    await client.query('SELECT fn_save_tour_draft($1, 0, $2, $3)', [tour,
      { slug: 'upgrade-tour', title: 'Алтай', isListed: true, contract: null, content: {} }, 'owner']);
    await client.query('SELECT fn_publish_tour($1, 1, 0, $2)', [tour, 'owner']);
    const org = (await client.query("SELECT fn_create_content_item('organizer', 'upgrade-organizer', 'owner') AS id")).rows[0].id;
    await client.query('SELECT fn_save_content_draft($1, 0, $2, $3)', [org,
      { slug: 'upgrade-organizer', name: 'Артур', isListed: false, isDemo: false, content: {} }, 'owner']);
    await client.query('SELECT fn_publish_content_item($1, 1, 0, $2)', [org, 'owner']);
    const dep = (await client.query("SELECT fn_create_departure($1, 'upgrade-departure', 'owner') AS id", [tour])).rows[0].id;
    await client.query('SELECT fn_save_departure_draft($1, 1, $2, $3)', [dep,
      { slug: 'upgrade-departure', startsOn: '2027-06-01', endsOn: '2027-06-04', departureTime: '06:00', returnTime: '21:00',
        timezone: 'Asia/Krasnoyarsk', priceKopecks: null, contract: null, content: {}, organizers: ['upgrade-organizer'] }, 'owner']);
    await client.query('SELECT fn_publish_departure($1, 2, 0, $2)', [dep, 'owner']);
    await client.query('UPDATE departure SET is_listed = true WHERE id = $1', [dep]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM public_departure')).rows[0].n, 1);
    assert.deepEqual(await migrate(client, MIGRATIONS_DIR), Array.from({ length: schemaHead(MIGRATIONS_DIR) - 9 }, (_, i) => 10 + i));
    assert.deepEqual((await client.query('SELECT * FROM schema_migrations WHERE version <= 9 ORDER BY version')).rows, history);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM public_departure')).rows[0].n, 0);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM departure_revision WHERE departure_id = $1', [dep])).rows[0].n, 1);
    assert.deepEqual(await migrate(client, MIGRATIONS_DIR), []);
  } finally {
    await client.end();
    await db.owner.query(`DROP DATABASE ${name}`);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ready only at exactly this build\'s schema', async () => {
  const deps = { pool: db.pool, catalog: fixtureCatalog([]), sourceCommit: null, startedAt: new Date() };
  assert.equal((await readiness({ ...deps, schemaHead: schemaHead(MIGRATIONS_DIR) })).status, 'READY');
  assert.deepEqual(await readiness({ ...deps, schemaHead: schemaHead(MIGRATIONS_DIR) + 1 }),
    { status: 'NOT_READY', reason: 'SCHEMA_NOT_AT_HEAD', schema: schemaHead(MIGRATIONS_DIR) });
  assert.deepEqual(await readiness({ ...deps, schemaHead: schemaHead(MIGRATIONS_DIR),
    legalAdmission: { verify: async () => { throw new Error('mismatch'); } } }),
  { status: 'NOT_READY', reason: 'LEGAL_RELEASE_NOT_ADMITTED', schema: schemaHead(MIGRATIONS_DIR) });
});

test("the site's own content/ loads, as the image ships it", () => {
  const catalog = loadCatalog(sourceFixtureDir());
  assert.ok(catalog.departures.size > 0);
  for (const d of catalog.departures.values()) assert.match(d.startsOn, /^\d{4}-\d{2}-\d{2}$/);
});

function truncateMigrations(dir: string, head: number) {
  const journal = JSON.parse(readFileSync(join(dir, 'journal.json'), 'utf8')).slice(0, head);
  const lock = JSON.parse(readFileSync(join(dir, 'migration.lock'), 'utf8'));
  lock.migrations = lock.migrations.slice(0, head);
  for (const name of readdirSync(dir)) if (name.endsWith('.sql') && !journal.some((e: { file: string }) => e.file === name)) rmSync(join(dir, name));
  writeFileSync(join(dir, 'journal.json'), JSON.stringify(journal));
  writeFileSync(join(dir, 'migration.lock'), JSON.stringify(lock));
}

test('schema 0001–0007 upgrades without reapplying or changing any existing journal row', async () => {
  const name = `${db.name}_schema7`;
  const url = new URL(db.url); url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  const dir = mkdtempSync(join(tmpdir(), 'commerce-schema7-'));
  await db.owner.query(`CREATE DATABASE ${name}`);
  try {
    await client.connect(); cpSync(MIGRATIONS_DIR, dir, { recursive: true }); truncateMigrations(dir, 7);
    assert.deepEqual(await migrate(client, dir), [1, 2, 3, 4, 5, 6, 7]);
    const before = (await client.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
    assert.deepEqual(await migrate(client, MIGRATIONS_DIR), Array.from({ length: schemaHead(MIGRATIONS_DIR) - 7 }, (_, i) => i + 8));
    assert.deepEqual((await client.query('SELECT * FROM schema_migrations WHERE version <= 7 ORDER BY version')).rows, before);
    assert.deepEqual(await migrate(client, MIGRATIONS_DIR), []);
  } finally {
    await client.end(); await db.owner.query(`DROP DATABASE ${name}`); rmSync(dir, { recursive: true, force: true });
  }
});
