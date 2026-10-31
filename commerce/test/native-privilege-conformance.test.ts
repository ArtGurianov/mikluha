// TOUR-37 / TOUR-51 · native conformance: the exact EFFECTIVE privilege surface of a fully migrated
// disposable database, compared with the reviewed snapshot in native-privilege-matrix.json:
//   - per-column SELECT/INSERT/UPDATE/REFERENCES and table DELETE/TRUNCATE/TRIGGER on the money,
//     identity, tourist-data, Admin, legal and media relations (SENSITIVE_RELATIONS);
//   - USAGE/SELECT/UPDATE on every sequence in schema public;
//   - EXECUTE on every SECURITY DEFINER function in schema public, per group role and PUBLIC;
//   - schema public privileges and the roles each group role inherits from.
// Plus catalog-wide PUBLIC invariants over every relation, sequence and SECURITY DEFINER function.
//
// Scope: the schema/catalog of this source tree. Not covered: privileges of ordinary (SECURITY
// INVOKER) functions, which run with the caller's rights and are bounded by the relation grants
// above; relations outside SENSITIVE_RELATIONS beyond the PUBLIC invariants; deployed login
// membership; provider behavior or a qualified banking flow. Synthetic database, no real data.
//
// A migration that changes this surface must update the JSON snapshot in the same reviewed PR.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';

import { freshDb, type TestDb } from './helpers.js';
import { GROUP_ROLES, columnMatrix, surface, type Client } from './native-privilege-surface.js';

const EXPECTED = JSON.parse(readFileSync(new URL('./native-privilege-matrix.json', import.meta.url), 'utf8'));
const TOURIST_DATA = ['order_contact', 'order_passenger', 'order_document'] as const;

let db: TestDb;
before(async () => { db = await freshDb(); });
after(async () => { await db.drop(); });

/** Catalog-wide invariants that hold for every relation, sequence and function, not only the listed ones. */
async function catalogViolations(c: Client): Promise<string[]> {
  const rows = async (sql: string) => (await c.query(sql)).rows.map((r) => Object.values(r).join(' '));
  return [
    ...(await rows(`SELECT 'PUBLIC_RELATION_PRIVILEGE ' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p','f')
        AND (has_any_column_privilege('public', c.oid, 'SELECT') OR has_any_column_privilege('public', c.oid, 'INSERT')
          OR has_any_column_privilege('public', c.oid, 'UPDATE') OR has_any_column_privilege('public', c.oid, 'REFERENCES')
          OR has_table_privilege('public', c.oid, 'DELETE') OR has_table_privilege('public', c.oid, 'TRUNCATE')
          OR has_table_privilege('public', c.oid, 'TRIGGER')) ORDER BY 1`)),
    ...(await rows(`SELECT 'PUBLIC_SEQUENCE_PRIVILEGE ' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'S' AND (has_sequence_privilege('public', c.oid, 'USAGE')
        OR has_sequence_privilege('public', c.oid, 'SELECT') OR has_sequence_privilege('public', c.oid, 'UPDATE')) ORDER BY 1`)),
    ...(await rows(`SELECT 'PUBLIC_EXECUTES_SECURITY_DEFINER ' || p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef AND has_function_privilege('public', p.oid, 'EXECUTE') ORDER BY 1`)),
    ...(await rows(`SELECT 'SECURITY_DEFINER_WITHOUT_PINNED_SEARCH_PATH ' || p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) cfg
        WHERE cfg LIKE 'search_path=pg_catalog%' AND cfg NOT LIKE '%$user%' AND cfg NOT LIKE '%pg_temp%') ORDER BY 1`)),
    ...(await rows(`SELECT 'PUBLIC_CAN_CREATE_IN_SCHEMA_PUBLIC' WHERE has_schema_privilege('public', 'public', 'CREATE')`)),
    ...(await rows(`SELECT 'GROUP_ROLE_TOO_POWERFUL ' || rolname FROM pg_roles
      WHERE rolname IN ('${GROUP_ROLES.join("','")}') AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication)
      ORDER BY 1`)),
  ];
}

