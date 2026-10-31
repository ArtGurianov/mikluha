"""Version-aware restore failures; real provider evidence is recorded separately."""
import copy
import datetime as dt
import hashlib
import pathlib
import tempfile
import unittest
from unittest import mock
from test_mikluha_phase_a import qualified, Provider
import maa_backup as b
import maa_recovery as recovery
import maa_plan as plan
from maa_provider import AwsProvider


class Versions:
    def __init__(self, original):
        self.data={};self.rows=[]
        for key,body in original.data.items():self.add(key,'old',body,b.stamp()-dt.timedelta(days=5))

    def add(self,key,version,body,when,marker=False):
        self.data[key,version]=body
        self.rows.append(dict(Key=key,VersionId=version,LastModified=when.isoformat(),
                              ETag=hashlib.sha256(body).hexdigest(),DeleteMarker=marker))

    def records(self,prefix=None):return [r for r in self.rows if prefix is None or r['Key'].startswith(prefix)]

    def head(self,ref):
        row=next(r for r in self.rows if r['Key']==ref['Key'] and r['VersionId']==ref['VersionId'])
        return {k:row[k] for k in ['VersionId','ETag','LastModified']}|{'ContentLength':len(self.data[ref['Key'],ref['VersionId']])}

    def get(self,ref,expected=None):
        if expected is not None and self.head(ref)!=expected:raise ValueError('version changed')
        return self.data[ref['Key'],ref['VersionId']]


