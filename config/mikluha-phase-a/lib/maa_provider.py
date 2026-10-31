"""AWS CLI in a digest-pinned, bounded container. Only ciphertext/manifest files touch disk."""
import json
import os
import pathlib
import re
import stat
import subprocess
import uuid
from maa_backup import MAX, object_pattern


class ProviderError(RuntimeError):
    pass


class AwsProvider:
    def __init__(self, c, credentials, scratch, command=subprocess.run, docker=None, check=None, read_only=False):
        self.read_only = read_only
        self.docker = list(docker) if docker is not None else ['docker', '--host', 'unix:///var/run/docker.sock']
        self.check = check or (lambda: None)
        self.c, self.credentials, self.scratch, self.command = c, pathlib.Path(credentials), pathlib.Path(scratch), command
        if not re.fullmatch(r'amazon/aws-cli@sha256:[0-9a-f]{64}', c['images']['aws']):
            raise ValueError('pinned AWS tool image required')
        for p, mode in [(self.credentials, 0o600), (self.scratch, 0o700)]:
            st = p.lstat()
            if p.is_symlink() or p.resolve() != p or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != mode:
                raise ValueError('private credential/scratch ownership/mode')
        if not self.credentials.is_file() or not self.scratch.is_dir():
            raise ValueError('private paths')

    def call(self, action, *args, no_policy=False):
        allowed = {'get-bucket-versioning', 'get-bucket-acl', 'get-bucket-policy', 'get-bucket-lifecycle-configuration', 'list-objects-v2', 'head-object', 'get-object'}
        if not self.read_only: allowed.add('put-object')
        if self.read_only: allowed.add('list-object-versions')
        if action not in allowed:
            raise ValueError('provider action exceeds producer/verifier authority')
        b = self.c['backup']
        self.check()
        cmd = [*self.docker, 'run', '--rm', '--read-only', '--network', 'bridge',
               '--memory', '256m', '--cpus', '.25', '--pids-limit', '32',
               '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
               '--tmpfs', '/tmp:size=16m,mode=1777,noexec,nosuid,nodev',
               '--mount', f'type=bind,source={self.credentials},target=/run/credentials,readonly',
               '--mount', f'type=bind,source={self.scratch},target=/run/transfer',
               '-e', 'AWS_SHARED_CREDENTIALS_FILE=/run/credentials', '-e', 'AWS_CONFIG_FILE=/dev/null',
               '-e', 'AWS_EC2_METADATA_DISABLED=true',
               '-e', 'AWS_REQUEST_CHECKSUM_CALCULATION=when_required',
               '-e', 'AWS_RESPONSE_CHECKSUM_VALIDATION=when_required', '-e', 'AWS_PROFILE=default',
               self.c['images']['aws'], '--endpoint-url', b['endpoint'], '--region', b['region'],
               '--cli-connect-timeout', '5', '--cli-read-timeout', '90',
               '--no-cli-pager', '--output', 'json', 's3api', action, '--bucket', b['bucket'], *args]
        # Deliberately omit caller AWS_* and Docker routing overrides from the child environment.
        env = {k: os.environ[k] for k in ('PATH', 'HOME') if k in os.environ}
        p = self.command(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180, env=env)
        if p.returncode:
            if no_policy and b'(NoSuchBucketPolicy)' in p.stderr:
                return None
            raise ProviderError('provider command failed; output suppressed')
        if len(p.stdout) > 2 * 1024**2:
            raise ProviderError('oversize provider metadata')
        return json.loads(p.stdout or b'{}')

    def assert_configuration(self):
        v = self.call('get-bucket-versioning')
        if self.c['backup'].get('versioning') != 'Enabled' or v.get('Status') != 'Enabled':
            raise ValueError('enabled bucket versioning required')
        acl = self.call('get-bucket-acl')
        b = self.c['backup']
        owner = b.get('owner_canonical_id')
        if not owner or acl.get('Owner', {}).get('ID') != owner:
            raise ValueError('bucket owner mismatch')
        grants = acl.get('Grants', [])
        if len(grants) != 1 or grants[0].get('Permission') != 'FULL_CONTROL' or grants[0].get('Grantee', {}).get('Type') != 'CanonicalUser' or grants[0]['Grantee'].get('ID') != owner:
            raise ValueError('foreign/redundant/public bucket ACL grant')
        response = self.call('get-bucket-policy', no_policy=True)
        actual = json.loads(response['Policy']) if response is not None else None
        if not b.get('policy_enrolled') or actual != b.get('policy'):
            raise ValueError('bucket policy differs from independently reviewed enrollment')
        if actual is not None:
            statements = actual.get('Statement', [])
            if not isinstance(statements, list): statements = [statements]
            allowed = set(b.get('allowed_principals') or [])
            actions = {'s3:GetObject','s3:GetObjectVersion','s3:PutObject','s3:ListBucket','s3:ListBucketVersions','s3:GetBucketAcl',
                       's3:GetBucketPolicy','s3:GetBucketVersioning','s3:GetLifecycleConfiguration',
                       's3:GetBucketLifecycleConfiguration'}  # Cloud.ru's observed read action
            resources = {'arn:aws:s3:::' + b['bucket'], 'arn:aws:s3:::' + b['bucket'] + '/' + b['prefix'] + '*'}
            for statement in statements:
                if statement.get('Effect') == 'Deny': continue
                # Cloud.ru GET materializes these exact empty defaults. Keep the
                # raw enrollment equality above; only strip inert provider fields
                # for the independent Allow-grant boundary check below.
                statement = dict(statement)
                for key, empty in [('NotPrincipal', {}), ('NotAction', []), ('NotResource', [])]:
                    if key in statement:
                        if statement[key] != empty:
                            raise ValueError('nonempty/invalid alternate Allow policy field')
                        del statement[key]
                if statement.get('Effect') != 'Allow' or set(statement)-{'Sid','Effect','Principal','Action','Resource','Condition'}:
                    raise ValueError('unqualified policy grant shape')
                principal = statement.get('Principal')
                if not isinstance(principal, dict) or set(principal) != {'AWS'}:
                    raise ValueError('unqualified/public policy principal')
                for values, permitted in [(principal['AWS'], allowed), (statement.get('Action'), actions), (statement.get('Resource'), resources)]:
                    values = values if isinstance(values, list) else [values]
                    if not values or any(not isinstance(x,str) or x not in permitted for x in values):
                        raise ValueError('foreign principal/action/resource in policy')
        lifecycle = self.call('get-bucket-lifecycle-configuration')
        if {'Rules': lifecycle.get('Rules')} != b.get('lifecycle'):
            raise ValueError('provider expiration not enrolled/mismatched')

    def key(self, key):
        if not object_pattern(self.c).fullmatch(key):
            raise ValueError('object outside owned backup namespace')

    def reference(self, ref):
        if isinstance(ref, str):
            self.key(ref)
            return ref, []
        if not isinstance(ref, dict) or set(ref) != {'Key', 'VersionId'}:
            raise ValueError('exact version reference required')
        self.key(ref['Key'])
        version = ref['VersionId']
        if not isinstance(version, str) or not version or len(version) > 1024 or any(ord(x) < 32 for x in version):
            raise ValueError('invalid version ID')
        return ref['Key'], ['--version-id', version]

    def put(self, key, body):
        self.key(key)
        if len(body) > MAX + 1024**2:
            raise ValueError('oversized object')
        path = self.scratch / ('.upload-' + uuid.uuid4().hex)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, 'wb') as f:
                f.write(body)
            self.call('put-object', '--key', key, '--body', '/run/transfer/' + path.name, '--if-none-match', '*')
        finally:
            path.unlink(missing_ok=True)

    def head(self, key):
        name, args = self.reference(key)
        h=self.call('head-object','--key',name,*args)
        if (not isinstance(h.get('ContentLength'),int) or not 0<=h['ContentLength']<=MAX+1024**2
            or not isinstance(h.get('ETag'),str) or not h['ETag'] or not isinstance(h.get('LastModified'),str)):
            raise ValueError('incomplete/oversized provider metadata')
        if not isinstance(h.get('VersionId'),str) or not h['VersionId'] or (args and h['VersionId'] != key['VersionId']):
            raise ValueError('missing/wrong provider version')
        return {k:h[k] for k in ('ContentLength','ETag','LastModified','VersionId')}

    def get(self, key, expected=None):
        name, _ = self.reference(key)
        head = self.head(key)
        if expected is not None and head!=expected:
            raise ValueError('provider metadata changed before conditional GET')
        pinned = {'Key': name, 'VersionId': head['VersionId']}
        _, args = self.reference(pinned)
        path = self.scratch / ('.download-' + uuid.uuid4().hex)
        try:
            result=self.call('get-object','--key',name,*args,'--if-match',head['ETag'],'/run/transfer/'+path.name)
            if any(result.get(k)!=head[k] for k in ('ETag','LastModified','ContentLength','VersionId')) or self.head(pinned)!=head:
                raise ValueError('provider metadata changed during conditional GET')
            if path.is_symlink() or path.stat().st_size!=head['ContentLength']:
                raise ValueError('remote readback length/path')
            return path.read_bytes()
        finally:
            path.unlink(missing_ok=True)

    def records(self, prefix=None):
        if prefix is not None:
            self.key(prefix + '.manifest.json')
        token, rows, seen = None, [], set()
        for _ in range(100):
            # Backup keys are flat; nested qualification namespaces are not backups.
            args = ['--prefix', prefix or self.c['backup']['prefix'], '--delimiter', '/', '--max-keys', '1000', '--no-paginate']
            if token:
                args += ['--key-marker', token[0]]
                if token[1]: args += ['--version-id-marker', token[1]]
            response = self.call('list-object-versions', *args)
            rows += response.get('Versions', [])
            rows += [dict(r, DeleteMarker=True) for r in response.get('DeleteMarkers', [])]
            if not response.get('IsTruncated'):
                identities = set()
                for row in rows:
                    self.reference({'Key':row['Key'],'VersionId':row.get('VersionId')})
                    identity = (row['Key'],row['VersionId'])
                    if identity in identities: raise ValueError('duplicate version listing')
                    identities.add(identity)
                    if not isinstance(row.get('LastModified'),str) or not isinstance(row.get('ETag'),str):
                        if not row.get('DeleteMarker') or not isinstance(row.get('LastModified'),str):
                            raise ValueError('provider listing metadata required')
                return rows
            next_token = (response.get('NextKeyMarker'),response.get('NextVersionIdMarker'))
            if not isinstance(next_token[0], str) or not next_token[0] or (next_token[1] is not None and not isinstance(next_token[1],str)) or next_token in seen:
                raise ValueError('invalid pagination')
            seen.add(next_token)
            token = next_token
        raise ValueError('listing cap exceeded')
