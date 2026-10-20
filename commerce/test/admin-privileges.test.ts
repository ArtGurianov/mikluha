// Migration 0011 with direct database credentials (ART-363): cross-service privilege escalation
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
    await denied(db.pool, 'SELECT * FROM fn_admin_login(gen_random_uuid(), $1, 1, false, $2, now(), 1800, $2)', [ownerId, 'a'.repeat(64)]);
    await denied(db.pool, "SELECT * FROM fn_admin_session_rotate($1, $2, now(), 1800)", ['a'.repeat(64), 'b'.repeat(64)]);
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

  test('a session begins only with a spent TOTP step and names the login that admitted it', async () => {
    const sessionSql = `INSERT INTO admin_session (admin_id, token_mac, created_at, last_seen_at, idle_expires_at, absolute_expires_at, auth_audit_id)
      VALUES ($1, $2, now(), now(), now() + interval '5 minutes', now() + $3::interval, $4)`;
    await denied(db.admin, sessionSql, [ownerId, 'f'.repeat(64), '1 hour', 1]);
    await denied(db.admin, 'SELECT fn_admin_totp_accept($1, 1, false)', [ownerId]);
    const login = (step: number, hash: string) => db.admin.query(
      'SELECT * FROM fn_admin_login(gen_random_uuid(), $1, $2, false, $3, now(), 1800, $3)', [ownerId, step, hash]);
    await denied(db.admin, 'SELECT * FROM fn_admin_login(gen_random_uuid(), $1, 1, false, $2, now(), 1800, $2)', [ownerId, 'f'.repeat(64)], /TOTP_NOT_ENROLLED/);

    await db.owner.query(`INSERT INTO admin_totp (admin_id, seed_ciphertext, last_accepted_step, enrolled_at, confirmed_at)
      VALUES ($1, $2, 10, now(), now())`, [ownerId, encryptSeed(Buffer.alloc(32, 1), ownerId, Buffer.alloc(20, 2))]);
    assert.equal((await login(10, 'a'.repeat(64))).rowCount, 0, 'a spent step opens nothing');
    assert.equal((await login(9, 'a'.repeat(64))).rowCount, 0, 'an earlier step opens nothing');
    const opened = (await login(11, 'e'.repeat(64))).rows[0];
    const auth = (await db.owner.query('SELECT action, outcome, actor, login_role, entity_id, details FROM admin_audit WHERE id = $1',
      [opened.out_auth_audit_id])).rows[0];
    assert.deepEqual(auth, { action: 'AUTH.LOGIN', outcome: 'OK', actor: 'priv-owner', login_role: 'commerce_test_admin',
      entity_id: opened.out_session_id, details: { totpStep: 11, enrolment: false } });
    assert.equal((await login(11, 'b'.repeat(64))).rowCount, 0, 'the same code never opens a second session');

    // Refresh keeps the authentication and the 12-hour limit; the old token is spent.
    const rotated = (await db.admin.query('SELECT * FROM fn_admin_session_rotate($1, $2, now(), 1800)', ['e'.repeat(64), 'd'.repeat(64)])).rows[0];
    assert.equal(rotated.out_auth_audit_id, opened.out_auth_audit_id);
    assert.equal(rotated.out_absolute_expires_at.getTime(), opened.out_absolute_expires_at.getTime());
    assert.equal((await db.admin.query('SELECT * FROM fn_admin_session_rotate($1, $2, now(), 1800)', ['e'.repeat(64), 'c'.repeat(64)])).rowCount, 0);

    // Revoked stays revoked.
    await db.admin.query("UPDATE admin_session SET revoked_at = now(), revoked_reason = 'LOGOUT' WHERE id = $1", [rotated.out_session_id]);
    await denied(db.admin, 'UPDATE admin_session SET revoked_at = NULL, revoked_reason = NULL WHERE id = $1', [rotated.out_session_id], /ADMIN_SESSION_REVOKED/);
    await denied(db.admin, "UPDATE admin_session SET idle_expires_at = now() + interval '5 minutes' WHERE id = $1", [rotated.out_session_id], /ADMIN_SESSION_REVOKED/);
    await denied(db.admin, 'SELECT fn_admin_totp_begin($1, $2)', [ownerId, 'v1.a.b.c'], /TOTP_ALREADY_ENROLLED/);

    // Even the owner's direct writes cannot open a session for an account without a confirmed
    // second factor, or one longer than 12 hours.
    const fresh = await createUser(db.adminOperator, 'priv-fresh', 'EDITOR', 'correct horse battery staple', 'art');
    const row = (await db.owner.query("INSERT INTO admin_audit (actor, action, outcome) VALUES ('owner', 'TEST.LOGIN', 'OK') RETURNING id")).rows[0].id;
    await denied(db.owner as unknown as pg.Pool, sessionSql, [fresh, '9'.repeat(64), '1 hour', row], /ADMIN_SESSION_NOT_ADMISSIBLE/);
    await denied(db.owner as unknown as pg.Pool, sessionSql, [ownerId, '8'.repeat(64), '13 hours', row], /admin_session_check/);
  });

  test('the audit is append-only, and its login is the database\'s word, not the caller\'s', async () => {
    await denied(db.admin, "INSERT INTO admin_audit (actor, action, outcome) VALUES ('api', 'TEST.ENTRY', 'OK')", [], /ADMIN_AUDIT_ATTESTATION_REQUIRED/);
    await db.admin.query("INSERT INTO admin_audit (actor, action, outcome, attestation) VALUES ('api', 'TEST.ENTRY', 'OK', $1)", ['0'.repeat(64)]);
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
    await denied(db.adminOperator, 'SELECT token_mac FROM admin_session');
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
    await denied(both, 'SELECT * FROM fn_admin_login(gen_random_uuid(), $1, 99, false, $2, now(), 1800, $2)', [ownerId, 'c'.repeat(64)], /ADMIN_COMMERCE_LOGIN/);
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
    await denied(db.owner as unknown as pg.Pool, 'TRUNCATE admin_audit', [], /ADMIN_AUDIT_APPEND_ONLY|referenced in a foreign key/);
    await denied(db.owner as unknown as pg.Pool, 'TRUNCATE admin_audit CASCADE', [], /ADMIN_AUDIT_APPEND_ONLY/);
    await denied(db.owner as unknown as pg.Pool, 'UPDATE admin_totp SET last_accepted_step = 0 WHERE admin_id = $1', [ownerId], /ADMIN_TOTP_REPLAY/);
    await denied(db.owner as unknown as pg.Pool, "UPDATE admin_totp SET seed_ciphertext = 'v1.a.b.c' WHERE admin_id = $1", [ownerId], /ADMIN_TOTP_REPLAY/);
  });
});
