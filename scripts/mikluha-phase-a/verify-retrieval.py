#!/usr/bin/env python3
"""Owner-Mac read/decrypt proof only. Never emits clear bytes or claims database restore."""
import argparse
import importlib.util
import json
import pathlib
import sys
ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'config/mikluha-phase-a/lib'))
from maa_plan import validate
from maa_backup import run, verify
from maa_provider import AwsProvider
from maa_recovery import private_file, select_manifest


def main():
    p = argparse.ArgumentParser()
    for name in ('candidate', 'credentials', 'scratch', 'identity'):
        p.add_argument('--' + name, required=True, type=pathlib.Path)
    p.add_argument('--manifest')
    p.add_argument('--incident-before',required=True)
    a = p.parse_args()
    private_file(a.identity)
    c = json.loads(a.candidate.read_text()); validate(c, ready=True)
    spec = importlib.util.spec_from_file_location('maa_engine', ROOT / 'scripts/mikluha-phase-a/local-engine.py')
    engine = importlib.util.module_from_spec(spec); spec.loader.exec_module(engine)
    docker = engine.local_docker()
    provider = AwsProvider(c, a.credentials, a.scratch, docker=docker, check=lambda: engine.verify_engine(docker), read_only=True)
    provider.assert_configuration()
    manifest=select_manifest(c,provider,a.incident_before,manifest_key=a.manifest)
    dump, meta = verify(c, provider, manifest, a.incident_before,
                        lambda body: run(['age', '-d', '-i', str(a.identity)], body))
    del dump
    print(json.dumps({'retrieval_decrypt': 'PASS', 'scope': meta['scope'],
                      'retrieval':meta['retrieval'],'database_restore': 'NOT_RUN', 'admin_crypto': 'NOT_RUN',
                      'current_restriction_reconciliation': 'NOT_RUN', 'real_admission': 'NO_GO'}))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('RETRIEVAL=FAIL; diagnostic values suppressed', file=sys.stderr)
        sys.exit(1)
