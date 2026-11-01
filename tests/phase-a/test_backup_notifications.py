import importlib.util
import datetime as dt
import json
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('backup_notify', ROOT / 'scripts/mikluha-phase-a/notify.py')
n = importlib.util.module_from_spec(spec);spec.loader.exec_module(n)


class NotificationBoundaries(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name);self.root.chmod(0o700)
        self.key = self.root/'credential';self.key.write_text(json.dumps({'apiKey':'synthetic-fixture'}));self.key.chmod(0o600)
        self.state = self.root/'state';self.state.mkdir(mode=0o700)
        (self.state/'last-failure.json').write_text(json.dumps({'at':'2026-11-01T00:00:00+00:00'}));(self.state/'last-failure.json').chmod(0o600)
        self.sent = []
    def sender(self, body, ref):
        self.sent.append(body);return {'provider_acceptance':'ACCEPTED','independent_delivery':'NOT_CONFIRMED'}
    def test_same_failure_capture_and_freshness_sent_once(self):
        a=n.notify('working-capture',self.key,self.state,self.sender)
        b=n.notify('working-freshness',self.key,self.state,self.sender)
        self.assertEqual(a['result'],'PASS');self.assertEqual(b['result'],'DEDUPLICATED');self.assertEqual(len(self.sent),1)
        self.assertNotIn('apiKey',json.dumps(a));self.assertEqual(a['independent_delivery'],'NOT_CONFIRMED')
    def test_unknown_delivery_not_acknowledged(self):
        with self.assertRaises(ValueError):n.notify('working-capture',self.key,self.state,lambda *a:{'provider_acceptance':'UNKNOWN'})
        self.assertFalse((self.state/'last-alert.json').exists())
    def test_unknown_scope_or_event_no_send(self):
        for event in ['working-shell','other-capture','working-capture;true']:
            with self.assertRaises(ValueError):n.notify(event,self.key,self.state,self.sender)
        self.assertEqual(self.sent,[])
    def test_symlink_credential_refused(self):
        p=self.root/'link';p.symlink_to(self.key)
        with self.assertRaises(ValueError):n.notify('working-capture',p,self.state,self.sender)
    def test_private_mode_required(self):
        self.key.chmod(0o644)
        with self.assertRaises(ValueError):n.notify('working-capture',self.key,self.state,self.sender)
    def start(self):
        return dt.datetime(2026, 11, 1, tzinfo=dt.timezone.utc)
    def test_hourly_failures_share_episode_until_six_hours(self):
        first=n.notify('working-capture',self.key,self.state,self.sender,now=self.start())
        for hour in range(1,6):
            (self.state/'last-failure.json').write_text(json.dumps({'at':f'2026-11-01T0{hour}:00:00+00:00'}))
            r=n.notify('working-freshness',self.key,self.state,self.sender,now=self.start()+dt.timedelta(hours=hour))
            self.assertEqual(r['result'],'DEDUPLICATED')
        self.assertEqual(len(self.sent),1)
        r=n.notify('working-capture',self.key,self.state,self.sender,now=self.start()+dt.timedelta(hours=6))
        self.assertEqual(r['sequence'],1);self.assertNotEqual(first['reference'],r['reference'])
        self.assertEqual(len(self.sent),2)
        r=n.notify('working-freshness',self.key,self.state,self.sender,now=self.start()+dt.timedelta(hours=6,minutes=1))
        self.assertEqual(r['result'],'DEDUPLICATED')
    def test_recovery_starts_new_episode_immediately(self):
        a=n.notify('working-capture',self.key,self.state,self.sender,now=self.start())
        p=self.state/'last-success.json';p.write_text(json.dumps({'created_at':'2026-11-01T00:15:00+00:00'}));p.chmod(0o600)
        b=n.notify('working-capture',self.key,self.state,self.sender,now=self.start()+dt.timedelta(minutes=30))
        self.assertNotEqual(a['episode'],b['episode']);self.assertEqual(b['sequence'],0);self.assertEqual(len(self.sent),2)
    def test_unknown_send_retries_same_reference_despite_new_failure_at(self):
        refs=[]
        def unknown(body,ref):refs.append(ref);return {'provider_acceptance':'UNKNOWN'}
        for hour in range(2):
            (self.state/'last-failure.json').write_text(json.dumps({'at':f'2026-11-01T0{hour}:00:00+00:00'}))
            with self.assertRaises(ValueError):n.notify('working-capture',self.key,self.state,unknown,now=self.start()+dt.timedelta(hours=hour))
        self.assertEqual(refs[0],refs[1]);self.assertFalse((self.state/'last-alert.json').exists())
    def test_backwards_clock_does_not_send(self):
        n.notify('working-capture',self.key,self.state,self.sender,now=self.start())
        with self.assertRaises(ValueError):n.notify('working-capture',self.key,self.state,self.sender,now=self.start()-dt.timedelta(seconds=1))
        self.assertEqual(len(self.sent),1)
    def test_legacy_ack_schema_migrates_on_next_actual_failure(self):
        p=self.state/'last-alert.json';p.write_text(json.dumps({'reference':'legacy','at':self.start().isoformat()}));p.chmod(0o600)
        r=n.notify('working-capture',self.key,self.state,self.sender,now=self.start())
        self.assertEqual(r['sequence'],0);self.assertEqual(len(self.sent),1)
    def test_notifier_cannot_change_parent_job_result(self):
        for name,event in [('mikluha-native-backup@working.service.d','capture'),('mikluha-native-backup-check@working.service.d','freshness')]:
            text=(ROOT/'config/mikluha-phase-a/systemd'/name/'notify.conf').read_text()
            self.assertEqual(text,'[Unit]\nOnFailure=mikluha-native-backup-alert@working-'+event+'.service\n')
