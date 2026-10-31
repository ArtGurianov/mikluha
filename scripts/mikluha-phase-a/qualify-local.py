#!/usr/bin/env python3
"""Owned local-only conformance: actual PG/age/restore/crypto, in-memory provider fixture.

No Cloud.ru, host installation, real photo, app env, provider credential or sales operation.
"""
import argparse
import base64
import importlib.util
import json
import os
import pathlib
import secrets
import subprocess
import sys
import tempfile
import time
import uuid
ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'config/mikluha-phase-a/lib'))
import maa_backup as b
from maa_plan import ROLES
import maa_acl as acl
from maa_recovery import select_manifest


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


class Fixture:
    def __init__(self):
        self.data = {}
        self.modified=(b.stamp()-__import__('datetime').timedelta(seconds=5)).replace(microsecond=0).isoformat()
    def put(self, key, body):
        if key in self.data: raise ValueError('overwrite')
        self.data[key] = body
    def head(self,key):
        import hashlib
        return {'ContentLength':len(self.data[key]),'ETag':hashlib.sha256(self.data[key]).hexdigest(),'LastModified':self.modified}
    def get(self,key,expected=None):
        if expected is not None and self.head(key)!=expected:raise ValueError('fixture changed')
        return self.data[key]
    def records(self):return [dict(Key=k,**self.head(k)) for k in self.data]


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--commerce-image', required=True)
    p.add_argument('--postgres-image', help='Defaults to the candidate pinned PostgreSQL digest, never a mutable tag')
    p.add_argument('--output', type=pathlib.Path, required=True)
    a = p.parse_args()
    if a.output.exists(): raise ValueError('receipt already exists')
    engine = load('maa_local_engine', ROOT / 'scripts/mikluha-phase-a/local-engine.py')
    docker = engine.local_docker()
    def d(*args, data=None):
        engine.verify_engine(docker)
        return b.run([*docker, *args], data)
    c = json.loads((ROOT / 'config/mikluha-phase-a/candidate.json').read_text())
    postgres_ref = a.postgres_image or c['images']['postgres']
    import re
    if not re.fullmatch(r'postgres@sha256:[0-9a-f]{64}',postgres_ref):raise ValueError('pinned PostgreSQL digest required')
    image = d('image', 'inspect', '--format', '{{.Id}}', a.commerce_image).decode().strip()
    pg_image = d('image', 'inspect', '--format', '{{.Id}}', postgres_ref).decode().strip()
    for ref in (image,pg_image):
        if d('image','inspect','--format','{{.Os}}/{{.Architecture}}',ref).decode().strip()!='linux/amd64':
            raise ValueError('qualification images must match linux/amd64 target')
    source = json.loads(d('run', '--rm', '--network', 'none', image, 'cat', '/app/identity/identity.json'))['sourceCommit']
    c['source_commit'] = source; c['images'].update(postgres=pg_image, commerce=image)
    c['secret_authority'] = {'generation': 'synthetic-local-1', 'offhost_reference': 'NOT_A_REAL_OFFHOST_PROOF'}
    name = 'mikluha-phase-a-qualify-' + uuid.uuid4().hex
    created = False
    with tempfile.TemporaryDirectory(prefix='mikluha-phase-a-') as temp:
        path = pathlib.Path(temp).resolve(); os.chmod(path, 0o700)
        key_path = path / 'admin-keys.json'
        keys = {'generation': 'synthetic-local-1', 'ADMIN_TOTP_KEY': secrets.token_urlsafe(32),
                'ADMIN_AUDIT_KEY': secrets.token_urlsafe(32), 'ADMIN_AUDIT_KEY_ID': 'local-1',
                'ADMIN_AUDIT_PREVIOUS_KEYS': '{}'}
        key_path.write_text(json.dumps(keys)); os.chmod(key_path, 0o600)
        identity = path / 'age-identity'
        identity.write_bytes(b.run(['age-keygen'])); os.chmod(identity, 0o600)
        c['backup']['recipient'] = b.run(['age-keygen', '-y', str(identity)]).decode().strip()
        try:
            d('run', '-d', '--name', name, '--network', 'none', '--memory', '512m', '--cpus', '.5',
              '--tmpfs', '/var/lib/postgresql/data:size=512m', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
              '-e', 'POSTGRES_DB=mikluha', pg_image); created = True
            for _ in range(60):
                engine.verify_engine(docker)
                r = subprocess.run([*docker, 'exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'mikluha'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
                if r.returncode == 0: break
                time.sleep(.5)
            else: raise ValueError('PG not ready')
            script = r"""
import fs from 'node:fs'; import pg from '/app/commerce/node_modules/pg/lib/index.js';
import {migrate} from '/app/commerce/dist/migrate.js';
import {adminKeys,parseAuditKeys} from '/app/commerce/dist/admin/attestation.js';
import {parseTotpKey,encryptSeed} from '/app/commerce/dist/admin/totp.js';
import {hashPassword} from '/app/commerce/dist/admin/password.js';
import {audit} from '/app/commerce/dist/admin/auth.js';
const supplied=JSON.parse(fs.readFileSync('/run/keys.json','utf8'));
const pool=new pg.Pool({connectionString:'postgres://postgres@127.0.0.1:5432/mikluha'});
const client=await pool.connect(); await migrate(client,'/app/commerce/migrations');client.release();
const roles={commerce_runtime:'commerce_app',admin_runtime:'admin_app',admin_publish_runtime:'admin_publisher',admin_operator_login:'admin_operator',media_runtime:'media_worker'};
for(const [login,cap] of Object.entries(roles))await pool.query(`CREATE ROLE ${login} LOGIN; GRANT ${cap} TO ${login}`);
const id='12345678-1234-4234-8234-123456789abc';
await pool.query("INSERT INTO admin_user(id,login,role,password_scrypt,password_changed_at) VALUES($1,'synthetic-owner','OWNER',$2,now())",[id,await hashPassword('Synthetic qualification only 63!')]);
const totp=parseTotpKey(supplied.ADMIN_TOTP_KEY);
await pool.query('INSERT INTO admin_totp(admin_id,seed_ciphertext,enrolled_at) VALUES($1,$2,now())',[id,encryptSeed(totp,id,Buffer.alloc(20,9))]);
const keys=adminKeys(totp,parseAuditKeys(supplied));
await audit(pool,keys,{adminId:id,actor:'synthetic-owner',action:'TEST.SYNTHETIC',outcome:'OK',entityType:'synthetic',entityId:id,details:{}});
console.log(JSON.stringify({schema_head:19,sales_open:false}));await pool.end();
"""
            meta = json.loads(d('run', '--rm', '-i', '--network', 'container:' + name,
                '--mount', f'type=bind,source={key_path},target=/run/keys.json,readonly',
                image, 'node', '--input-type=module', data=script.encode()))
            def sql(query):
                return json.loads(d('exec',name,'psql','-X','-qAt','-U','postgres','-d','mikluha','-c',query))
            c['privileges_sha256'] = acl.fingerprint(sql(acl.SQL))
            import hashlib
            journal=sql("SELECT coalesce(json_agg(json_build_object('v',version,'f',file,'c',checksum) ORDER BY version),'[]') FROM schema_migrations")
            if [r['v'] for r in journal]!=list(range(1,c['schema_head']+1)):raise ValueError('qualification schema journal incomplete')
            journal_sha256=hashlib.sha256(json.dumps(journal,sort_keys=True).encode()).hexdigest()
            c['database_generation'] = 'synthetic-db-1'
            acl.attest(c, sql)
            # Mutations execute in the same real PG session/snapshot and roll back.
            seq=sql("SELECT to_json(min(quote_ident(n.nspname)||'.'||quote_ident(c.relname))) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S'")
            fn=sql("SELECT to_json(min(p.oid::regprocedure::text)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'")
            mutations=[
                'GRANT SELECT ON admin_totp TO commerce_runtime',
                'GRANT SELECT ON admin_totp TO PUBLIC',
                'GRANT SELECT(seed_ciphertext) ON admin_totp TO commerce_runtime',
                'GRANT USAGE ON SEQUENCE '+seq+' TO commerce_runtime',
                'GRANT EXECUTE ON FUNCTION '+fn+' TO commerce_runtime',
                'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC',
                'GRANT CREATE ON SCHEMA public TO commerce_runtime',
                'ALTER ROLE admin_app SUPERUSER',
                'GRANT admin_operator TO commerce_runtime']
            for mutation in mutations:
                observed=sql('BEGIN; '+mutation+'; '+acl.SQL+'; ROLLBACK;')
                try: acl.attest(c,lambda _:observed)
                except ValueError: pass
                else: raise ValueError('unexpected ACL drift accepted')
            acl.attest(c,sql)
            db = {'scope': 'acceptance', 'source_commit': source, 'schema_head': meta['schema_head'],
                  'sales_open': meta['sales_open'], 'role_contract': 'PASS', 'container_id': name, 'privileges_sha256':c['privileges_sha256'], 'database_generation':c['database_generation']}
            dump = lambda: d('exec', name, 'pg_dump', '--format=custom', '-U', 'postgres', '-d', 'mikluha')
            clear, metadata = b.capture(c, lambda: db, dump)
            cipher = b.encrypt(clear, c['backup']['recipient'])
            provider=Fixture();status=path/'producer-status';status.mkdir(mode=0o700)
            receipt=b.publish(c,provider,cipher,metadata,status)
            if {p.name for p in status.iterdir()}!={'last-success.json'}:raise ValueError('archive persisted on producer')
            restore = load('maa_disposable_restore', ROOT / 'scripts/mikluha-phase-a/restore-local.py')
            def crypto(container):
                return json.loads(d('run', '--rm', '--read-only', '--network', 'container:' + container,
                    '--memory', '256m', '--pids-limit', '32', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                    '--mount', f'type=bind,source={key_path},target=/run/restore-keys.json,readonly',
                    '--mount', f'type=bind,source={ROOT / "scripts/mikluha-phase-a/crypto-check.mjs"},target=/run/check.mjs,readonly',
                    '-e', 'EXPECTED_SECRET_GENERATION=synthetic-local-1', '-e', 'RESTORE_SCOPE=acceptance',
                    image, 'node', '/run/check.mjs'))
            sql("GRANT SELECT ON admin_totp TO commerce_runtime; SELECT '{}'::json")
            bad_dump=dump()
            sql("REVOKE SELECT ON admin_totp FROM commerce_runtime; SELECT '{}'::json")
            try: restore.restore(c,bad_dump,docker,engine.verify_engine,structural_only=True)
            except ValueError as error:
                if str(error)!='database ACL/role/default privilege drift':raise
                acl_restore='REJECTED'
            else: raise ValueError('restored extra ACL was admitted')
            d('rm','-f',name);created=False
            (status/'last-success.json').unlink()
            cutoff=b.stamp().isoformat()
            manifest=select_manifest(c,provider,cutoff)
            recovered,retrieval_meta=b.verify(c,provider,manifest,cutoff,lambda body:b.run(['age','-d','-i',str(identity)],body))
            result=restore.restore(c,recovered,docker,engine.verify_engine,crypto=crypto)
            wrong = path / 'wrong-age'; wrong.write_bytes(b.run(['age-keygen'])); os.chmod(wrong, 0o600)
            try:
                b.run(['age', '-d', '-i', str(wrong)], cipher)
            except RuntimeError:
                wrong_key = 'REJECTED'
            else: raise ValueError('wrong decryption key accepted')
            report = {'format': 'mikluha.phase-a-local-qualification/1', 'result': 'PASS',
                'source_commit': source, 'commerce_local_image_id': image, 'postgres_local_image_id': pg_image,
                'qualified_at':b.stamp().isoformat(), 'commerce_requested_image':a.commerce_image,
                'postgres_requested_image':postgres_ref, 'schema_journal_sha256':journal_sha256,
                'platform':'linux/amd64',
                'actual_pg_age_dump_restore': result, 'wrong_age_identity': wrong_key, 'unexpected_grants': 'REJECTED', 'actual_acl_mutation_cases': len(mutations), 'restored_unexpected_grant': acl_restore,
                'provider': 'IN_MEMORY_FIXTURE_NOT_CLOUD_RU', 'vps_installation': 'NOT_RUN',
                'real_offhost_keys': 'NOT_RUN', 'restriction_reconciliation': 'NOT_RUN',
                'cloud_only_retrieval_after_source_loss':'PASS_PROVIDER_FIXTURE_NOT_REAL_CLOUD_RU',
                'retrieval_selection':retrieval_meta['retrieval'], 'retained_producer_archives':0,
                'phase_a_admission': 'NO_GO', 'phase_b': 'NO_GO'}
        finally:
            if created: d('rm', '-f', name)
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(report, indent=2) + '\n')
    print('LOCAL_QUALIFICATION=PASS; provider/installed/offhost/restriction acceptance NOT_RUN')


if __name__ == '__main__':
    try: main()
    except Exception:
        print('LOCAL_QUALIFICATION=FAIL; confidential diagnostics suppressed', file=sys.stderr)
        sys.exit(1)
