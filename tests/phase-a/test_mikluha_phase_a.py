"""Pure/failure contracts for the proposed package; these are not provider/install receipts."""
import copy
import datetime as dt
import hashlib
import importlib.util
import io
import json
import pathlib
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'config/mikluha-phase-a/lib'))
import maa_backup as b
import maa_plan as p
from maa_provider import AwsProvider


def candidate():
    return json.loads((ROOT / 'config/mikluha-phase-a/candidate.json').read_text())


def qualified():
    c = candidate()
    c.update(source_main_verified=True, application_uuid='a' * 24, admission='READY_FOR_OWNER_REVIEW', schema_journal_sha256='a' * 64, privileges_sha256='a'*64, database_generation='fixture-db-1')
    c['compose_source'] = {'qualification': 'PASS', 'repository': 'ArtGurianov/mikluha',
                           'commit': 'a' * 40, 'path': '/config/mikluha-phase-a/acceptance.compose.json',
                           'file_sha256': 'a' * 64, 'evidence': 'synthetic fixture, not a deployment receipt'}
    c['images'] = {k: repo + '@sha256:' + 'a' * 64 for k, repo in p.REPOSITORIES.items()}
    c['backup'].update(bucket='dedicated-test-backup', recipient='age1' + 'a' * 58, owner_canonical_id='expected-owner', policy=None, policy_enrolled=True, allowed_principals=[], lifecycle=p.lifecycle(c))
    for name in ('secret_authority', 'restriction_authority'):
        c[name] = {'generation': 'test-1', 'offhost_reference': 'private-custody:test-only'}
    return c


class Provider:
    def __init__(self):
        self.modified=(b.stamp()-dt.timedelta(seconds=5)).isoformat()
        self.data = {}; self.corrupt = False
    def put(self, key, body):
        if key in self.data:
            raise ValueError('immutable conflict')
        self.data[key] = body
    def head(self,key):
        data=self.data[key]
        return {'ContentLength':len(data),'ETag':hashlib.sha256(data).hexdigest(),'LastModified':self.modified}
    def get(self, key, expected=None):
        if expected is not None and expected!=self.head(key):raise ValueError('provider metadata changed')
        return b'corrupt' if self.corrupt else self.data[key]
    def records(self):
        return [dict(Key=k,**self.head(k)) for k in self.data]


