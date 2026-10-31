"""Scoped logical backup core. Only nonsecret job status persists on VPS; archive retention is Cloud.ru-only."""
import datetime as dt
import fcntl
import hashlib
import io
import json
import os
import pathlib
import re
import stat
import subprocess
import tarfile
import uuid

MAX = 64 * 1024**2
SUFFIX = r'\d{8}T\d{6}Z-[0-9a-f]{32}\.(?:tar\.age|manifest\.json)'


def run(args, data=None, timeout=180):
    p = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if p.returncode or len(p.stdout) > MAX + 1024**2:
        raise RuntimeError('operation failed; confidential output suppressed')
    return p.stdout


def stamp():
    return dt.datetime.now(dt.timezone.utc)


def encoded(v):
    return (json.dumps(v, sort_keys=True, separators=(',', ':')) + '\n').encode()


def atomic(path, data):
    if path.is_symlink() or path.parent.resolve() != path.parent:
        raise ValueError('unsafe state path')
    temp = path.with_name('.' + path.name + '-' + uuid.uuid4().hex)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        temp.unlink(missing_ok=True)


def capture(c, inspect, dump):
    """Generation checked both sides. Inspect returns only allowlisted nonsecret metadata."""
    before = inspect()
    if (before.get('scope') != c['scope'] or before.get('source_commit') != c['source_commit']
        or before.get('schema_head') != c['schema_head'] or before.get('sales_open') is not False
        or before.get('role_contract') != 'PASS'
        or before.get('privileges_sha256') != c['privileges_sha256']
        or before.get('database_generation') != c['database_generation']):
        raise ValueError('database/generation/role admission')
    data = dump()
    if not data.startswith(b'PGDMP') or len(data) > MAX:
        raise ValueError('invalid/oversize pg_dump')
    if before != inspect():
        raise ValueError('database/schema/key authority changed during dump')
    meta = {'format': 'mikluha.phase-a-backup/1', 'created_at': stamp().isoformat(),
            'scope': c['scope'], 'source_commit': c['source_commit'], 'schema_head': c['schema_head'],
            'postgres_digest': c['images']['postgres'], 'commerce_digest': c['images']['commerce'],
            'database': before, 'secret_authority': c['secret_authority'],
            'restriction_authority_at_capture': c['restriction_authority'],
            'privileges_sha256': c['privileges_sha256'], 'database_generation': c['database_generation'],
            'dump_bytes': len(data), 'dump_sha256': hashlib.sha256(data).hexdigest()}
    stream = io.BytesIO()
    # Dump preserves ACL/owners; scoped NOLOGIN/logins must be recreated BEFORE pg_restore.
    with tarfile.open(fileobj=stream, mode='w') as t:
        for name, body in [('database.dump', data), ('metadata.json', encoded(meta))]:
            entry = tarfile.TarInfo(name); entry.size = len(body); entry.mode = 0o600
            t.addfile(entry, io.BytesIO(body))
    return stream.getvalue(), meta


def encrypt(clear, recipient, command=run):
    if not re.fullmatch(r'age1[0-9a-z]{58}', recipient):
        raise ValueError('invalid public recipient')
    body = command(['age', '-r', recipient], clear)
    if not body.startswith(b'age-encryption.org/v1\n') or len(body) > MAX + 1024**2:
        raise ValueError('ciphertext envelope/size required')
    return body


def object_pattern(c):
    expected = f"mikluha/native-phase-a/{c['scope']}/v1/"
    if c['scope'] not in ('acceptance', 'working') or c['backup']['prefix'] != expected:
        raise ValueError('owned backup prefix required')
    return re.compile(re.escape(expected) + SUFFIX)


def publish(c, provider, cipher, meta, state):
    if not cipher.startswith(b'age-encryption.org/v1\n') or len(cipher) > MAX + 1024**2:
        raise ValueError('refuse clear/oversize payload')
    name = dt.datetime.fromisoformat(meta['created_at']).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex
    base = c['backup']['prefix'] + name
    key = base + '.tar.age'
    if not object_pattern(c).fullmatch(key):
        raise ValueError('invalid object key')
    provider.put(key, cipher)
    if provider.get(key) != cipher:
        raise ValueError('independent ciphertext GET mismatch')
    manifest = {'format': meta['format'], 'scope': c['scope'], 'created_at': meta['created_at'],
                'object': key, 'ciphertext_bytes': len(cipher),
                'ciphertext_sha256': hashlib.sha256(cipher).hexdigest(),
                'source_commit': meta['source_commit'], 'database': meta['database'],
                'secret_generation': c['secret_authority']['generation']}
    blob = encoded(manifest)
    provider.put(base + '.manifest.json', blob)
    if provider.get(base + '.manifest.json') != blob:
        raise ValueError('independent manifest GET mismatch')
    receipt = dict(manifest, manifest_object=base + '.manifest.json',
                   verified_at=stamp().isoformat(),
                   result='PASS', recovery='NOT_RUN')
    atomic(state / 'last-success.json', encoded(receipt))
    return receipt


