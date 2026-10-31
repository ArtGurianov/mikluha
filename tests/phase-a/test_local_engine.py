"""Reject remote/changed Docker targets before local restore can create anything."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('phase_a_local_engine', ROOT/'scripts/mikluha-phase-a/local-engine.py')
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


class LocalEngine(unittest.TestCase):
    def policy(self, path):
        return {'schema': 1, 'context': 'desktop-linux', 'endpoint': 'unix://'+str(path),
                'socket_owner_uid': os.getuid(), 'daemon': {'ID': 'approved-fixture',
                'Name': 'docker-desktop', 'OperatingSystem': 'Docker Desktop', 'OSType': 'linux'}}

    def test_explicit_private_policy_accepts_only_its_local_owned_socket_and_daemon(self):
        with tempfile.TemporaryDirectory() as d, socket.socket(socket.AF_UNIX) as sock:
            root = Path(d); path = root/'socket'; sock.bind(str(path)); path.chmod(0o600)
            policy = self.policy(path); file = root/'policy'; file.write_text(json.dumps(policy)); file.chmod(0o600)
            responses = [b'desktop-linux', json.dumps([{'Name':'desktop-linux', 'Endpoints': {'docker': {'Host': policy['endpoint']}}}]).encode(), json.dumps(policy['daemon']).encode()]
            with mock.patch.dict(os.environ, {'MIKLUHA_LOCAL_DOCKER_POLICY':str(file)}, clear=True), mock.patch.object(engine,'command',side_effect=responses):
                handle = engine.local_docker()
                self.assertEqual(handle, ['docker','--host',policy['endpoint']])

    def test_remote_override_and_unapproved_handle_fail_before_any_command(self):
        handle = engine.DockerEngine(self.policy(Path('/not-used')))
        with mock.patch.object(engine,'command') as command:
            for name in engine.OVERRIDES:
                with mock.patch.dict(os.environ,{name:'unapproved'},clear=True):
                    with self.assertRaises(ValueError):engine.verify_engine(handle)
            with self.assertRaises(ValueError):engine.verify_engine(['docker'])
            command.assert_not_called()

    def test_unapproved_policy_transport_permissions_and_symlink_refused(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); file=root/'policy'; policy=self.policy(root/'socket')
            for endpoint in ['ssh://host','tcp://127.0.0.1:2375','unix://relative']:
                file.write_text(json.dumps(policy | {'endpoint':endpoint}));file.chmod(0o600)
                with mock.patch.dict(os.environ,{'MIKLUHA_LOCAL_DOCKER_POLICY':str(file)},clear=True):
                    with self.assertRaises(ValueError):engine.engine_policy()
            file.write_text(json.dumps(policy));file.chmod(0o644)
            with mock.patch.dict(os.environ,{'MIKLUHA_LOCAL_DOCKER_POLICY':str(file)},clear=True):
                with self.assertRaises(ValueError):engine.engine_policy()
            file.chmod(0o600);link=root/'link';link.symlink_to(file)
            with mock.patch.dict(os.environ,{'MIKLUHA_LOCAL_DOCKER_POLICY':str(link)},clear=True):
                with self.assertRaises(ValueError):engine.engine_policy()

    def test_context_endpoint_or_daemon_retargeting_refused(self):
        with tempfile.TemporaryDirectory() as d, socket.socket(socket.AF_UNIX) as sock:
            path=Path(d)/'socket';sock.bind(str(path));path.chmod(0o600)
            p=self.policy(path);h=engine.DockerEngine(p)
            expected=json.dumps([{'Name':'desktop-linux','Endpoints':{'docker':{'Host':p['endpoint']}}}]).encode()
            cases=[[b'remote'],[b'desktop-linux',b'[]'],[b'desktop-linux',expected,json.dumps(p['daemon']|{'ID':'changed'}).encode()]]
            for replies in cases:
                with mock.patch.dict(os.environ,{},clear=True),mock.patch.object(engine,'command',side_effect=replies):
                    with self.assertRaises(ValueError):engine.verify_engine(h)


if __name__ == '__main__':unittest.main()