class Plans(unittest.TestCase):
    def test_checked_in_candidate_has_no_real_installation_or_key_authority(self):
        c = candidate()
        for key in ['application_uuid', 'database_generation']:
            self.assertIsNone(c[key])
        for name in ['secret_authority', 'restriction_authority']:
            self.assertEqual(c[name], {'generation': None, 'offhost_reference': None})
        for key in ['bucket', 'recipient', 'owner_canonical_id', 'policy', 'lifecycle']:
            self.assertIsNone(c['backup'][key])
        self.assertEqual(c['backup']['allowed_principals'], [])
        self.assertFalse(c['backup']['policy_enrolled'])
        self.assertIsNone(c['compose_source']['commit'])
        self.assertEqual(c['compose_source']['repository'], 'ArtGurianov/mikluha')

    def test_default_has_no_install_authority(self):
        c = candidate()
        missing = p.validate(c)
        self.assertIn('qualified Git Compose source/read-back', missing)
        self.assertEqual(c['admission'], 'NOT_READY')
        with self.assertRaises(ValueError): p.validate(c, ready=True)
        with self.assertRaises(ValueError): p.validate(qualified() | {'admission': 'NO_GO'}, ready=True)
        self.assertEqual(p.validate(qualified(), ready=True), [])

    def test_enrollment_or_ready_label_cannot_admit_missing_git_compose(self):
        for source in [None, {'qualification': 'NOT_RUN'},
                       qualified()['compose_source'] | {'path': '/config/mikluha-phase-a/working.compose.json'},
                       qualified()['compose_source'] | {'repository': 'someone/other-repository'},
                       qualified()['compose_source'] | {'file_sha256': None},
                       qualified()['compose_source'] | {'evidence': ''}]:
            c = qualified() | {'compose_source': source}
            self.assertIn('qualified Git Compose source/read-back', p.validate(c))
            with self.assertRaises(ValueError): p.validate(c, ready=True)
        self.assertEqual(p.working(qualified())['compose_source'], {'qualification': 'NOT_RUN'})

    def test_foreign_scope_image_retention_port_refused(self):
        for patch in [{'scope': 'production'}, {'ports': {'admin': 443, 'site': 80}},
                      {'images': dict(qualified()['images'], postgres='postgres:latest')},
                      {'controller': 'ssh-compose'}]:
            with self.assertRaises(ValueError): p.validate(qualified() | patch, ready=True)
        c = qualified(); c['backup']['prefix'] = 'infrastructure/coolify/control-v1/'
        with self.assertRaises(ValueError): p.validate(c)
        c = qualified(); c['backup']['remote_days'] = 400
        with self.assertRaises(ValueError): p.validate(c)

    def test_networks_caps_ports_and_only_required_credentials(self):
        c = p.compose(candidate()); s = c['services']
        self.assertEqual(s['decoder']['network_mode'], 'none')
        self.assertNotIn('environment', s['decoder'])
        self.assertEqual(set(s['postgres']['networks']), {'db'})
        self.assertEqual(set(s['admin-api']['networks']), {'db', 'admin'})
        self.assertEqual(set(s['commerce']['networks']), {'db', 'public'})
        self.assertNotIn('environment', s['gateway'])
        self.assertEqual(s['gateway']['networks']['ingress'], {'gw_priority': 1})
        self.assertTrue(all('ingress' not in v.get('networks', {}) for k,v in s.items() if k != 'gateway'))
        self.assertEqual(set(s['site']['environment']), {'COMMERCE_PUBLIC_API_URL', 'MEDIA_DELIVERY'})
        self.assertTrue(all(n.get('internal') for k, n in c['networks'].items() if k not in ('media-egress', 'ingress')))
        for key, service in s.items():
            self.assertEqual(service['labels']['traefik.enable'], 'false')
            self.assertNotIn('build', service)
            self.assertNotIn('privileged', service)
            self.assertNotIn('docker.sock', json.dumps(service))
            self.assertIn('mem_limit', service)
            if key != 'gateway': self.assertNotIn('ports', service)
        self.assertTrue(all(v.startswith('127.0.0.1:') for v in s['gateway']['ports']))

    def test_working_is_separate_and_has_no_media_writer(self):
        c = p.working(candidate()); s = p.compose(c)
        self.assertNotIn('worker', s['services'])
        self.assertNotIn('decoder', s['services'])
        self.assertNotIn('media-egress', s['networks'])
        self.assertIsNone(c['secret_authority']['generation'])
        self.assertNotEqual(s['volumes']['pg-data'], p.compose(candidate())['volumes']['pg-data'])
        with self.assertRaises(ValueError): p.validate(c, ready=True)

    def test_review_artifacts_match_generator(self):
        for scope, c in [('acceptance', candidate()), ('working', p.working(candidate()))]:
            self.assertEqual(json.loads((ROOT / f'config/mikluha-phase-a/{scope}.compose.json').read_text()), p.compose(c))


