#!/usr/bin/env python3
"""Restore to this invocation's local Docker Desktop container only. No live target option."""
import argparse
import importlib.util
import json
import os
import pathlib
import secrets
import subprocess
import sys
import uuid
ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'config/mikluha-phase-a/lib'))
from maa_plan import ROLES, validate
from maa_backup import run, verify
from maa_provider import AwsProvider
from maa_recovery import private_file, select_manifest
from maa_acl import attest


def restore(c, dump, docker, check, command=run, crypto=None, structural_only=False):
    """Local synthetic passwords, NOT a replay of production DB-login credentials."""
    if not crypto and not structural_only:
        raise ValueError('Admin key generation/crypto required for qualification')
    name = 'mikluha-phase-a-restore-' + uuid.uuid4().hex
    password = secrets.token_urlsafe(32)
    env = {k: os.environ[k] for k in ('PATH', 'HOME') if k in os.environ}
    env['POSTGRES_PASSWORD'] = password
    def d(*args, data=None):
        check(docker)
        return command([*docker, *args], data)
    started = False
    try:
        check(docker)
        p = subprocess.run([*docker, 'run', '-d', '--name', name, '--network', 'none',
            '--memory', '512m', '--cpus', '.5', '--pids-limit', '128',
            '--label', 'io.mikluha.disposable-restore=' + name,
            '--tmpfs', '/var/lib/postgresql/data:size=512m',
            '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=mikluha',
            c['images']['postgres']], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        if p.returncode:
            raise RuntimeError('isolated local database failed')
        started = True
        import time
        for _ in range(60):
            check(docker)
            # The official entrypoint briefly starts a socket-only init server.
            # Wait for the final TCP listener, not that transient bootstrap server.
            p = subprocess.run([*docker, 'exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'mikluha'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
            if not p.returncode:
                break
            time.sleep(.5)
        else:
            raise RuntimeError('restore readiness timeout')
        caps = sorted(set(ROLES.values()) | {'commerce_operator'})
        sql = '\n'.join(f'CREATE ROLE {r} NOLOGIN;' for r in caps)
        sql += '\n' + '\n'.join(f'CREATE ROLE {login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT {cap} TO {login};' for login, cap in ROLES.items())
        d('exec', '-i', name, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'mikluha', data=sql.encode())
        d('exec', '-i', name, 'pg_restore', '--exit-on-error', '-U', 'postgres', '-d', 'mikluha', data=dump)
        probe = r"""SELECT json_build_object('schema_head',(SELECT max(version) FROM schema_migrations),
          'sales_open',(SELECT open FROM sales_switch),
          'admin_users',(SELECT count(*) FROM admin_user),
          'legal_publications',(SELECT count(*) FROM legal_publication),
          'unsafe_logins',(SELECT count(*) FROM pg_roles WHERE rolcanlogin AND rolname <> 'postgres'
             AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)));"""
        report = json.loads(d('exec', name, 'psql', '-X', '-At', '-U', 'postgres', '-d', 'mikluha', '-c', probe))
        if report['schema_head'] != c['schema_head'] or report['sales_open'] is not False or report['unsafe_logins']:
            raise ValueError('restored schema/gates')
        for login, cap in ROLES.items():
            for other in caps:
                expected = cap == other
                allowed = d('exec', name, 'psql', '-X', '-At', '-U', 'postgres', '-d', 'mikluha',
                            '-c', f"SELECT pg_has_role('{login}','{other}','MEMBER')").strip() == b't'
                if allowed != expected:
                    raise ValueError('restored membership boundary')
        denied_tables = {'commerce_runtime': 'admin_user', 'admin_runtime': 'orders',
                         'admin_publish_runtime': 'admin_totp', 'admin_operator_login': 'admin_totp',
                         'media_runtime': 'admin_user'}
        for login, table in denied_tables.items():
            d('exec', name, 'psql', '-X', '-At', '-U', login, '-d', 'mikluha', '-c', 'SELECT 1')
            check(docker)
            result = subprocess.run([*docker, 'exec', name, 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1',
                '-U', login, '-d', 'mikluha', '-c', 'SELECT * FROM ' + table + ' LIMIT 0'],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
            if result.returncode == 0 or b'permission denied' not in result.stderr:
                raise ValueError('negative login transport probe did not prove denial')
        privileges = attest(c, lambda q: json.loads(d('exec', name, 'psql', '-X', '-At', '-U', 'postgres', '-d', 'mikluha', '-c', q)))
        crypto_report = crypto(name) if crypto else {'admin_crypto': 'NOT_RUN'}
        if not structural_only and crypto_report.get('admin_crypto') not in ('PASS', 'EMPTY_WORKING_GENERATION_KEYS_LOADED'):
            raise ValueError('Admin crypto qualification incomplete')
        return {'restore_qualification': 'PARTIAL' if structural_only else 'PASS',
                'privileges_sha256': privileges, 'local_structural_restore': 'PASS', **report, 'network': 'none', **crypto_report,
                'login_transport_probes': 'PASS',
                'current_restriction_reconciliation': 'NOT_RUN', 'real_admission': 'NO_GO'}
    finally:
        if started:
            d('rm', '-f', name)


def main():
    p = argparse.ArgumentParser()
    for key in ('candidate', 'credentials', 'scratch', 'identity'):
        p.add_argument('--' + key, type=pathlib.Path, required=True)
    p.add_argument('--incident-before',required=True)
    p.add_argument('--manifest')
    p.add_argument('--authorized-disposable-restore', action='store_true')
    mode = p.add_mutually_exclusive_group(required=True)
    mode.add_argument('--admin-keys', type=pathlib.Path)
    mode.add_argument('--structural-only', action='store_true')
    a = p.parse_args()
    private_file(a.identity)
    if not a.authorized_disposable_restore:
        raise ValueError('local disposable creation/removal must be authorized')
    # Reuse the explicit operator-owned Docker Desktop policy outside Git. Never auto-enroll a daemon.
    spec = importlib.util.spec_from_file_location('local_ci', ROOT / 'scripts/mikluha-phase-a/local-engine.py')
    engine = importlib.util.module_from_spec(spec); spec.loader.exec_module(engine)
    docker = engine.local_docker()
    c=json.loads(a.candidate.read_text());validate(c,ready=True)
    provider=AwsProvider(c,a.credentials,a.scratch,docker=docker,check=lambda:engine.verify_engine(docker),read_only=True)
    provider.assert_configuration()
    manifest=select_manifest(c,provider,a.incident_before,manifest_key=a.manifest)
    dump,metadata=verify(c,provider,manifest,a.incident_before,
                        lambda body:run(['age','-d','-i',str(a.identity)],body))
    def crypto(name):
        import stat
        path = a.admin_keys
        st = path.lstat()
        if path.resolve() != path or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != 0o600:
            raise ValueError('private off-host generation file')
        engine.verify_engine(docker)
        return json.loads(run([*docker, 'run', '--rm', '--read-only', '--network', 'container:' + name,
            '--memory', '256m', '--cpus', '.25', '--pids-limit', '32',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
            '--mount', 'type=bind,source=' + str(path) + ',target=/run/restore-keys.json,readonly',
            '--mount', 'type=bind,source=' + str(pathlib.Path(__file__).resolve().parent / 'crypto-check.mjs') + ',target=/run/crypto-check.mjs,readonly',
            '-e', 'EXPECTED_SECRET_GENERATION=' + c['secret_authority']['generation'],
            '-e', 'RESTORE_SCOPE=' + c['scope'], c['images']['commerce'], 'node', '/run/crypto-check.mjs']))
    result=restore(c,dump,docker,engine.verify_engine,crypto=crypto if a.admin_keys else None,structural_only=a.structural_only)
    print(json.dumps(dict(result,retrieval=metadata['retrieval'])))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('RESTORE=FAIL; diagnostic values suppressed', file=sys.stderr)
        sys.exit(1)
