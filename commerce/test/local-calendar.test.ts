import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS_DIR } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { freshDb, type TestDb } from './helpers.js';

let db: TestDb;
before(async () => { db = await freshDb(); });
after(async () => { await db?.drop(); });

test('local calendar uses Krasnoyarsk midnight across year boundaries and ignores session timezone', async () => {
  for (const zone of ['UTC', 'Europe/Moscow', 'America/Los_Angeles']) {
    await db.owner.query('SELECT set_config($1,$2,false)', ['TimeZone', zone]);
    for (const [at, expected] of [
      ['2026-11-01T16:59:59.999Z', '2026-11-01'],
      ['2026-11-01T17:00:00Z', '2026-11-02'],
      ['2026-12-31T17:00:00Z', '2027-01-01'],
    ]) {
      const r = await db.owner.query('SELECT fn_local_calendar_date($1::timestamptz)::text AS day', [at]);
      assert.equal(r.rows[0].day, expected);
    }
  }
  assert.equal((await db.owner.query('SELECT fn_local_calendar_date(NULL) AS day')).rows[0].day, null);
  assert.equal((await db.owner.query("SELECT provolatile FROM pg_proc WHERE oid='fn_local_calendar_date(timestamptz)'::regprocedure")).rows[0].provolatile, 's');
});

test('the public reader may calculate the date without gaining raw legal payload access', async () => {
  assert.equal((await db.pool.query("SELECT fn_local_calendar_date('2026-11-01T17:00:00Z')::text AS day")).rows[0].day, '2026-11-02');
  await assert.rejects(db.pool.query('SELECT * FROM legal_publication'), /permission denied/);
});

test('publication guard and public visibility consume the same calendar day', async () => {
  // Freeze only the date helper inside this disposable test DB. This exposes a guard/view
  // accidentally retaining an inline Moscow date even when the wall clock is away from midnight.
  const { rows: [dates] } = await db.owner.query("SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Krasnoyarsk')::date)::text AS old, ((clock_timestamp() AT TIME ZONE 'Asia/Krasnoyarsk')::date + 1)::text AS next");
  await db.owner.query(`CREATE OR REPLACE FUNCTION fn_local_calendar_date(p_at timestamptz) RETURNS date LANGUAGE sql STABLE STRICT PARALLEL SAFE SET search_path=pg_catalog,public AS $$ SELECT '${dates.next}'::date $$`);
  const id = (await db.admin.query("SELECT fn_create_content_item('legal','calendar-test','editor') AS id")).rows[0].id;
  await db.admin.query("SELECT fn_save_content_draft($1,0,$2,'editor')", [id, { slug: 'calendar-test', title: 'Synthetic', content: { body: 'Synthetic calendar acceptance' } }]);
  await assert.rejects(db.publisher.query("SELECT fn_admin_publish_legal($1,1,0,$2::date,'test approval','owner')", [id, dates.old]), /LEGAL_EFFECTIVE_IN_PAST/);
  await db.publisher.query("SELECT fn_admin_publish_legal($1,1,0,$2::date,'test approval','owner')", [id, dates.next]);
  assert.equal((await db.pool.query("SELECT version FROM public_legal WHERE slug='calendar-test'")).rows[0].version, 1);
});

test('forward upgrade refuses any prior legal publication without changing its dates or audit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mikluha-calendar-history-'));
  let historical: TestDb | undefined;
  try {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'journal.json'), 'utf8')).filter((r: { version: number }) => r.version <= 19);
    const lock = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'migration.lock'), 'utf8'));
    lock.migrations = lock.migrations.filter((r: { version: number }) => r.version <= 19);
    for (const r of journal) copyFileSync(join(MIGRATIONS_DIR, r.file), join(dir, r.file));
    writeFileSync(join(dir, 'journal.json'), JSON.stringify(journal));
    writeFileSync(join(dir, 'migration.lock'), JSON.stringify(lock));
    const empty = await freshDb(dir);
    try {
      assert.deepEqual(await migrate(empty.owner, MIGRATIONS_DIR), [20]);
      assert.deepEqual(await migrate(empty.owner, MIGRATIONS_DIR), []);
      assert.equal((await empty.owner.query("SELECT count(*)::int AS n FROM legal_publication")).rows[0].n, 0);
    } finally { await empty.drop(); }
    historical = await freshDb(dir);
    const id = (await historical.admin.query("SELECT fn_create_content_item('legal','historical-calendar','editor') AS id")).rows[0].id;
    await historical.admin.query("SELECT fn_save_content_draft($1,0,$2,'editor')", [id, { slug: 'historical-calendar', title: 'Previous calendar', content: { body: 'Unchanged historical text' } }]);
    await historical.publisher.query("SELECT fn_admin_publish_legal($1,1,0,(clock_timestamp() AT TIME ZONE 'Europe/Moscow')::date,'historical approval','owner')", [id]);
    await historical.publisher.query("SELECT fn_admin_publish_legal($1,1,1,(clock_timestamp() AT TIME ZONE 'Europe/Moscow')::date+1,'old future approval','owner')", [id]);
    const snapshot = async () => (await historical!.owner.query("SELECT (SELECT jsonb_agg(to_jsonb(p)) FROM legal_publication p) AS legal, (SELECT jsonb_agg(to_jsonb(a)) FROM editorial_audit a) AS audit")).rows;
    const prior = await snapshot();
    await assert.rejects(migrate(historical.owner, MIGRATIONS_DIR), /LEGAL_CALENDAR_HISTORY_REQUIRES_REVIEW/);
    assert.deepEqual(await snapshot(), prior);
    assert.equal((await historical.owner.query('SELECT max(version) AS head FROM schema_migrations')).rows[0].head, 19);
    assert.equal((await historical.owner.query("SELECT to_regprocedure('fn_local_calendar_date(timestamptz)') AS fn")).rows[0].fn, null);

  } finally {
    await historical?.drop();
    rmSync(dir, { recursive: true, force: true });
  }
});