class Backup(unittest.TestCase):
    def setUp(self):
        self.c = qualified()
        self.db = {'scope': 'acceptance', 'source_commit': self.c['source_commit'],
                   'schema_head': 19, 'sales_open': False, 'role_contract': 'PASS', 'privileges_sha256':self.c['privileges_sha256'], 'database_generation':self.c['database_generation'], 'container_id': 'a' * 64}
        self.clear, self.meta = b.capture(self.c, lambda: self.db, lambda: b'PGDMPsynthetic')
        self.cipher = b'age-encryption.org/v1\nfixture-not-real-encryption'

    def test_generation_changed_or_invalid_dump_refused(self):
        for data in [b'plaintext', b'PGDMP' + b'x' * b.MAX]:
            with self.assertRaises(ValueError): b.capture(self.c, lambda: self.db, lambda: data)
        with self.assertRaises(ValueError):
            b.capture(self.c, mock.Mock(side_effect=[self.db, self.db | {'container_id': 'b' * 64}]), lambda: b'PGDMPtest')
        with self.assertRaises(ValueError): b.capture(self.c, lambda: self.db | {'sales_open': True}, lambda: b'PGDMPtest')

    def test_only_ciphertext_and_independent_reads(self):
        with tempfile.TemporaryDirectory() as d:
            provider, state = Provider(), pathlib.Path(d).resolve()
            with self.assertRaises(ValueError): b.publish(self.c, provider, self.clear, self.meta, state)
            r = b.publish(self.c, provider, self.cipher, self.meta, state)
            dump, meta = b.verify(self.c, provider, r['manifest_object'], b.stamp().isoformat(), lambda _: self.clear)
            self.assertEqual(dump, b'PGDMPsynthetic')
            self.assertNotIn('dump_sha256', r)
            self.assertEqual(r['recovery'], 'NOT_RUN')
            self.assertEqual({p.name for p in state.iterdir()},{'last-success.json'})
            provider.data[r['object']] += b'changed'
            with self.assertRaises(ValueError): b.verify(self.c, provider, r['manifest_object'], b.stamp().isoformat(), lambda _: self.clear)

    def test_bad_get_preserves_last_success(self):
        with tempfile.TemporaryDirectory() as d:
            state, provider = pathlib.Path(d).resolve(), Provider()
            (state / 'last-success.json').write_text('previous')
            provider.corrupt = True
            with self.assertRaises(ValueError): b.publish(self.c, provider, self.cipher, self.meta, state)
            self.assertEqual((state / 'last-success.json').read_text(), 'previous')
            self.assertEqual(len(provider.data), 1)

    def test_freshness_generation_failure_and_future(self):
        with tempfile.TemporaryDirectory() as d:
            state = pathlib.Path(d).resolve()
            b.publish(self.c, Provider(), self.cipher, self.meta, state)
            self.assertEqual(b.freshness(self.c, state)['result'], 'PASS')
            with self.assertRaises(ValueError): b.freshness(self.c, state, b.stamp() + dt.timedelta(hours=3))
            with self.assertRaises(ValueError): b.freshness(self.c, state, b.stamp() - dt.timedelta(hours=3))
            changed = copy.deepcopy(self.c); changed['secret_authority']['generation'] = 'next'
            with self.assertRaises(ValueError): b.freshness(changed, state)
            failure = state / 'last-failure.json'
            failure.write_text('latest failure')
            # Equal timestamps occur on real Linux storage; ambiguity must fail closed.
            import os
            timestamp = (state / 'last-success.json').stat().st_mtime_ns
            os.utime(failure, ns=(timestamp, timestamp))
            with self.assertRaises(ValueError): b.freshness(self.c, state)

    def test_restore_checks_qualified_source_images_and_secret_generation(self):
        with tempfile.TemporaryDirectory() as d:
            state, provider = pathlib.Path(d).resolve(), Provider()
            r = b.publish(self.c, provider, self.cipher, self.meta, state)
            for name in ['source', 'image', 'secret-generation', 'secret-reference']:
                changed = copy.deepcopy(self.c)
                if name == 'source': changed['source_commit'] = 'b'*40
                elif name == 'image': changed['images']['postgres'] = 'postgres@sha256:'+'b'*64
                elif name == 'secret-generation': changed['secret_authority']['generation'] = 'other'
                else: changed['secret_authority']['offhost_reference'] = 'private-custody:different'
                with self.assertRaises(ValueError):
                    b.verify(changed, provider, r['manifest_object'], b.stamp().isoformat(), lambda _: self.clear)

    def test_archive_member_traversal(self):
        with tempfile.TemporaryDirectory() as d:
            state, provider = pathlib.Path(d).resolve(), Provider()
            r = b.publish(self.c, provider, self.cipher, self.meta, state)
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode='w') as t:
                entry = tarfile.TarInfo('../../escape'); entry.size = 1
                t.addfile(entry, io.BytesIO(b'x'))
            with self.assertRaises(ValueError): b.verify(self.c, provider, r['manifest_object'], b.stamp().isoformat(), lambda _: data.getvalue())