describe('exact effective privilege surface', () => {
  test('every group role exists', async () => {
    const present = (await db.owner.query(`SELECT rolname FROM pg_roles WHERE rolname = ANY($1) ORDER BY 1`, [GROUP_ROLES])).rows.map((r) => r.rolname);
    assert.deepEqual(present, [...GROUP_ROLES].sort());
  });

  test('relations (per column), sequences, SECURITY DEFINER EXECUTE, schema and memberships equal the reviewed snapshot', async () => {
    const actual = await surface(db.owner);
    for (const key of Object.keys(EXPECTED)) assert.deepEqual(actual[key as keyof typeof actual], EXPECTED[key], key);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(EXPECTED).sort());
  });

  test('tourist personal data is never reachable by Admin, publisher, admin operator, media or PUBLIC', async () => {
    const m = await columnMatrix(db.owner, TOURIST_DATA);
    for (const rel of TOURIST_DATA) {
      for (const role of ['admin_app', 'admin_operator', 'admin_publisher', 'media_worker', 'public']) assert.equal(m[rel]![role], undefined, `${role} on ${rel}`);
    }
  });

  test('secrets stay with their single owner: password hash, TOTP seed, session token MAC', async () => {
    const m = await columnMatrix(db.owner, ['admin_user', 'admin_totp', 'admin_session']);
    const has = (rel: string, role: string, col: string) => {
      const g = m[rel]![role] ?? '';
      return /S\(\*\)/.test(g) || new RegExp(`S\\([^)]*\\b${col}\\b`).test(g);
    };
    for (const role of ['admin_operator', 'admin_publisher', 'commerce_app', 'commerce_operator', 'media_worker', 'public']) {
      assert.equal(has('admin_user', role, 'password_scrypt'), false, `${role} reads password_scrypt`);
      assert.equal(has('admin_totp', role, 'seed_ciphertext'), false, `${role} reads seed_ciphertext`);
    }
    for (const role of ['admin_operator', 'commerce_app', 'commerce_operator', 'media_worker', 'public']) {
      assert.equal(has('admin_session', role, 'token_mac'), false, `${role} reads token_mac`);
    }
    for (const role of ['admin_app', 'admin_publisher']) assert.doesNotMatch(m.admin_session![role] ?? '', /U\([^)]*token_mac|U\(\*\)/, role);
  });

  test('purchase identity and history are SELECT-only for the service, for every column', async () => {
    const m = await columnMatrix(db.owner, ['purchase', 'purchase_revision', 'purchase_revision_participant']);
    for (const grants of Object.values(m)) assert.deepEqual(grants, { commerce_app: 'S(*)' });
  });
});

describe('catalog-wide security invariants', () => {
  test('no PUBLIC privilege of any kind on relations or sequences, no PUBLIC-executable SECURITY DEFINER, pinned search_path, NOLOGIN group roles', async () => {
    assert.deepEqual(await catalogViolations(db.owner), []);
    const secdef = Number((await db.owner.query(`SELECT count(*) AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef`)).rows[0].n);
    assert.ok(secdef > 0, 'the check must actually inspect SECURITY DEFINER functions');
  });
});

