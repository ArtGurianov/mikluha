"""Pure preparation. No network calls, credential reads or installation side effects."""
import copy
import json
import pathlib
import re

ROLES = {'commerce_runtime': 'commerce_app', 'admin_runtime': 'admin_app',
         'admin_publish_runtime': 'admin_publisher', 'admin_operator_login': 'admin_operator',
         'media_runtime': 'media_worker'}
IMAGES = {'postgres', 'commerce', 'site', 'admin', 'worker', 'decoder', 'gateway', 'aws'}
REPOSITORIES = {'postgres': 'postgres', 'gateway': 'nginx',
                'commerce': 'ghcr.io/artgurianov/mikluha-commerce',
                'site': 'ghcr.io/artgurianov/mikluha-site-ssr',
                'admin': 'ghcr.io/artgurianov/mikluha-control-room',
                'worker': 'ghcr.io/artgurianov/mikluha-media-worker',
                'decoder': 'ghcr.io/artgurianov/mikluha-media-decoder', 'aws': 'amazon/aws-cli'}
LIMITS = {'postgres': (512, .75, 128), 'commerce': (256, .25, 48),
          'site': (512, .5, 64), 'admin-api': (256, .25, 48),
          'admin': (128, .25, 32), 'worker': (256, .25, 16),
          'decoder': (512, .5, 32), 'gateway': (128, .25, 32)}


def validate(c, ready=False):
    if c.get('format') != 'mikluha.phase-a/1' or c.get('scope') not in ('acceptance', 'working'):
        raise ValueError('invalid scope/format')
    scope = c['scope']
    if not re.fullmatch(r'[0-9a-f]{40}', c.get('source_commit', '')) or c.get('schema_head') != 19:
        raise ValueError('source/schema must be qualified')
    if c.get('controller') != 'coolify-raw-compose' or set(c.get('images', {})) != IMAGES:
        raise ValueError('controller/image contract')
    b = c['backup']
    if b['endpoint'] != 'https://s3.cloud.ru' or b['region'] != 'ru-central-1':
        raise ValueError('provider endpoint')
    if b['prefix'] != f'mikluha/native-phase-a/{scope}/v1/':
        raise ValueError('backup scope must not overlap')
    if (b['hourly_minute'],b['remote_days'],b['max_age_seconds'],b['max_dump_bytes'],b.get('retention_authority')) != (37,7,7200,64*1024**2,'provider-lifecycle'):
        raise ValueError('Phase A cloud-only retention/resource contract')
    if any(k in b for k in ('local_hours','local_budget_bytes','offhost_max_age_seconds','offhost_local_days','offhost_budget_bytes')):
        raise ValueError('removed local/Mac replication policy must not be silently reused')
    if b.get('versioning') != 'Enabled' or type(b.get('noncurrent_days')) is not int or b['noncurrent_days'] != 7:
        raise ValueError('enabled versioning and provider-owned noncurrent expiry required')
    if c.get('ports') != {'admin': 18443 if scope == 'acceptance' else 18543,
                          'site': 18443 if scope == 'acceptance' else 18543}:
        raise ValueError('only fixed loopback ports')
    missing = []
    for name in ('privileges_sha256', 'database_generation'):
        pattern = r'[0-9a-f]{64}' if name == 'privileges_sha256' else r'[A-Za-z0-9._-]{1,64}'
        if not isinstance(c.get(name), str) or not re.fullmatch(pattern, c[name]):
            missing.append(name + ':independent qualification')
    if not isinstance(c.get("schema_journal_sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", c["schema_journal_sha256"]):
        missing.append("qualified schema journal fingerprint")
    for role in sorted(IMAGES):
        value = c['images'][role]
        if value is None:
            missing.append('image:' + role)
        elif not re.fullmatch(re.escape(REPOSITORIES[role]) + r'@sha256:[0-9a-f]{64}', value):
            raise ValueError('immutable image repository/digest required')
    if not c.get('source_main_verified'):
        missing.append('main source/required legal changes/CI receipt')
    if not isinstance(c.get('application_uuid'), str) or not re.fullmatch(r'[a-z0-9]{20,32}', c['application_uuid']):
        missing.append('Coolify application identity')
    source = c.get('compose_source') or {}
    if (source.get('qualification') != 'PASS'
            or source.get('repository') != 'ArtGurianov/mikluha'
            or not isinstance(source.get('commit'), str) or not re.fullmatch(r'[0-9a-f]{40}', source['commit'])
            or source.get('path') != f'/config/mikluha-phase-a/{scope}.compose.json'
            or not isinstance(source.get('file_sha256'), str) or not re.fullmatch(r'[0-9a-f]{64}', source['file_sha256'])
            or not isinstance(source.get('evidence'), str) or not source['evidence']):
        missing.append('qualified Git Compose source/read-back')
    if not isinstance(b.get('bucket'), str) or not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]', b['bucket']):
        missing.append('dedicated qualified backup bucket')
    if not b.get('policy_enrolled') or not isinstance(b.get('owner_canonical_id'), str) or not re.fullmatch(r'[A-Za-z0-9:_-]{1,256}', b['owner_canonical_id']):
        missing.append('independently enrolled bucket owner/policy')
    if not isinstance(b.get('allowed_principals'), list) or any(not isinstance(x, str) or not x or '*' in x for x in b.get('allowed_principals', [])):
        missing.append('exact bucket principal allowlist')
    if b.get('lifecycle') != lifecycle(c):
        missing.append('qualified provider-owned lifecycle configuration')
    if not isinstance(b.get('recipient'), str) or not re.fullmatch(r'age1[0-9a-z]{58}', b['recipient']):
        missing.append('off-host-qualified age public recipient')
    for key in ('secret_authority', 'restriction_authority'):
        obj = c.get(key, {})
        if not isinstance(obj.get('generation'), str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,64}', obj['generation']):
            missing.append(key + ':generation')
        if not isinstance(obj.get('offhost_reference'), str) or not obj['offhost_reference'].startswith('private-custody:'):
            missing.append(key + ':independent offhost reference')
    if ready and (missing or c.get('admission') != 'READY_FOR_OWNER_REVIEW'):
        raise ValueError('candidate not installable: missing qualification inputs')
    return missing


