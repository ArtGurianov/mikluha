// Migration 0009 with direct database credentials (ART-363): cross-service privilege escalation
// fails in every direction. The public service cannot reach Admin; the Admin API cannot reach orders,
// payments, the booking switch or account management; the operator never sees a secret; and the
// owner's own login cannot rewrite the audit or replay a TOTP step.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import pg from 'pg';

import { assertAdminLogin } from '../src/admin/api.js';
import { createUser } from '../src/admin/operator.js';
import { encryptSeed } from '../src/admin/totp.js';
import { freshDb, type TestDb } from './helpers.js';

let db: TestDb;
let ownerId: string;
const extra: pg.Pool[] = [];

before(async () => {
  db = await freshDb();
  ownerId = await createUser(db.adminOperator, 'priv-owner', 'OWNER', 'correct horse battery staple', 'art');
});
after(async () => {
  await Promise.all(extra.map(p => p.end()));
  await db.drop();
});

/** A login in exactly these roles, as a misconfigured deployment might create it. */
async function loginIn(name: string, ...roles: string[]): Promise<pg.Pool> {
  await db.owner.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN
      CREATE ROLE ${name} LOGIN PASSWORD 'commerce-test-only' IN ROLE ${roles.join(', ')};
    END IF; END $$`);
  const u = new URL(db.url);
  u.username = name;
  u.password = 'commerce-test-only';
  const pool = new pg.Pool({ connectionString: u.toString(), max: 1 });
  extra.push(pool);
  return pool;
}

const denied = async (pool: pg.Pool, sql: string, args: unknown[] = [], pattern: RegExp = /permission denied/) =>
  assert.rejects(pool.query(sql, args), pattern, sql);

describe('the public service (commerce_app) cannot reach Admin', () => {
  test('no account, seed, session or audit row is readable or writable', async () => {
    for (const t of ['admin_user', 'admin_totp', 'admin_session', 'admin_login_throttle', 'admin_audit']) {
      await denied(db.pool, `SELECT * FROM ${t}`);
    }
    await denied(db.pool, "INSERT INTO admin_audit (actor, action, outcome) VALUES ('x', 'FORGED', 'OK')");
    await denied(db.pool, 'SELECT fn_admin_totp_begin($1, $2)', [ownerId, 'v1.a.b.c']);
    await denied(db.pool, 'SELECT fn_admin_totp_accept($1, 1, true)', [ownerId]);
    await denied(db.pool, 'SELECT fn_admin_departure_has_active_orders(gen_random_uuid())');
    await denied(db.pool, "SELECT fn_admin_reset_totp('priv-owner', 'svc', 'takeover')");
    await denied(db.pool, "SELECT fn_admin_create_user('svc', 'OWNER', $1, 'svc')", [`scrypt:v1:16384:8:1:${'A'.repeat(22)}:${'A'.repeat(86)}`]);
  });

  test('it cannot edit editorial, legal or price rows', async () => {
    await denied(db.pool, "INSERT INTO tour (slug) VALUES ('svc-tour')");
    await denied(db.pool, 'UPDATE departure SET price_kopecks = 1');
    await denied(db.pool, "UPDATE tour SET title = 'x'");
    await denied(db.pool, "SELECT fn_save_tour_draft(gen_random_uuid(), 0, '{}', 'svc')");
    await denied(db.pool, 'SELECT fn_publish_departure(gen_random_uuid(), 1, 0, $1)', ['svc']);
    await denied(db.pool, 'UPDATE processing_instruction SET status = status');
  });

  test('the commerce operator cannot manage Admin accounts either', async () => {
    await denied(db.operator, 'SELECT * FROM admin_user');
    await denied(db.operator, "SELECT fn_admin_reset_totp('priv-owner', 'op', 'takeover')");
  });
});

describe('the Admin API (admin_app) cannot reach commerce or manage accounts', () => {
  test('no order, tourist, payment, switch or EIS', async () => {
    for (const t of ['orders', 'order_contact', 'order_passenger', 'order_document', 'order_event', 'email_outbox', 'order_eis',
      'sales_switch', 'sales_switch_event', 'processing_instruction']) await denied(db.admin, `SELECT * FROM ${t}`);
    await denied(db.admin, "SELECT fn_set_sales_open(true, 'admin', 'reopen')");
    await denied(db.admin, 'UPDATE departure SET booking_status = $1', ['OPEN']);
    await denied(db.admin, 'UPDATE departure SET capacity = 99');
  });

  test('no role escalation, no account creation, no TOTP reset, no unchecked TOTP write', async () => {
    await denied(db.admin, "UPDATE admin_user SET role = 'OWNER'");
    await denied(db.admin, 'UPDATE admin_user SET disabled_at = NULL, totp_enrollment_until = now() + interval \'1 year\'');
    await denied(db.admin, "INSERT INTO admin_user (login, role, password_scrypt, password_changed_at) VALUES ('x', 'OWNER', 'x', now())");
    await denied(db.admin, "SELECT fn_admin_create_user('evil', 'OWNER', $1, 'api')", [`scrypt:v1:16384:8:1:${'A'.repeat(22)}:${'A'.repeat(86)}`]);
    await denied(db.admin, "SELECT fn_admin_reset_totp('priv-owner', 'api', 'takeover')");
    await denied(db.admin, "SELECT fn_admin_clear_throttle('api', 'brute force')");
    await denied(db.admin, 'UPDATE admin_totp SET last_accepted_step = 0');
    await denied(db.admin, 'DELETE FROM admin_totp');
    await denied(db.admin, 'DELETE FROM admin_session');
    await denied(db.admin, "UPDATE admin_session SET absolute_expires_at = now() + interval '1 year'");
  });

  test('no session without a confirmed second factor, and revoked stays revoked', async () => {
    const hash = 'f'.repeat(64);
    await denied(db.admin, `INSERT INTO admin_session (admin_id, token_sha256, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
      VALUES ($1, $2, now(), now(), now() + interval '5 minutes', now() + interval '1 hour')`, [ownerId, hash], /ADMIN_SESSION_NOT_ADMISSIBLE/);
    await db.owner.query(`INSERT INTO admin_totp (admin_id, seed_ciphertext, last_accepted_step, enrolled_at, confirmed_at)
      VALUES ($1, $2, 10, now(), now())`, [ownerId, encryptSeed(Buffer.alloc(32, 1), ownerId, Buffer.alloc(20, 2))]);
    await denied(db.admin, `INSERT INTO admin_session (admin_id, token_sha256, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
      VALUES ($1, $2, now(), now(), now() + interval '5 minutes', now() + interval '13 hours')`, [ownerId, hash], /admin_session_check/);
    const id = (await db.admin.query(`INSERT INTO admin_session (admin_id, token_sha256, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
      VALUES ($1, $2, now(), now(), now() + interval '5 minutes', now() + interval '1 hour') RETURNING id`, [ownerId, hash])).rows[0].id;
    await db.admin.query("UPDATE admin_session SET revoked_at = now(), revoked_reason = 'LOGOUT' WHERE id = $1", [id]);
    await denied(db.admin, 'UPDATE admin_session SET revoked_at = NULL, revoked_reason = NULL WHERE id = $1', [id], /ADMIN_SESSION_REVOKED/);
    await denied(db.admin, "UPDATE admin_session SET idle_expires_at = now() + interval '5 minutes' WHERE id = $1", [id], /ADMIN_SESSION_REVOKED/);

    // A spent step is never accepted again, through the API's own function.
    assert.equal((await db.admin.query('SELECT fn_admin_totp_accept($1, 10, false) AS ok', [ownerId])).rows[0].ok, false);
    assert.equal((await db.admin.query('SELECT fn_admin_totp_accept($1, 9, false) AS ok', [ownerId])).rows[0].ok, false);
    assert.equal((await db.admin.query('SELECT fn_admin_totp_accept($1, 11, false) AS ok', [ownerId])).rows[0].ok, true);
    await denied(db.admin, 'SELECT fn_admin_totp_begin($1, $2)', [ownerId, 'v1.a.b.c'], /TOTP_ALREADY_ENROLLED/);
  });

  test('the audit is append-only, and its login is the database\'s word, not the caller\'s', async () => {
    await db.admin.query("INSERT INTO admin_audit (actor, action, outcome) VALUES ('api', 'TEST.ENTRY', 'OK')");
    await denied(db.admin, 'UPDATE admin_audit SET outcome = $1', ['REFUSED']);
    await denied(db.admin, 'DELETE FROM admin_audit');
    await denied(db.admin, "INSERT INTO admin_audit (actor, action, outcome, login_role) VALUES ('api', 'TEST.ENTRY', 'OK', 'owner')");
    const row = (await db.owner.query("SELECT login_role FROM admin_audit WHERE action = 'TEST.ENTRY'")).rows[0];
    assert.equal(row.login_role, 'commerce_test_admin');
  });
});

describe('the admin operator sees state, never secrets', () => {
  test('no password hash, seed or token hash; no commerce data; no publishing', async () => {
    await denied(db.adminOperator, 'SELECT password_scrypt FROM admin_user');
    await denied(db.adminOperator, 'SELECT seed_ciphertext FROM admin_totp');
    await denied(db.adminOperator, 'SELECT token_sha256 FROM admin_session');
    await denied(db.adminOperator, 'SELECT * FROM orders');
    await denied(db.adminOperator, "SELECT fn_publish_tour(gen_random_uuid(), 1, 0, 'op')");
    await denied(db.adminOperator, "SELECT fn_set_sales_open(true, 'op', 'reopen')");
    const r = (await db.adminOperator.query("SELECT login, role FROM admin_user WHERE login = 'priv-owner'")).rows;
    assert.deepEqual(r, [{ login: 'priv-owner', role: 'OWNER' }]);
  });
});

describe('logins that cross services are refused whatever their grants', () => {
  test('an Admin login that is also the service', async () => {
    const both = await loginIn('commerce_test_admin_and_service', 'admin_app', 'commerce_app');
    await denied(both, 'SELECT fn_admin_totp_accept($1, 99, false)', [ownerId], /ADMIN_COMMERCE_LOGIN/);
    await denied(both, 'SELECT fn_admin_departure_has_active_orders(gen_random_uuid())', [], /ADMIN_COMMERCE_LOGIN/);
    await assert.rejects(assertAdminLogin(both), /ADMIN_LOGIN_NOT_ISOLATED/);
    await assert.rejects(assertAdminLogin(db.pool), /ADMIN_LOGIN_NOT_ISOLATED/);
    await assert.rejects(assertAdminLogin(db.adminOperator), /ADMIN_LOGIN_NOT_ISOLATED/);
    await assertAdminLogin(db.admin);
  });

  test('an operator login that is also the Admin API or the service', async () => {
    for (const [name, role] of [['commerce_test_admin_op_api', 'admin_app'], ['commerce_test_admin_op_svc', 'commerce_app']] as const) {
      const both = await loginIn(name, 'admin_operator', role);
      await denied(both, "SELECT fn_admin_reset_totp('priv-owner', 'x', 'takeover')", [], /ADMIN_OPERATOR_SERVICE_LOGIN/);
      await denied(both, "SELECT fn_admin_clear_throttle('x', 'y')", [], /ADMIN_OPERATOR_SERVICE_LOGIN/);
    }
  });
});

describe('the owner\'s own login', () => {
  test('cannot rewrite the audit or move a TOTP step backwards', async () => {
    await denied(db.owner as unknown as pg.Pool, "UPDATE admin_audit SET actor = 'someone else'", [], /ADMIN_AUDIT_APPEND_ONLY/);
    await denied(db.owner as unknown as pg.Pool, 'DELETE FROM admin_audit', [], /ADMIN_AUDIT_APPEND_ONLY/);
    await denied(db.owner as unknown as pg.Pool, 'TRUNCATE admin_audit', [], /ADMIN_AUDIT_APPEND_ONLY/);
    await denied(db.owner as unknown as pg.Pool, 'UPDATE admin_totp SET last_accepted_step = 0 WHERE admin_id = $1', [ownerId], /ADMIN_TOTP_REPLAY/);
    await denied(db.owner as unknown as pg.Pool, "UPDATE admin_totp SET seed_ciphertext = 'v1.a.b.c' WHERE admin_id = $1", [ownerId], /ADMIN_TOTP_REPLAY/);
  });
});
