"""Nonsecret privilege contract. Pin only from a clean, independently qualified schema.

No OIDs, passwords or data: include direct/default/PUBLIC/column ACLs, owners,
role attributes and membership edges, plus SECURITY DEFINER/search_path flags.
Raw ACL differences fail conservatively even when inherited access is redundant.
"""
import hashlib
import json
import re

SQL = r"""
WITH ns AS (SELECT * FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'),
entries AS (
 SELECT 'role' kind, rolname identity,
   json_build_object('login',rolcanlogin,'super',rolsuper,'inherit',rolinherit,
    'createrole',rolcreaterole,'createdb',rolcreatedb,'replication',rolreplication,
    'bypass',rolbypassrls,'limit',rolconnlimit,'config',rolconfig)::jsonb detail
 FROM pg_roles WHERE rolname !~ '^pg_'
 UNION ALL
 SELECT 'member', quote_ident(r.rolname)||':'||quote_ident(m.rolname),
   json_build_object('grantor',g.rolname,'admin',a.admin_option,'inherit',a.inherit_option,'set',a.set_option)::jsonb
 FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member JOIN pg_roles g ON g.oid=a.grantor
 WHERE r.rolname !~ '^pg_' OR m.rolname !~ '^pg_'
 UNION ALL
 SELECT 'schema', quote_ident(nspname), json_build_object('owner',pg_get_userbyid(nspowner),
   'acl',ARRAY(SELECT x::text FROM unnest(coalesce(nspacl,acldefault('n',nspowner))) x ORDER BY x::text))::jsonb FROM ns
 UNION ALL
 SELECT 'relation', quote_ident(n.nspname)||'.'||quote_ident(c.relname),
   json_build_object('kind',c.relkind,'owner',pg_get_userbyid(c.relowner),'acl',
    ARRAY(SELECT x::text FROM unnest(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) x ORDER BY x::text))::jsonb
 FROM pg_class c JOIN ns n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','f','S')
 UNION ALL
 SELECT 'column', quote_ident(n.nspname)||'.'||quote_ident(c.relname)||'.'||quote_ident(a.attname),
   json_build_object('acl',ARRAY(SELECT x::text FROM unnest(a.attacl) x ORDER BY x::text))::jsonb
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN ns n ON n.oid=c.relnamespace
 WHERE a.attnum>0 AND NOT a.attisdropped AND cardinality(a.attacl)>0
 UNION ALL
 SELECT 'function', quote_ident(n.nspname)||'.'||quote_ident(p.proname)||'('||pg_get_function_identity_arguments(p.oid)||')',
   json_build_object('owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'config',p.proconfig,
   'acl',ARRAY(SELECT x::text FROM unnest(coalesce(p.proacl,acldefault('f',p.proowner))) x ORDER BY x::text))::jsonb
 FROM pg_proc p JOIN ns n ON n.oid=p.pronamespace
 UNION ALL
 SELECT 'type', quote_ident(n.nspname)||'.'||quote_ident(t.typname),
   json_build_object('owner',pg_get_userbyid(t.typowner),'acl',
   ARRAY(SELECT x::text FROM unnest(coalesce(t.typacl,acldefault('T',t.typowner))) x ORDER BY x::text))::jsonb
 FROM pg_type t JOIN ns n ON n.oid=t.typnamespace
 UNION ALL
 SELECT 'database', datname, json_build_object('owner',pg_get_userbyid(datdba),
   'acl',ARRAY(SELECT x::text FROM unnest(coalesce(datacl,acldefault('d',datdba))) x ORDER BY x::text))::jsonb
 FROM pg_database WHERE datname=current_database()
 UNION ALL
 SELECT 'default', pg_get_userbyid(a.defaclrole)||':'||coalesce(n.nspname,'*')||':'||a.defaclobjtype::text,
   json_build_object('acl',ARRAY(SELECT x::text FROM unnest(a.defaclacl) x ORDER BY x::text))::jsonb
 FROM pg_default_acl a LEFT JOIN pg_namespace n ON n.oid=a.defaclnamespace
)
SELECT coalesce(json_agg(json_build_array(kind,identity,detail) ORDER BY kind,identity,detail::text),'[]') FROM entries
"""


def fingerprint(rows):
    if not isinstance(rows, list) or not rows:
        raise ValueError('empty privilege contract')
    return hashlib.sha256(json.dumps(rows, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def attest(c, query):
    expected = c.get('privileges_sha256')
    if not isinstance(expected, str) or not re.fullmatch('[0-9a-f]{64}', expected):
        raise ValueError('independent clean-schema privilege baseline required')
    actual = fingerprint(query(SQL))
    if actual != expected:
        raise ValueError('database ACL/role/default privilege drift')
    return actual