def lifecycle(c):
    return {'Rules': [{'ID': 'mikluha-phase-a-' + c['scope'], 'Status': 'Enabled',
                      'Filter': {'Prefix': c['backup']['prefix']}, 'Expiration': {'Days': 7},
                      'NoncurrentVersionExpiration': {'NoncurrentDays': 7}}]}


def compose(c):
    """Review output accepts null images as explicit fail-closed Compose variables."""
    validate(c)
    scope = c['scope']
    name = 'mikluha-phase-a-' + scope
    root = '/etc/mikluha-native/' + scope
    images = {k: v or '${MIKLUHA_' + k.upper() + '_IMAGE:?qualified digest required}'
              for k, v in c['images'].items()}
    services = {}

    def service(key, image, nets, command=None):
        ram, cpu, pids = LIMITS[key]
        s = {'image': images[image], 'restart': 'unless-stopped', 'init': True,
             'mem_limit': str(ram) + 'm', 'cpus': cpu, 'pids_limit': pids,
             'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'],
             'read_only': True, 'tmpfs': ['/tmp:size=16m,mode=1777,noexec,nosuid,nodev'],
             'stop_grace_period': '180s',
             'labels': {'traefik.enable': 'false', 'coolify.managed': 'true', 'coolify.type': 'application',
                        'coolify.applicationId': c['application_uuid'] or '${MAA_APPLICATION_UUID:?Coolify UUID required}',
                        'io.mikluha.scope': scope, 'io.mikluha.component': key,
                        'io.mikluha.source': c['source_commit'],
                        'io.mikluha.secret-generation': c['secret_authority']['generation'] or '${MAA_SECRET_GENERATION:?qualified generation required}'},
             'logging': {'driver': 'local', 'options': {'max-size': '5m', 'max-file': '3'}}}
        if nets is not None:
            s['networks'] = nets
        if command:
            s['command'] = command
        services[key] = s
        return s

    pg = service('postgres', 'postgres', ['db'])
    # Official image entrypoint needs root SETUID/SETGID/CHOWN; no privileged mode.
    pg['labels'].pop('io.mikluha.source')
    pg['labels'].pop('io.mikluha.secret-generation')
    pg['labels']['io.mikluha.database-generation'] = c.get('database_generation') or '${MAA_DATABASE_GENERATION:?stable DB generation required}'
    pg['cap_add'] = ['CHOWN', 'FOWNER', 'DAC_OVERRIDE', 'SETGID', 'SETUID']
    pg['read_only'] = False
    pg['environment'] = {'POSTGRES_DB': 'mikluha', 'POSTGRES_USER': 'postgres',
                         'POSTGRES_PASSWORD': '${MAA_POSTGRES_PASSWORD:?Coolify secret required}',
                         'POSTGRES_INITDB_ARGS': '--auth-host=scram-sha-256 --auth-local=scram-sha-256'}
    pg['volumes'] = ['pg-data:/var/lib/postgresql/data']
    pg['command'] = ['postgres', '-c', 'max_connections=40', '-c', 'shared_buffers=128MB',
                     '-c', 'log_statement=none', '-c', 'log_min_error_statement=panic']
    pg['tmpfs'] += ['/var/run/postgresql:size=8m,mode=3775']
    pg['healthcheck'] = {'test': ['CMD-SHELL', 'pg_isready -U postgres -d mikluha'],
                         'interval': '10s', 'timeout': '3s', 'retries': 10}
    for key in ('commerce', 'admin-api'):
        s = service(key, 'commerce', ['db', 'public' if key == 'commerce' else 'admin'])
        if key == 'commerce':
            s['environment'] = {'DATABASE_URL': '${MAA_COMMERCE_DATABASE_URL:?Coolify secret required}',
                'COMMERCE_ENVIRONMENT': 'PRODUCTION', 'CONTENT_DIR': '/app/content',
                'COMMERCE_ORIGIN': 'https://book.mikluha-maklai.ru', 'SITE_ORIGIN': 'https://mikluha-maklai.ru',
                'NOTISEND_API_KEY': 'phase-a-disabled', 'NOTISEND_FROM_EMAIL': 'disabled@example.invalid',
                'NOTISEND_FROM_NAME': 'Phase A disabled mail'}
        else:
            s['environment'] = {k: '${MAA_' + k + ':?Coolify secret required}' for k in
                ['ADMIN_DATABASE_URL', 'ADMIN_PUBLISH_DATABASE_URL', 'ADMIN_TOTP_KEY', 'ADMIN_AUDIT_KEY', 'ADMIN_AUDIT_KEY_ID']}
            s['environment']['ADMIN_AUDIT_PREVIOUS_KEYS'] = '${MAA_ADMIN_AUDIT_PREVIOUS_KEYS:?explicit key history required}'
            # Standard external HTTPS port: the Control Room proxy passes $host without a port.
            s['environment']['ADMIN_ORIGIN'] = 'https://admin.' + scope + '.mikluha.test'
        if key == 'admin-api':
            s['command'] = ['node', 'dist/bin/admin-api.js']
        s['depends_on'] = {'postgres': {'condition': 'service_healthy'}}
    site = service('site', 'site', ['public'])
    site['environment'] = {'COMMERCE_PUBLIC_API_URL': 'http://commerce:3000', 'MEDIA_DELIVERY': 'direct'}
    admin = service('admin', 'admin', ['admin'])
    admin['cap_add'] = ['CHOWN', 'SETGID', 'SETUID', 'NET_BIND_SERVICE']
    admin['read_only'] = False  # upstream nginx envsubst writes the rendered config
    admin['environment'] = {'ADMIN_API_UPSTREAM': 'admin-api:3000'}
    gateway = service('gateway', 'gateway', None)
    # Published loopback ports are discarded on internal-only Docker endpoints.
    # Only the gateway joins ingress; backends keep their internal-only networks.
    gateway['networks'] = {'admin': {}, 'public': {}, 'ingress': {'gw_priority': 1}}
    gateway['cap_add'] = ['CHOWN', 'SETGID', 'SETUID', 'NET_BIND_SERVICE']
    gateway['ports'] = [f"127.0.0.1:{c['ports']['admin']}:443"]
    gateway['volumes'] = [root + '/gateway.conf:/etc/nginx/nginx.conf:ro',
                           root + '/tls:/run/tls:ro']
    gateway['command'] = ['nginx', '-g', 'daemon off;']
    gateway['entrypoint'] = ['nginx', '-g', 'daemon off;']
    gateway.pop('command')
    gateway['tmpfs'] += ['/var/cache/nginx:size=8m,mode=1777', '/var/run:size=1m,mode=1777']
    if scope == 'acceptance':
        w = service('worker', 'worker', ['db', 'media-egress'])
        w['environment'] = {k: '${MAA_' + k + ':?Coolify secret required}' for k in
            ['MEDIA_DATABASE_URL', 'MEDIA_S3_ENDPOINT', 'MEDIA_S3_REGION', 'MEDIA_S3_BUCKET',
             'MEDIA_S3_PUBLIC_ORIGIN', 'MEDIA_S3_PRINCIPAL_ARN', 'MEDIA_S3_ACCESS_KEY_ID', 'MEDIA_S3_SECRET_ACCESS_KEY']}
        w['volumes'] = ['decoder-socket:/run/media-decoder:ro']
        w['healthcheck'] = {'disable': True}
        d = service('decoder', 'decoder', None)
        d['network_mode'] = 'none'
        d['volumes'] = ['decoder-socket:/run/media-decoder']
        d['tmpfs'] = ['/tmp:size=64m,mode=1777,noexec,nosuid,nodev']
        d['healthcheck'] = {'disable': True}
        w['depends_on'] = {'postgres': {'condition': 'service_healthy'}, 'decoder': {'condition': 'service_started'}}
    result = {'name': name, 'services': services,
              'networks': {k: {'name': name + '-' + k, 'internal': True} for k in ('db', 'public', 'admin')},
              'volumes': {'pg-data': {'name': name + '-pg-data'}}}
    result['networks']['ingress'] = {'name': name + '-ingress'}
    if scope == 'acceptance':
        result['networks']['media-egress'] = {'name': name + '-media-egress'}
        result['volumes']['decoder-socket'] = {'name': name + '-decoder-socket'}
    # Coolify4.5.3 oldRawParser appends list labels even when given a mapping.
    # Emit the supported sequence form so its management labels cannot introduce
    # integer keys into a mapping and make Docker Compose reject the definition.
    for item in services.values():
        item['labels'] = [key + '=' + str(value) for key, value in item['labels'].items()]
    return result


def working(c):
    c = copy.deepcopy(c)
    c.update(scope='working', application_uuid=None, database_generation=None, admission='NOT_READY')
    c['compose_source'] = {'qualification': 'NOT_RUN'}
    c['ports'] = {'admin': 18543, 'site': 18543}
    c['backup']['prefix'] = 'mikluha/native-phase-a/working/v1/'
    for field in ('bucket', 'recipient', 'owner_canonical_id', 'policy', 'allowed_principals', 'lifecycle'):
        c['backup'][field] = None
    c['backup']['policy_enrolled'] = False
    c['secret_authority'] = {'generation': None, 'offhost_reference': None}
    c['restriction_authority'] = {'generation': None, 'offhost_reference': None}
    return c
