// Runs inside the immutable commerce image, against a new disposable PostgreSQL instance only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { readBuildIdentity, PRODUCTION_BUILD_IDENTITY_FILE } from './dist/build-identity.js';
import { readMigrations } from './dist/migration-integrity.js';
import { migrate } from './dist/migrate.js';
import { schemaReadiness } from './dist/schema-readiness.js';

const identity = await readBuildIdentity(PRODUCTION_BUILD_IDENTITY_FILE);
assert.equal(identity.sourceCommit, process.env.EXPECTED_SOURCE_COMMIT, 'IMAGE_SOURCE_MISMATCH');
const migrations = readMigrations('./migrations').map(({ sql: _sql, ...entry }) => entry);
const owner = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
await owner.connect();
try {
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')")).rows[0].n, 0,
    'CLEAN_DATABASE_REQUIRED');
  const applied = await migrate(owner, './migrations');
  assert.deepEqual(applied, migrations.map(m => m.version));
  const history = (await owner.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
  assert.deepEqual(history.map(({ applied_at: _at, ...entry }) => entry), migrations.map(({ compatibility: _c, ...entry }) => entry));
  assert.deepEqual(await migrate(owner, './migrations'), []);
  assert.deepEqual((await owner.query('SELECT * FROM schema_migrations ORDER BY version')).rows, history);

  const roles = ['admin_app', 'admin_operator', 'admin_publisher', 'commerce_app', 'commerce_operator'];
  const roleState = (await owner.query(`SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`, [roles])).rows;
  assert.deepEqual(roleState.map(r => r.rolname), roles);
  for (const r of roleState) for (const [key, value] of Object.entries(r)) if (key !== 'rolname') assert.equal(value, false, `${r.rolname}.${key}`);
  const memberships = (await owner.query(`SELECT parent.rolname AS parent, member.rolname AS member FROM pg_auth_members m
    JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member
    WHERE parent.rolname=ANY($1) OR member.rolname=ANY($1)`, [roles])).rows;
  assert.deepEqual(memberships, [], 'CAPABILITY_ROLES_MUST_BE_DISJOINT');

  const privileges = [];
  for (const [role, table, privilege, allowed] of [
    ['commerce_app', 'orders', 'SELECT', true], ['commerce_app', 'admin_user', 'SELECT', false],
    ['commerce_app', 'departure', 'UPDATE', false], ['commerce_app', 'sales_switch', 'UPDATE', false],
    ['admin_app', 'orders', 'SELECT', false], ['admin_app', 'departure', 'UPDATE', false],
    ['admin_publisher', 'orders', 'SELECT', false], ['admin_operator', 'orders', 'SELECT', false],
    ...roles.flatMap(role => ['schema_migrations', 'schema_migration_compatibility', 'processing_instruction']
      .map(table => [role, table, 'UPDATE', false])),
  ]) {
    const actual = (await owner.query('SELECT has_any_column_privilege($1,$2,$3) AS allowed', [role, `public.${table}`, privilege])).rows[0].allowed;
    assert.equal(actual, allowed, `${role} ${privilege} ${table}`);
    privileges.push({ role, table, privilege, allowed });
  }
  for (const [role, fn, allowed] of [
    ['commerce_operator', 'fn_set_sales_open(boolean,text,text)', true],
    ['commerce_app', 'fn_set_sales_open(boolean,text,text)', false],
    ['admin_app', 'fn_set_sales_open(boolean,text,text)', false],
    ['admin_app', 'fn_publish_departure(uuid,integer,integer,text)', false],
    ['admin_publisher', 'fn_publish_departure(uuid,integer,integer,text)', true],
  ]) {
    assert.equal((await owner.query('SELECT has_function_privilege($1,$2,$3) AS allowed', [role, `public.${fn}`, 'EXECUTE'])).rows[0].allowed, allowed, `${role} ${fn}`);
  }

  const tables = (await owner.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const rowCounts = {};
  const seeds = { schema_migrations: migrations.length, schema_migration_compatibility: migrations.filter(m => m.compatibility).length,
    sales_switch: 1, processing_instruction: 1 };
  for (const { tablename } of tables) {
    const name = `public."${tablename.replaceAll('"', '""')}"`;
    rowCounts[tablename] = (await owner.query(`SELECT count(*)::int AS n FROM ${name}`)).rows[0].n;
    assert.equal(rowCounts[tablename], seeds[tablename] ?? 0, `UNEXPECTED_BOOTSTRAP_DATA ${tablename}`);
  }
  assert.deepEqual((await owner.query('SELECT open FROM sales_switch')).rows, [{ open: false }]);
  assert.deepEqual((await owner.query('SELECT status,signed_at,effective_at,sha256,signed_document_ref FROM processing_instruction')).rows,
    [{ status: 'DRAFT', signed_at: null, effective_at: null, sha256: null, signed_document_ref: null }]);
  const readiness = await schemaReadiness(owner, { schemaHead: migrations.length, migrations, sourceCommit: identity.sourceCommit });
  assert.deepEqual(readiness, { status: 'READY', schema: migrations.length });
  const hash = name => createHash('sha256').update(readFileSync(`./migrations/${name}`)).digest('hex');
  console.log(JSON.stringify({ sourceCommit: identity.sourceCommit, schemaHead: migrations.length, applied, rerunApplied: [],
    journalSha256: hash('journal.json'), lockSha256: hash('migration.lock'), migrations,
    postgresVersion: (await owner.query('SHOW server_version')).rows[0].server_version,
    roles: roleState, memberships, privileges, rowCounts, sales: 'CLOSED', processingInstruction: 'DRAFT', schemaReadiness: readiness,
    checks: ['empty database', 'full checksummed journal', 'idempotent rerun preserves timestamps', 'disjoint NOLOGIN roles',
      'capability privileges', 'no customer/admin/content seed', 'sales closed', 'processing instruction draft', 'schema readiness'] }));
} finally { await owner.end(); }
