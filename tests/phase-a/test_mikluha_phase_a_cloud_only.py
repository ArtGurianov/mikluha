"""Cloud-only Phase A: server timestamps, no producer pins/replication/cache/holds."""
import copy
import datetime as dt
import io
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock
ROOT=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'config/mikluha-phase-a/lib'))
import maa_backup as b
import maa_plan as plan
import maa_recovery as recovery
from test_mikluha_phase_a import qualified,Provider
from maa_provider import AwsProvider


class CloudRecovery(unittest.TestCase):
    def setUp(self):
        self.c=qualified();self.provider=Provider()
        db={'scope':self.c['scope'],'source_commit':self.c['source_commit'],'schema_head':19,
            'sales_open':False,'role_contract':'PASS','privileges_sha256':self.c['privileges_sha256'],
            'database_generation':self.c['database_generation']}
        self.clear,self.meta=b.capture(self.c,lambda:db,lambda:b'PGDMPsynthetic')
        self.cipher=b'age-encryption.org/v1\nfixture'
        self.tmp=tempfile.TemporaryDirectory();self.state=pathlib.Path(self.tmp.name).resolve()
        self.addCleanup(self.tmp.cleanup)
        self.receipt=b.publish(self.c,self.provider,self.cipher,self.meta,self.state)
        self.cutoff=b.stamp().isoformat()

    def test_restore_works_after_host_status_loss_without_pins_or_local_archive(self):
        self.assertEqual({p.name for p in self.state.iterdir()},{'last-success.json'})
        (self.state/'last-success.json').unlink()
        key=recovery.select_manifest(self.c,self.provider,self.cutoff)
        dump,metadata=b.verify(self.c,self.provider,key,self.cutoff,lambda _:self.clear)
        self.assertEqual(dump,b'PGDMPsynthetic')
        self.assertEqual(metadata['retrieval']['trust'],'PROVIDER_METADATA_NOT_INDEPENDENT_AUTHENTICATION')
        self.assertFalse(list(self.state.iterdir()))

    def test_whole_cutoff_second_future_cutoff_and_naive_times_refused(self):
        self.assertEqual(recovery.timestamp('Thu, 16 Apr 2015 18:19:14 GMT').year,2015)
        self.provider.modified=b.stamp().replace(microsecond=0).isoformat()
        with self.assertRaises(ValueError):recovery.select_manifest(self.c,self.provider,self.cutoff)
        with self.assertRaises(ValueError):recovery.owner_cutoff((b.stamp()+dt.timedelta(hours=1)).isoformat())
        with self.assertRaises(ValueError):recovery.owner_cutoff('2026-10-01T10:00:00')

    def test_provider_time_not_key_or_payload_created_at_controls_selection(self):
        self.provider.modified=(b.stamp()+dt.timedelta(hours=1)).isoformat()
        with self.assertRaises(ValueError):recovery.select_manifest(self.c,self.provider,self.cutoff)
        # Old producer filename/body timestamp does not permit an after-cutoff object.
        with self.assertRaises(ValueError):b.verify(self.c,self.provider,self.receipt['manifest_object'],self.cutoff,lambda _:self.clear)

    def test_both_objects_must_be_before_cutoff_and_within_versioned_retention_horizon(self):
        original=self.provider.head
        def head(key):
            row=original(key)
            if key.endswith('.tar.age'):row['LastModified']=b.stamp().isoformat()
            return row
        with mock.patch.object(self.provider,'head',side_effect=head):
            with self.assertRaises(ValueError):b.verify(self.c,self.provider,self.receipt['manifest_object'],self.cutoff,lambda _:self.clear)
        self.provider.modified=(b.stamp()-dt.timedelta(days=15)).isoformat()
        with self.assertRaises(ValueError):recovery.select_manifest(self.c,self.provider,self.cutoff)

    def test_listing_race_and_conditional_get_race_abort_without_older_fallback(self):
        records=self.provider.records()
        records[1]['ETag']='before-overwrite'
        with mock.patch.object(self.provider,'records',return_value=records):
            with self.assertRaises(ValueError):recovery.select_manifest(self.c,self.provider,self.cutoff)
        original=self.provider.get
        def racing(key,expected=None):
            if expected is not None:self.provider.modified=b.stamp().isoformat()
            return original(key,expected)
        with mock.patch.object(self.provider,'get',side_effect=racing):
            with self.assertRaises(ValueError):b.verify(self.c,self.provider,self.receipt['manifest_object'],self.cutoff,lambda _:self.clear)

    def test_incomplete_upload_skipped_and_corrupt_latest_never_silently_downgraded(self):
        key=self.receipt['manifest_object']
        del self.provider.data[self.receipt['object']]
        with self.assertRaises(ValueError):recovery.select_manifest(self.c,self.provider,self.cutoff)
        self.provider.data[self.receipt['object']]=self.cipher+b'changed'
        self.assertEqual(recovery.select_manifest(self.c,self.provider,self.cutoff),key)
        with self.assertRaises(ValueError):b.verify(self.c,self.provider,key,self.cutoff,lambda _:self.clear)

    def test_cli_adapter_checks_ifmatch_and_after_get_metadata_without_retaining_bytes(self):
        with tempfile.TemporaryDirectory() as d:
            root=pathlib.Path(d).resolve();root.chmod(0o700)
            cred=root/'creds';cred.write_text('synthetic');cred.chmod(0o600)
            p=AwsProvider(self.c,cred,root,read_only=True)
            key=self.receipt['object'];expected=dict(self.provider.head(key),VersionId='fixture-version');heads=[]
            changed=False
            def call(action,*args):
                if action=='head-object':
                    heads.append(1)
                    return expected|({'LastModified':b.stamp().isoformat()} if changed and len(heads)>1 else {})
                self.assertEqual(action,'get-object')
                self.assertEqual(args[args.index('--if-match')+1],expected['ETag'])
                (root/pathlib.PurePosixPath(args[-1]).name).write_bytes(self.cipher)
                return expected
            p.call=call
            self.assertEqual(p.get(key,expected=expected),self.cipher)
            self.assertEqual({p.name for p in root.iterdir()},{'creds'})
            changed=True;heads.clear()
            with self.assertRaises(ValueError):p.get(key,expected=expected)
            self.assertEqual({p.name for p in root.iterdir()},{'creds'})

    def test_old_replication_policy_is_not_silently_reused(self):
        changed=copy.deepcopy(self.c);changed['backup']['local_hours']=24
        with self.assertRaises(ValueError):plan.validate(changed)
        changed=copy.deepcopy(self.c);changed['backup']['offhost_local_days']=7
        with self.assertRaises(ValueError):plan.validate(changed)


if __name__=='__main__':unittest.main()