class VersionedRecovery(unittest.TestCase):
    def setUp(self):
        self.c=qualified();original=Provider()
        db=dict(scope=self.c['scope'],source_commit=self.c['source_commit'],schema_head=19,sales_open=False,
                role_contract='PASS',privileges_sha256=self.c['privileges_sha256'],database_generation=self.c['database_generation'])
        self.clear,meta=b.capture(self.c,lambda:db,lambda:b'PGDMPsynthetic')
        with tempfile.TemporaryDirectory() as d:
            self.receipt=b.publish(self.c,original,b'age-encryption.org/v1\nfixture',meta,pathlib.Path(d).resolve())
        self.p=Versions(original);self.cutoff=(b.stamp()-dt.timedelta(days=2)).isoformat()

    def test_overwrite_of_both_objects_preserves_preincident_pair(self):
        for row in list(self.p.rows):self.p.add(row['Key'],'new',b'corrupt replacement',b.stamp()-dt.timedelta(days=1))
        selected=recovery.select_manifest(self.c,self.p,self.cutoff)
        self.assertEqual({v['VersionId'] for v in selected.values()},{'old'})
        dump,meta=b.verify(self.c,self.p,selected,self.cutoff,lambda _:self.clear)
        self.assertEqual(dump,b'PGDMPsynthetic');self.assertEqual(meta['retrieval']['cipher_version_id'],'old')
        with self.assertRaises((ValueError,KeyError)):
            b.verify(self.c,self.p,recovery.select_manifest(self.c,self.p,b.stamp().isoformat()),b.stamp().isoformat(),lambda _:self.clear)

    def test_delete_marker_snapshot_does_not_resurrect_a_deleted_key(self):
        self.p.add(self.receipt['object'],'deleted',b'',b.stamp()-dt.timedelta(days=3),marker=True)
        with self.assertRaises(ValueError):recovery.select_manifest(self.c,self.p,self.cutoff)
        selected=recovery.select_manifest(self.c,self.p,(b.stamp()-dt.timedelta(days=4)).isoformat())
        self.assertEqual(selected['cipher']['VersionId'],'old')

    def test_null_legacy_versions_and_explicit_manifest_remain_pinned(self):
        for row in self.p.rows:
            self.p.data[row['Key'],'null']=self.p.data.pop((row['Key'],row['VersionId']));row['VersionId']='null'
        selected=recovery.select_manifest(self.c,self.p,self.cutoff,manifest_key=self.receipt['manifest_object'])
        self.assertEqual(selected['manifest']['VersionId'],'null')
        self.assertEqual(b.verify(self.c,self.p,selected,self.cutoff,lambda _:self.clear)[0],b'PGDMPsynthetic')

    def test_old_version_window_and_ambiguous_timestamp_fail_closed(self):
        for row in self.p.rows:row['LastModified']=(b.stamp()-dt.timedelta(days=15)).isoformat()
        with self.assertRaises(ValueError):recovery.select_manifest(self.c,self.p,self.cutoff)
        for row in self.p.rows:row['LastModified']=(b.stamp()-dt.timedelta(days=8)).isoformat()
        self.assertEqual(recovery.select_manifest(self.c,self.p,self.cutoff)['manifest']['VersionId'],'old')
        row=self.p.rows[0];self.p.add(row['Key'],'same-time',b'other',recovery.timestamp(row['LastModified']))
        with self.assertRaises(ValueError):recovery.select_manifest(self.c,self.p,self.cutoff)

    def test_version_listing_head_race_does_not_choose_older_backup(self):
        head=self.p.head
        with mock.patch.object(self.p,'head',side_effect=lambda ref:dict(head(ref),VersionId='different')):
            with self.assertRaises(ValueError):recovery.select_manifest(self.c,self.p,self.cutoff)

    def test_cloudru_listing_milliseconds_head_seconds_keep_immutable_identity(self):
        head=self.p.head
        with mock.patch.object(self.p,'head',side_effect=lambda ref:dict(head(ref),LastModified=recovery.timestamp(head(ref)['LastModified']).replace(microsecond=0).isoformat())):
            self.assertEqual(recovery.select_manifest(self.c,self.p,self.cutoff)['cipher']['VersionId'],'old')
        with mock.patch.object(self.p,'head',side_effect=lambda ref:dict(head(ref),LastModified=(recovery.timestamp(head(ref)['LastModified'])+dt.timedelta(seconds=1)).isoformat())):
            with self.assertRaises(ValueError):recovery.select_manifest(self.c,self.p,self.cutoff)

    def test_exact_versioning_and_ttl_contract(self):
        for version in [None,'Suspended','Disabled']:
            c=copy.deepcopy(self.c);c['backup']['versioning']=version
            with self.assertRaises(ValueError):plan.validate(c)
        self.assertEqual(plan.lifecycle(self.c)['Rules'][0]['NoncurrentVersionExpiration'],{'NoncurrentDays':7})
        self.assertNotIn('NewerNoncurrentVersions',plan.lifecycle(self.c)['Rules'][0]['NoncurrentVersionExpiration'])

    def test_pagination_versions_markers_and_producer_listing_denial(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d).resolve();root.chmod(0o700);cred=root/'credentials';cred.write_text('fixture');cred.chmod(0o600)
            p=AwsProvider(self.c,cred,root,read_only=True)
            rows=copy.deepcopy(self.p.rows);marker=dict(rows[0],VersionId='marker');marker.pop('ETag')
            replies=[{'Versions':[rows[0]],'IsTruncated':True,'NextKeyMarker':rows[0]['Key'],'NextVersionIdMarker':'old'},
                     {'Versions':[rows[1]],'DeleteMarkers':[marker]}]
            calls=[]
            def call(action,*args):calls.append((action,args));return replies.pop(0)
            p.call=call
            self.assertEqual(len(p.records()),3);self.assertEqual(calls[0][0],'list-object-versions')
            self.assertIn('--version-id-marker',calls[1][1])
            p=AwsProvider(self.c,cred,root)
            with self.assertRaises(ValueError):p.call('list-object-versions')
            for action in ['delete-object','put-bucket-versioning','put-bucket-lifecycle-configuration']:
                with self.assertRaises(ValueError):p.call(action)

    def test_looping_pagination_and_duplicate_or_missing_version_fail_closed(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d).resolve();root.chmod(0o700);cred=root/'credentials';cred.write_text('fixture');cred.chmod(0o600)
            p=AwsProvider(self.c,cred,root,read_only=True)
            p.call=lambda *args:{'IsTruncated':True,'NextKeyMarker':'key','NextVersionIdMarker':'same'}
            with self.assertRaises(ValueError):p.records()
            row=copy.deepcopy(self.p.rows[0])
            p.call=lambda *args:{'Versions':[row,row]}
            with self.assertRaises(ValueError):p.records()
            row.pop('VersionId');p.call=lambda *args:{'Versions':[row]}
            with self.assertRaises(ValueError):p.records()

    def test_wrong_missing_version_and_foreign_reference_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d).resolve();root.chmod(0o700);cred=root/'credentials';cred.write_text('fixture');cred.chmod(0o600)
            p=AwsProvider(self.c,cred,root,read_only=True);ref={'Key':self.receipt['object'],'VersionId':'old'}
            p.call=lambda *args:self.p.head(ref)|{'VersionId':'wrong'}
            with self.assertRaises(ValueError):p.head(ref)
            for version in ['',None,'bad\nversion']:
                with self.assertRaises(ValueError):p.reference(dict(ref,VersionId=version))
            with self.assertRaises(ValueError):p.reference({'Key':'other/key','VersionId':'old'})


if __name__=='__main__':unittest.main()