describe('sensitivity: each check fails when its guard is deliberately broken (rolled back)', () => {
  async function inRollback<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    await db.owner.query('BEGIN');
    try { return await fn(db.owner); } finally { await db.owner.query('ROLLBACK'); }
  }
  const seq = async (c: Client) => (await c.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S' ORDER BY 1 LIMIT 1`)).rows[0].relname as string;

  const breaks: Array<[string, 'surface' | 'catalog', (c: Client) => Promise<void>]> = [
    ['Admin reads tourist documents', 'surface', async (c) => { await c.query('GRANT SELECT ON order_document TO admin_app'); }],
    ['service rewrites purchase history', 'surface', async (c) => { await c.query('GRANT UPDATE ON purchase_revision TO commerce_app'); }],
    ['media worker reads one contact column', 'surface', async (c) => { await c.query('GRANT SELECT (order_id) ON order_contact TO media_worker'); }],
    // Review of PR #74 (SOL): column widening invisible to any-column flags.
    ['admin operator reads password_scrypt', 'surface', async (c) => { await c.query('GRANT SELECT (password_scrypt) ON admin_user TO admin_operator'); }],
    ['Admin may update token_mac', 'surface', async (c) => { await c.query('GRANT UPDATE (token_mac) ON admin_session TO admin_app'); }],
    ['admin_publisher reads the audit log', 'surface', async (c) => { await c.query('GRANT SELECT ON admin_audit TO admin_publisher'); }],
    ['service may use a sequence', 'surface', async (c) => { await c.query(`GRANT USAGE ON SEQUENCE ${await seq(c)} TO commerce_app`); }],
    ['media worker executes an Admin SECURITY DEFINER function', 'surface', async (c) => {
      const f = (await c.query(`SELECT p.oid::regprocedure::text AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef AND NOT has_function_privilege('media_worker', p.oid, 'EXECUTE') ORDER BY 1 LIMIT 1`)).rows[0].f;
      await c.query(`GRANT EXECUTE ON FUNCTION ${f} TO media_worker`);
    }],
    ['Admin inherits pg_read_all_data', 'surface', async (c) => { await c.query('GRANT pg_read_all_data TO admin_app'); }],
    ['admin operator may create in schema public', 'surface', async (c) => { await c.query('GRANT CREATE ON SCHEMA public TO admin_operator'); }],
    ['PUBLIC reads the sales switch', 'catalog', async (c) => { await c.query('GRANT SELECT ON sales_switch TO PUBLIC'); }],
    // Review of PR #74 (SOL): REFERENCES/TRIGGER were not in the PUBLIC check.
    ['PUBLIC may reference departure', 'catalog', async (c) => { await c.query('GRANT REFERENCES ON departure TO PUBLIC'); }],
    ['PUBLIC may create triggers on tour', 'catalog', async (c) => { await c.query('GRANT TRIGGER ON tour TO PUBLIC'); }],
    ['PUBLIC may use a sequence', 'catalog', async (c) => { await c.query(`GRANT USAGE ON SEQUENCE ${await seq(c)} TO PUBLIC`); }],
    ['PUBLIC executes a new SECURITY DEFINER function', 'catalog', async (c) => {
      await c.query(`CREATE FUNCTION zz_sabotage() RETURNS int SECURITY DEFINER SET search_path = pg_catalog, public AS 'SELECT 1' LANGUAGE sql`);
    }],
    ['SECURITY DEFINER without pinned search_path', 'catalog', async (c) => {
      await c.query(`CREATE FUNCTION zz_sabotage2() RETURNS int SECURITY DEFINER AS 'SELECT 1' LANGUAGE sql`);
      await c.query('REVOKE ALL ON FUNCTION zz_sabotage2() FROM PUBLIC');
    }],
    ['PUBLIC may create in schema public', 'catalog', async (c) => { await c.query('GRANT CREATE ON SCHEMA public TO PUBLIC'); }],
    ['a group role can log in', 'catalog', async (c) => { await c.query('ALTER ROLE media_worker LOGIN'); }],
  ];
  for (const [label, check, sabotage] of breaks) {
    test(label, async () => {
      await inRollback(async (c) => {
        await sabotage(c);
        if (check === 'surface') assert.notDeepEqual(JSON.parse(JSON.stringify(await surface(c))), EXPECTED);
        else assert.notDeepEqual(await catalogViolations(c), []);
      });
      // Restored: the rollback leaves the reviewed state intact.
      assert.deepEqual(JSON.parse(JSON.stringify(await surface(db.owner))), EXPECTED);
      assert.deepEqual(await catalogViolations(db.owner), []);
    });
  }
});
