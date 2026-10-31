"""Review regressions. Fixtures do not constitute Cloud.ru/provider qualification."""
import copy
import datetime as dt
import fcntl
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
ROOT=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'config/mikluha-phase-a/lib'))
from test_mikluha_phase_a import qualified, Provider
import maa_acl as acl
import maa_backup as b
import maa_recovery as recovery
import maa_plan as plan
from maa_provider import AwsProvider, ProviderError


class ReviewContracts(unittest.TestCase):
    def test_complete_acl_contract_rejects_added_grants_and_role_changes(self):
        expected=[['relation','public.admin_totp',{'acl':['postgres=arwdDxt/postgres']}],['role','admin_app',{'super':False}]]
        c=qualified();c['privileges_sha256']=acl.fingerprint(expected)
        self.assertEqual(acl.attest(c,lambda _:expected),c['privileges_sha256'])
        for entry in [['column','public.admin_totp.seed_ciphertext',{'acl':['commerce_runtime=r/postgres']}],
                      ['function','public.sensitive()',{'acl':['=X/postgres']}],
                      ['relation','public.secret_seq',{'acl':['commerce_runtime=U/postgres']}],
                      ['default','postgres:*:r',{'acl':['=r/postgres']}],
                      ['member','admin_operator:commerce_runtime',{}]]:
            with self.assertRaises(ValueError):acl.attest(c,lambda _:expected+[entry])
        mutated=copy.deepcopy(expected);mutated[1][2]['super']=True
        with self.assertRaises(ValueError):acl.attest(c,lambda _:mutated)
        for catalog in ['pg_class','pg_attribute','pg_proc','pg_namespace','pg_database','pg_default_acl','pg_auth_members','pg_roles','pg_type']:
            self.assertIn(catalog,acl.SQL)

    def test_postgres_definition_survives_application_release(self):
        c=qualified();before=plan.compose(c)['services']['postgres']
        c['source_commit']='b'*40;c['secret_authority']['generation']='new-app-key-generation'
        self.assertEqual(before,plan.compose(c)['services']['postgres'])
        labels=dict(x.split('=',1) for x in before['labels'])
        self.assertNotIn('io.mikluha.source',labels)
        self.assertEqual(labels['io.mikluha.database-generation'],c['database_generation'])
        self.assertEqual(len(plan.compose(c)['services']['gateway']['ports']),1)

    def test_freshness_while_backup_holds_lock_does_not_fake_failure(self):
        with tempfile.TemporaryDirectory() as d:
            state=pathlib.Path(d).resolve();c=qualified()
            db={'scope':c['scope'],'source_commit':c['source_commit'],'schema_head':19,'sales_open':False,'role_contract':'PASS','privileges_sha256':c['privileges_sha256'],'database_generation':c['database_generation']}
            clear,meta=b.capture(c,lambda:db,lambda:b'PGDMPfixture')
            b.publish(c,Provider(),b'age-encryption.org/v1\nfixture',meta,state)
            with (state/'lock').open('a') as held,(state/'lock').open('a') as checking:
                fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
                self.assertEqual(b.checked_freshness(c,state,checking)['producer'],'RUNNING')
                with mock.patch.object(b,'stamp',return_value=b.stamp()+dt.timedelta(hours=3)):
                    with self.assertRaises(ValueError):b.checked_freshness(c,state,checking)

    def test_restore_requires_crypto_unless_explicit_partial_mode(self):
        spec=importlib.util.spec_from_file_location('maa_restore_review',ROOT/'scripts/mikluha-phase-a/restore-local.py')
        restore=importlib.util.module_from_spec(spec);spec.loader.exec_module(restore)
        with self.assertRaises(ValueError):restore.restore(qualified(),b'notused',[],lambda _:None)
        with tempfile.TemporaryDirectory() as d:
            identity=pathlib.Path(d).resolve()/'identity';identity.write_text('synthetic');identity.chmod(0o644)
            with self.assertRaises(ValueError):recovery.private_file(identity)
            identity.chmod(0o600);self.assertEqual(recovery.private_file(identity),identity)
        result=subprocess.run([sys.executable,str(ROOT/'scripts/mikluha-phase-a/restore-local.py'),
                               '--identity','unused','--incident-before',b.stamp().isoformat()],capture_output=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIn(b'--admin-keys',result.stderr)


class BucketContracts(unittest.TestCase):
    def provider(self,root):
        cred=root/'creds';cred.write_text('synthetic');cred.chmod(0o600)
        c=qualified();return AwsProvider(c,cred,root)

    def responses(self,c):
        return {'get-bucket-versioning':{'Status':'Enabled'},'get-bucket-acl':{'Owner':{'ID':'expected-owner'},'Grants':[
            {'Grantee':{'Type':'CanonicalUser','ID':'expected-owner'},'Permission':'FULL_CONTROL'}]},
            'get-bucket-policy':None,'get-bucket-lifecycle-configuration':c['backup']['lifecycle']}

    def test_bucket_owner_foreign_grantee_and_lifecycle_mismatch_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d).resolve();root.chmod(0o700);p=self.provider(root);r=self.responses(p.c)
            p.call=lambda action,*args,**kwargs:r[action]
            p.assert_configuration()
            for field in ['owner','grantee','lifecycle','policy','versioning']:
                bad=copy.deepcopy(r)
                if field=='owner':bad['get-bucket-acl']['Owner']['ID']='intruder'
                elif field=='grantee':bad['get-bucket-acl']['Grants'][0]['Grantee']['ID']='intruder'
                elif field=='lifecycle':bad['get-bucket-lifecycle-configuration']['Rules'][0]['Expiration']['Days']=30
                elif field=='versioning':bad['get-bucket-versioning']={'Status':'Suspended'}
                else:bad['get-bucket-policy']={'Policy':'{}'}
                p.call=lambda action,*args,**kwargs:bad[action]
                with self.assertRaises(ValueError):p.assert_configuration()

    def test_exact_policy_does_not_allow_foreign_principal_action_or_resource(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d).resolve();root.chmod(0o700);p=self.provider(root)
            statement={'Effect':'Allow','Principal':{'AWS':'enrolled-principal'},'Action':'s3:GetObject',
                       'Resource':'arn:aws:s3:::'+p.c['backup']['bucket']+'/'+p.c['backup']['prefix']+'*'}
            p.c['backup']['allowed_principals']=['enrolled-principal']
            policy={'Version':'2012-10-17','Statement':[statement]};p.c['backup']['policy']=policy
            r=self.responses(p.c);r['get-bucket-policy']={'Policy':json.dumps(policy)}
            p.call=lambda action,*args,**kwargs:r[action];p.assert_configuration()
            for key,value in [('Principal',{'AWS':'foreign'}),('Action','s3:DeleteObject'),('Resource','*')]:
                altered=copy.deepcopy(policy);altered['Statement'][0][key]=value
                p.c['backup']['policy']=altered;r['get-bucket-policy']={'Policy':json.dumps(altered)}
                with self.assertRaises(ValueError):p.assert_configuration()

    def test_cloudru_empty_policy_defaults_preserve_allow_boundary(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d).resolve();root.chmod(0o700);p=self.provider(root)
            statement={'Effect':'Allow','Principal':{'AWS':'enrolled-principal'},
                       'Action':'s3:GetObject','Resource':'arn:aws:s3:::'+p.c['backup']['bucket']+'/'+p.c['backup']['prefix']+'*',
                       'NotPrincipal':{},'NotAction':[],'NotResource':[],'Condition':{}}
            p.c['backup']['allowed_principals']=['enrolled-principal']
            def enrolled(s):
                policy={'Version':'2012-10-17','Statement':[s]}
                p.c['backup']['policy']=policy;r=self.responses(p.c)
                r['get-bucket-policy']={'Policy':json.dumps(policy)}
                p.call=lambda action,*args,**kwargs:r[action]
            enrolled(statement);p.assert_configuration()
            lifecycle=copy.deepcopy(statement)
            lifecycle.update(Action='s3:GetBucketLifecycleConfiguration',Resource='arn:aws:s3:::'+p.c['backup']['bucket'])
            enrolled(lifecycle);p.assert_configuration()
            lifecycle['Action']='s3:PutBucketLifecycleConfiguration';enrolled(lifecycle)
            with self.assertRaises(ValueError):p.assert_configuration()
            for key,value in [('NotPrincipal',{'AWS':'foreign'}),('NotAction',['s3:DeleteObject']),
                              ('NotResource','*'),('NotPrincipal',[]),('NotAction',{}),
                              ('NotResource',None),('Unexpected',[])]:
                bad=copy.deepcopy(statement);bad[key]=value;enrolled(bad)
                with self.assertRaises(ValueError):p.assert_configuration()
            enrolled(statement)
            p.c['backup']['policy']=copy.deepcopy(p.c['backup']['policy'])
            del p.c['backup']['policy']['Statement'][0]['NotAction']
            with self.assertRaises(ValueError):p.assert_configuration()

    def test_checksum_flags_no_policy_and_readonly_authority(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d).resolve();root.chmod(0o700);p=self.provider(root)
            command=mock.Mock(return_value=subprocess.CompletedProcess([],254,b'',b'(NoSuchBucketPolicy)'))
            p.command=command
            self.assertIsNone(p.call('get-bucket-policy',no_policy=True))
            args=command.call_args.args[0]
            self.assertIn('AWS_REQUEST_CHECKSUM_CALCULATION=when_required',args)
            self.assertIn('AWS_RESPONSE_CHECKSUM_VALIDATION=when_required',args)
            for error in [b'(AccessDenied)',b'(NoSuchBucket)']:
                command.return_value=subprocess.CompletedProcess([],254,b'',error)
                with self.assertRaises(ProviderError):p.call('get-bucket-policy',no_policy=True)
            for action in ['delete-object','put-bucket-policy','put-bucket-lifecycle-configuration']:
                with self.assertRaises(ValueError):p.call(action)
            p.read_only=True
            with self.assertRaises(ValueError):p.call('put-object')



if __name__=='__main__':unittest.main()
