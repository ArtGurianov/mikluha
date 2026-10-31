"""Read only the dedicated PostgreSQL container; never returns its credential values."""
import hashlib
import json
import pathlib
import re
from maa_backup import run
from maa_plan import ROLES
from maa_acl import attest

# No secret-bearing SQL is inserted into these fixed command arguments.
SHELL = 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec "$@"'


class Database:
    def __init__(self, c, command=run):
        self.c, self.run = c, command
        found = self.run(['docker', 'ps', '-q', '--no-trunc', '--filter', 'label=io.mikluha.component=postgres',
                          '--filter', 'label=io.mikluha.scope=' + c['scope']]).decode().split()
        if len(found) != 1 or not re.fullmatch(r'[0-9a-f]{64}', found[0]):
            raise ValueError('unique owned database container required')
        self.container = found[0]

    def exec(self, *args, data=None):
        return self.run(['docker', 'exec', '-i', self.container, 'sh', '-c', SHELL, 'phase-a', *args], data)

    def sql(self, query):
        return json.loads(self.exec('psql', '-X', '-qAt', '--no-password', '-v', 'ON_ERROR_STOP=1',
                                   '-U', 'postgres', '-d', 'mikluha', '-c', query))

    def inspect(self):
        row = json.loads(self.run(['docker', 'inspect', self.container]))[0]
        labels = row['Config']['Labels']
        if (not row['State']['Running'] or labels.get('io.mikluha.database-generation') != self.c['database_generation']
            or labels.get('coolify.applicationId') != self.c['application_uuid']
            or row['HostConfig'].get('PortBindings')):
            raise ValueError('database runtime labels/ports')
        images = json.loads(self.run(['docker', 'image', 'inspect', row['Image']]))[0]
        if self.c['images']['postgres'] not in images.get('RepoDigests', []):
            raise ValueError('database image digest mismatch')
        runtime_ids = {}
        for component in ('admin-api', 'commerce'):
            ids = self.run(['docker', 'ps', '-a', '-q', '--no-trunc', '--filter', 'label=io.mikluha.component=' + component,
                            '--filter', 'label=io.mikluha.scope=' + self.c['scope']]).decode().split()
            if len(ids) != 1:
                raise ValueError('required runtime unavailable')
            runtime = json.loads(self.run(['docker', 'inspect', ids[0]]))[0]
            labels = runtime['Config']['Labels']
            if (labels.get('coolify.applicationId') != self.c['application_uuid']
                or labels.get('io.mikluha.source') != self.c['source_commit']
                or labels.get('io.mikluha.secret-generation') != self.c['secret_authority']['generation']):
                raise ValueError('runtime source/secret generation mismatch')
            image = json.loads(self.run(['docker', 'image', 'inspect', runtime['Image']]))[0]
            if self.c['images']['commerce'] not in image.get('RepoDigests', []):
                raise ValueError('runtime image digest mismatch')
            runtime_ids[component] = runtime['Id']
            if component == 'admin-api':
                env = dict(x.split('=', 1) for x in runtime['Config']['Env'] if '=' in x)
                values = {k: env.get(k) for k in ('ADMIN_TOTP_KEY', 'ADMIN_AUDIT_KEY', 'ADMIN_AUDIT_KEY_ID', 'ADMIN_AUDIT_PREVIOUS_KEYS')}
                if any(v is None or not v for v in values.values()):
                    raise ValueError('Admin key generation incomplete')
                if hasattr(self, '_key_snapshot') and values != self._key_snapshot:
                    raise ValueError('Admin key bytes changed during capture')
                self._key_snapshot = values  # process-memory comparison only; never metadata/logging
        migrations = self.sql("SELECT coalesce(json_agg(json_build_object('v',version,'f',file,'c',checksum) ORDER BY version),'[]') FROM schema_migrations")
        if [m['v'] for m in migrations] != list(range(1, self.c['schema_head'] + 1)):
            raise ValueError('schema journal sequence')
        journal_hash = hashlib.sha256(json.dumps(migrations, sort_keys=True).encode()).hexdigest()
        if journal_hash != self.c['schema_journal_sha256']:
            raise ValueError('schema checksum mismatch against qualified image receipt')
        owners = self.sql("SELECT coalesce(json_agg(DISTINCT pg_get_userbyid(relowner)),'[]') FROM pg_class WHERE relnamespace='public'::regnamespace")
        if owners != ['postgres']:
            raise ValueError('unexpected object owner')
        roles = self.sql("SELECT coalesce(json_agg(json_build_object('name',rolname,'super',rolsuper,'bypass',rolbypassrls,'createrole',rolcreaterole,'createdb',rolcreatedb,'replication',rolreplication) ORDER BY rolname),'[]') FROM pg_roles WHERE rolcanlogin AND rolname <> 'postgres'")
        if {r['name'] for r in roles} != set(ROLES) or any(any(v for k, v in r.items() if k != 'name') for r in roles):
            raise ValueError('unsafe/unexpected login role')
        for login, capability in ROLES.items():
            memberships = self.sql(f"SELECT coalesce(json_agg(rolname ORDER BY rolname),'[]') FROM pg_roles WHERE rolname <> '{login}' AND pg_has_role('{login}',oid,'MEMBER')")
            if memberships != [capability]:
                raise ValueError('cross-capability membership')
        privileges = attest(self.c, self.sql)
        sales = self.sql('SELECT json_build_object(\'open\',open) FROM sales_switch')
        return {'scope': self.c['scope'], 'source_commit': self.c['source_commit'],
                'schema_head': len(migrations), 'privileges_sha256': privileges,
                'database_generation': self.c['database_generation'], 'journal_sha256': hashlib.sha256(json.dumps(migrations, sort_keys=True).encode()).hexdigest(),
                'container_id': row['Id'], 'started_at': row['State']['StartedAt'],
                'runtime_ids': runtime_ids, 'secret_generation': self.c['secret_authority']['generation'],
                'postgres_digest': self.c['images']['postgres'], 'sales_open': sales['open'], 'role_contract': 'PASS'}

    def dump(self):
        return self.exec('pg_dump', '--format=custom', '--no-password', '-U', 'postgres', '-d', 'mikluha')