def verify(c, provider, manifest_key, incident_before, decrypt):
    selection=manifest_key if isinstance(manifest_key,dict) else None
    if selection is not None:
        if set(selection)!={'manifest','cipher'}:raise ValueError('version pair required')
        manifest_key=selection['manifest']['Key']
    if not object_pattern(c).fullmatch(manifest_key) or not manifest_key.endswith('.manifest.json'):
        raise ValueError('unowned manifest')
    from maa_recovery import owner_cutoff, checked_head
    cutoff=owner_cutoff(incident_before)
    manifest_ref=selection['manifest'] if selection else manifest_key
    manifest_head=checked_head(c,provider,manifest_ref,cutoff)
    blob = provider.get(manifest_ref, expected=manifest_head)
    m = json.loads(blob)
    key = manifest_key.removesuffix('.manifest.json') + '.tar.age'
    if (m.get('object') != key or m.get('scope') != c['scope']
        or m.get('format') != 'mikluha.phase-a-backup/1'
        or m.get('source_commit') != c['source_commit']
        or m.get('secret_generation') != c['secret_authority']['generation']):
        raise ValueError('manifest identity')
    cipher_ref=selection['cipher'] if selection else key
    if selection and cipher_ref['Key']!=key:raise ValueError('versioned cipher key mismatch')
    cipher_head=checked_head(c,provider,cipher_ref,cutoff)
    cipher = provider.get(cipher_ref, expected=cipher_head)
    if len(cipher) != m['ciphertext_bytes'] or hashlib.sha256(cipher).hexdigest() != m['ciphertext_sha256']:
        raise ValueError('ciphertext integrity')
    clear = decrypt(cipher)
    if len(clear) > MAX + 1024**2:
        raise ValueError('decrypted envelope too large')
    with tarfile.open(fileobj=io.BytesIO(clear), mode='r:') as t:
        members = t.getmembers()
        if sorted(x.name for x in members) != ['database.dump', 'metadata.json'] or any(not x.isfile() for x in members):
            raise ValueError('unsafe archive members')
        dump = t.extractfile('database.dump').read(MAX + 1)
        meta = json.loads(t.extractfile('metadata.json').read(128 * 1024))
    if (not dump.startswith(b'PGDMP') or len(dump) != meta['dump_bytes'] or len(dump) > MAX
        or hashlib.sha256(dump).hexdigest() != meta['dump_sha256']
        or meta['scope'] != c['scope'] or meta['source_commit'] != m['source_commit']
        or meta['created_at'] != m['created_at'] or meta['database'] != m['database'] or meta['schema_head'] != c['schema_head']
        or meta['postgres_digest'] != c['images']['postgres']
        or meta['commerce_digest'] != c['images']['commerce']
        or meta['secret_authority'] != c['secret_authority']
        or meta['privileges_sha256'] != c['privileges_sha256']
        or meta['database_generation'] != c['database_generation']):
        raise ValueError('archive metadata/dump mismatch')
    # This only qualifies retrieval/decryption, never restore/cryptography/reconciliation.
    # LastModified/cutoff is a trusted-provider time filter, NOT sender authentication.
    evidence={'incident_before':cutoff.isoformat(), 'manifest_object':manifest_key,
              'manifest_last_modified':manifest_head['LastModified'],
              'cipher_last_modified':cipher_head['LastModified'],
              'manifest_sha256':hashlib.sha256(blob).hexdigest(),
              'trust':'PROVIDER_METADATA_NOT_INDEPENDENT_AUTHENTICATION'}
    if selection:
        evidence.update(manifest_version_id=manifest_head['VersionId'],cipher_version_id=cipher_head['VersionId'])
    return dump, dict(meta, retrieval=evidence)


def freshness(c, state, now=None):
    now = now or stamp()
    m = json.loads((state / 'last-success.json').read_text())
    age = (now - dt.datetime.fromisoformat(m['created_at'])).total_seconds()
    failure = state / 'last-failure.json'
    if (m.get('result') != 'PASS' or m.get('scope') != c['scope']
        or m.get('source_commit') != c['source_commit']
        or m.get('secret_generation') != c['secret_authority']['generation']
        or not 0 <= age <= c['backup']['max_age_seconds']):
        raise ValueError('stale/wrong-generation backup')
    if failure.exists() and failure.stat().st_mtime_ns >= (state / 'last-success.json').stat().st_mtime_ns:
        raise ValueError('latest backup failed')
    return {'result': 'PASS', 'age_seconds': int(age), 'recovery': 'NOT_ATTESTED_BY_FRESHNESS'}


def checked_freshness(c, state, lock):
    """Observe immutable receipts even while producer owns the lock. Never mask staleness."""
    running = False
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        running = True
    return dict(freshness(c, state), producer='RUNNING' if running else 'IDLE')
