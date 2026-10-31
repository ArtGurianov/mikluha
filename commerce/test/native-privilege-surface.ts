// Shared by native-privilege-conformance.test.ts and the snapshot generator. Reads the EFFECTIVE
// privilege surface (role inheritance included) from the PostgreSQL catalog.
import type pg from 'pg';

export const GROUP_ROLES = ['commerce_app', 'commerce_operator', 'admin_app', 'admin_operator', 'admin_publisher', 'media_worker'] as const;
export const GRANTEES = [...GROUP_ROLES, 'public'] as const;

/** Money, identity, tourist-data, Admin, legal and media relations whose exact columns are pinned. */
export const SENSITIVE_RELATIONS = [
  'purchase', 'purchase_revision', 'purchase_revision_participant', 'purchase_current', 'order_purchase_profile',
  'orders', 'order_contact', 'order_passenger', 'order_document', 'order_eis', 'order_eis_event', 'order_event',
  'email_outbox', 'processing_instruction', 'sales_switch', 'sales_switch_event',
  'admin_user', 'admin_totp', 'admin_session', 'admin_audit', 'admin_login_throttle',
  'media_asset', 'media_event', 'legal_publication', 'editorial_audit', 'content_item_revision',
] as const;

export type Client = Pick<pg.Client, 'query'>;
export type Grants = Record<string, string>;

/**
 * Per relation and grantee, e.g. "D S(*) U(last_seen_at,revoked_at)": table-level DELETE/TRUNCATE/
 * TRIGGER flags, then SELECT/INSERT/UPDATE/REFERENCES with the exact columns ("*" = every column).
 */
export async function columnMatrix(c: Client, relations: readonly string[] = SENSITIVE_RELATIONS): Promise<Record<string, Grants>> {
  const out: Record<string, Grants> = {};
  for (const rel of relations) {
    out[rel] = {};
    // One round trip per relation: every grantee x privilege with its allowed columns, in column order.
    const rows = (await c.query(`
      WITH cols AS (SELECT attname, attnum, count(*) OVER () AS total FROM pg_attribute
                     WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped),
           g AS (SELECT unnest($2::text[]) AS role)
      SELECT g.role,
             has_table_privilege(g.role, $1::regclass, 'DELETE') AS d, has_table_privilege(g.role, $1::regclass, 'TRUNCATE') AS t,
             has_table_privilege(g.role, $1::regclass, 'TRIGGER') AS tg,
             (SELECT jsonb_build_object('total', max(total),
                'S', coalesce(jsonb_agg(attname ORDER BY attnum) FILTER (WHERE has_column_privilege(g.role, $1::regclass, attname, 'SELECT')), '[]'),
                'I', coalesce(jsonb_agg(attname ORDER BY attnum) FILTER (WHERE has_column_privilege(g.role, $1::regclass, attname, 'INSERT')), '[]'),
                'U', coalesce(jsonb_agg(attname ORDER BY attnum) FILTER (WHERE has_column_privilege(g.role, $1::regclass, attname, 'UPDATE')), '[]'),
                'R', coalesce(jsonb_agg(attname ORDER BY attnum) FILTER (WHERE has_column_privilege(g.role, $1::regclass, attname, 'REFERENCES')), '[]'))
                FROM cols) AS colgrants
        FROM g`, [`public.${rel}`, GRANTEES])).rows;
    for (const r of rows) {
      const parts: string[] = [];
      if (r.d) parts.push('D');
      if (r.t) parts.push('T');
      if (r.tg) parts.push('G');
      for (const flag of ['S', 'I', 'U', 'R'] as const) {
        const allowed = r.colgrants[flag] as string[];
        if (allowed.length > 0) parts.push(`${flag}(${allowed.length === Number(r.colgrants.total) ? '*' : allowed.join(',')})`);
      }
      if (parts.length > 0) out[rel][r.role] = parts.join(' ');
    }
  }
  return out;
}

/** Every sequence in schema public: grantees with USAGE/SELECT/UPDATE. */
export async function sequenceMatrix(c: Client): Promise<Record<string, Grants>> {
  const seqs = (await c.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S' ORDER BY 1`)).rows.map((r) => r.relname as string);
  const out: Record<string, Grants> = {};
  for (const seq of seqs) {
    out[seq] = {};
    for (const role of GRANTEES) {
      const p = (await c.query(`SELECT has_sequence_privilege($1, $2::regclass, 'USAGE') AS u, has_sequence_privilege($1, $2::regclass, 'SELECT') AS s,
        has_sequence_privilege($1, $2::regclass, 'UPDATE') AS w`, [role, `public.${seq}`])).rows[0];
      const flags = (p.u ? 'U' : '') + (p.s ? 'S' : '') + (p.w ? 'W' : '');
      if (flags !== '') out[seq][role] = flags;
    }
  }
  return out;
}

/** Per grantee, the SECURITY DEFINER functions in schema public it may EXECUTE. */
export async function securityDefinerExecute(c: Client): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const role of GRANTEES) {
    out[role] = (await c.query(`SELECT p.oid::regprocedure::text AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef AND has_function_privilege($1, p.oid, 'EXECUTE') ORDER BY 1`, [role])).rows.map((r) => r.f as string);
  }
  return out;
}

/** Schema privileges of every grantee on schema public. */
export async function schemaPrivileges(c: Client): Promise<Grants> {
  const out: Grants = {};
  for (const role of GRANTEES) {
    const p = (await c.query(`SELECT has_schema_privilege($1, 'public', 'USAGE') AS u, has_schema_privilege($1, 'public', 'CREATE') AS c`, [role])).rows[0];
    out[role] = (p.u ? 'USAGE' : '') + (p.c ? '+CREATE' : '');
  }
  return out;
}

/** Roles each group role is a member of (directly or transitively). Expected: none. */
export async function groupRoleMemberships(c: Client): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const role of GROUP_ROLES) {
    out[role] = (await c.query(`WITH RECURSIVE up(oid) AS (
        SELECT m.roleid FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = $1
        UNION SELECT m.roleid FROM pg_auth_members m JOIN up ON m.member = up.oid)
      SELECT r.rolname FROM up JOIN pg_roles r ON r.oid = up.oid ORDER BY 1`, [role])).rows.map((r) => r.rolname as string);
  }
  return out;
}

export async function surface(c: Client) {
  return {
    relations: await columnMatrix(c),
    sequences: await sequenceMatrix(c),
    securityDefinerExecute: await securityDefinerExecute(c),
    schemaPublic: await schemaPrivileges(c),
    groupRoleMemberships: await groupRoleMemberships(c),
  };
}