class AwsContracts(unittest.TestCase):
    def test_credentials_routing_and_nonsecret_diagnostics(self):
        import subprocess
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d).resolve(); root.chmod(0o700)
            cred = root / 'credentials'; cred.write_text('[default]\nfixture only'); cred.chmod(0o600)
            command = mock.Mock(return_value=subprocess.CompletedProcess([], 0, b'{}', b''))
            provider = AwsProvider(qualified(), cred, root, command=command)
            with mock.patch.dict('os.environ', {'AWS_ACCESS_KEY_ID': 'parent-unwanted', 'DOCKER_HOST': 'ssh://unwanted'}):
                provider.call('get-bucket-versioning')
            args, kwargs = command.call_args
            self.assertEqual(args[0][:3], ['docker', '--host', 'unix:///var/run/docker.sock'])
            self.assertNotIn('AWS_ACCESS_KEY_ID', kwargs['env'])
            self.assertNotIn('DOCKER_HOST', kwargs['env'])
            self.assertNotIn('parent-unwanted', str(args))


    def test_foreign_key_and_permissive_credential_file_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d).resolve(); root.chmod(0o700)
            cred = root / 'credentials'; cred.write_text('synthetic'); cred.chmod(0o644)
            with self.assertRaises(ValueError): AwsProvider(qualified(), cred, root)
            cred.chmod(0o600)
            provider = AwsProvider(qualified(), cred, root)
            with self.assertRaises(ValueError): provider.key('other-project/keep')


class HostContracts(unittest.TestCase):
    def test_real_authority_change_is_compared_in_memory_not_recorded(self):
        from maa_host import Database
        c = qualified()
        migrations = [{'v': n, 'f': str(n), 'c': 'f'*64} for n in range(1,20)]
        c['schema_journal_sha256'] = hashlib.sha256(json.dumps(migrations, sort_keys=True).encode()).hexdigest()
        labels = {'io.mikluha.source': c['source_commit'], 'coolify.applicationId': c['application_uuid'],
                  'io.mikluha.secret-generation': c['secret_authority']['generation']}
        import maa_acl
        baseline = [['role','fixture',{}]]
        c['privileges_sha256'] = maa_acl.fingerprint(baseline)
        labels['io.mikluha.database-generation'] = c['database_generation']
        private = 'synthetic-private-material-not-to-be-recorded'
        keys = [k+'='+private for k in ['ADMIN_TOTP_KEY','ADMIN_AUDIT_KEY','ADMIN_AUDIT_KEY_ID','ADMIN_AUDIT_PREVIOUS_KEYS']]
        def command(args, data=None):
            if args[1] == 'ps':
                component = next(v.split('=',2)[-1] for v in args if v.startswith('label=io.mikluha.component='))
                if component != 'postgres': self.assertIn('-a',args)
                return (({'postgres':'1','admin-api':'2','commerce':'3'}[component]*64)+'\n').encode()
            if args[1:3] == ['image','inspect']:
                return json.dumps([{'RepoDigests':[c['images']['postgres'],c['images']['commerce']]}]).encode()
            pg=args[-1]=='1'*64
            current_labels=dict(labels)
            if pg: current_labels.pop('io.mikluha.source')
            return json.dumps([{'Id':args[-1],'Image':'same-id','Config':{'Labels':current_labels,'Env':keys},
                                'State':{'Running':pg,'StartedAt':'dated'},'HostConfig':{'PortBindings':{}}}]).encode()
        db = Database(c, command)
        def sql(q):
            if q == maa_acl.SQL: return baseline
            if 'schema_migrations' in q: return migrations
            if 'relowner' in q: return ['postgres']
            if 'rolcanlogin' in q: return [{'name':n,'super':False,'bypass':False,'createrole':False,'createdb':False,'replication':False} for n in p.ROLES]
            if 'pg_has_role' in q:
                return [cap for login,cap in p.ROLES.items() if "'"+login+"'" in q]
            return {'open':False}
        db.sql = sql
        report = db.inspect()
        self.assertNotIn(private, json.dumps(report))
        self.assertEqual(report, db.inspect())
        keys[0] = 'ADMIN_TOTP_KEY=changed-synthetic-value'
        with self.assertRaises(ValueError): db.inspect()


if __name__ == "__main__": unittest.main()
