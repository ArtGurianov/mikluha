// TOUR-37 / TOUR-51 · native conformance: the exact least-privilege surface of the money, identity,
// tourist-data, Admin and media relations, read from the PostgreSQL catalog of a fully migrated
// disposable database. Any new grant, revoked guard or PUBLIC-executable SECURITY DEFINER function
// fails here until the matrix is deliberately updated in review.
//
// Source/schema conformance only: it proves the migrated catalog, not deployed role membership,
// provider behavior or a qualified banking flow. Synthetic database, no real data.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import type pg from 'pg';

import { freshDb, type TestDb } from './helpers.js';

const GROUP_ROLES = ['commerce_app', 'commerce_operator', 'admin_app', 'admin_operator', 'admin_publisher', 'media_worker'] as const;
const GRANTEES = [...GROUP_ROLES, 'public'] as const;

// S select · I insert · U update · D delete · T truncate · R references · G trigger (any column for S/I/U/R).
const EXPECTED: Record<string, Partial<Record<(typeof GRANTEES)[number], string>>> = {
  purchase: { commerce_app: 'S' },
  purchase_revision: { commerce_app: 'S' },
  purchase_revision_participant: { commerce_app: 'S' },
  purchase_current: { commerce_app: 'S' },
  order_purchase_profile: { commerce_app: 'S' },
  orders: { commerce_app: 'SIU', commerce_operator: 'S' },
  order_contact: { commerce_app: 'SID', commerce_operator: 'S' },
  order_passenger: { commerce_app: 'SID', commerce_operator: 'S' },
  order_document: { commerce_app: 'SIU', commerce_operator: 'S' },
  order_eis: { commerce_operator: 'S' },
  order_eis_event: { commerce_operator: 'S' },
  order_event: { commerce_app: 'SI' },
  email_outbox: { commerce_app: 'SIU' },
  processing_instruction: { commerce_app: 'S', commerce_operator: 'S' },
  sales_switch: { commerce_app: 'S', commerce_operator: 'S' },
  sales_switch_event: { commerce_app: 'S', commerce_operator: 'S' },
  admin_user: { admin_app: 'S', admin_operator: 'S', admin_publisher: 'S' },
  admin_totp: { admin_app: 'S', admin_operator: 'S' },
  admin_session: { admin_app: 'SU', admin_operator: 'S', admin_publisher: 'SU' },
  admin_audit: { admin_app: 'SI', admin_operator: 'S', admin_publisher: 'I' },
  admin_login_throttle: { admin_app: 'SIUD' },
  media_asset: {},
  media_event: {},
  legal_publication: { admin_app: 'S' },
  editorial_audit: { admin_app: 'S' },
  content_item_revision: { admin_app: 'S' },
};

const TOURIST_DATA = ['order_contact', 'order_passenger', 'order_document'] as const;

let db: TestDb;
before(async () => { db = await freshDb(); });
after(async () => { await db.drop(); });

type Client = Pick<pg.Client, 'query'>;

async function privilegeMatrix(c: Client, relations: readonly string[]) {
  const out: Record<string, Record<string, string>> = {};
  for (const rel of relations) {
    out[rel] = {};
    for (const role of GRANTEES) {
      const p = (await c.query(`SELECT
          has_any_column_privilege($1, $2::regclass, 'SELECT') AS s, has_any_column_privilege($1, $2::regclass, 'INSERT') AS i,
          has_any_column_privilege($1, $2::regclass, 'UPDATE') AS u, has_table_privilege($1, $2::regclass, 'DELETE') AS d,
          has_table_privilege($1, $2::regclass, 'TRUNCATE') AS t, has_any_column_privilege($1, $2::regclass, 'REFERENCES') AS r,
          has_table_privilege($1, $2::regclass, 'TRIGGER') AS g`, [role, `public.${rel}`])).rows[0];
      const flags = (['s', 'i', 'u', 'd', 't', 'r', 'g'] as const).filter((k) => p[k]).map((k) => k.toUpperCase()).join('');
      if (flags !== '') out[rel][role] = flags;
    }
  }
  return out;
}

/** Catalog-wide invariants that hold for every relation and function, not only the listed ones. */
async function catalogViolations(c: Client): Promise<string[]> {
  const rows = async (sql: string) => (await c.query(sql)).rows.map((r) => Object.values(r).join(' '));
  return [
    ...(await rows(`SELECT 'PUBLIC_RELATION_PRIVILEGE ' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m','p','f','S')
        AND (has_any_column_privilege('public', c.oid, 'SELECT') OR has_any_column_privilege('public', c.oid, 'INSERT')
          OR has_any_column_privilege('public', c.oid, 'UPDATE') OR (c.relkind <> 'S' AND (has_table_privilege('public', c.oid, 'DELETE')
          OR has_table_privilege('public', c.oid, 'TRUNCATE')))) ORDER BY 1`)),
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

describe('least-privilege matrix of money, identity, tourist-data, Admin and media relations', () => {
  test('every group role exists, and the migrated grants equal the reviewed matrix exactly', async () => {
    const present = (await db.owner.query(`SELECT rolname FROM pg_roles WHERE rolname = ANY($1) ORDER BY 1`, [GROUP_ROLES])).rows.map((r) => r.rolname);
    assert.deepEqual(present, [...GROUP_ROLES].sort());
    assert.deepEqual(await privilegeMatrix(db.owner, Object.keys(EXPECTED)), EXPECTED);
  });

  test('tourist personal data is never readable or writable by Admin, publisher, admin operator or media roles', async () => {
    const m = await privilegeMatrix(db.owner, TOURIST_DATA);
    for (const rel of TOURIST_DATA) {
      for (const role of ['admin_app', 'admin_operator', 'admin_publisher', 'media_worker', 'public'] as const) {
        assert.equal(m[rel]![role], undefined, `${role} on ${rel}`);
      }
    }
  });

  test('no role can rewrite purchase identity or history directly: SELECT for the service only', async () => {
    const m = await privilegeMatrix(db.owner, ['purchase', 'purchase_revision', 'purchase_revision_participant']);
    for (const grants of Object.values(m)) assert.deepEqual(grants, { commerce_app: 'S' });
  });
});

describe('catalog-wide security invariants', () => {
  test('no PUBLIC privileges, no PUBLIC-executable SECURITY DEFINER, pinned search_path, NOLOGIN group roles', async () => {
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

  const breaks: Array<[string, string, (c: Client) => Promise<void>]> = [
    ['Admin reads tourist documents', 'matrix', async (c) => { await c.query('GRANT SELECT ON order_document TO admin_app'); }],
    ['service rewrites purchase history', 'matrix', async (c) => { await c.query('GRANT UPDATE ON purchase_revision TO commerce_app'); }],
    ['media worker reads contacts (one column)', 'matrix', async (c) => { await c.query('GRANT SELECT (order_id) ON order_contact TO media_worker'); }],
    ['admin_publisher reads the audit log', 'matrix', async (c) => { await c.query('GRANT SELECT ON admin_audit TO admin_publisher'); }],
    ['PUBLIC reads the sales switch', 'catalog', async (c) => { await c.query('GRANT SELECT ON sales_switch TO PUBLIC'); }],
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
        if (check === 'matrix') assert.notDeepEqual(await privilegeMatrix(c, Object.keys(EXPECTED)), EXPECTED);
        else assert.notDeepEqual(await catalogViolations(c), []);
      });
      // Restored: the rollback leaves the reviewed state intact.
      assert.deepEqual(await privilegeMatrix(db.owner, Object.keys(EXPECTED)), EXPECTED);
      assert.deepEqual(await catalogViolations(db.owner), []);
    });
  }
});
