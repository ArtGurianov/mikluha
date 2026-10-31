#!/usr/bin/env python3
"""Offline review package. Deliberately has no install, deploy, create or delete action."""
import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'config/mikluha-phase-a/lib'))
from maa_plan import compose, validate, working

p = argparse.ArgumentParser()
p.add_argument('action', choices=['report', 'compose', 'validate-release'])
p.add_argument('--candidate', type=pathlib.Path, default=ROOT / 'config/mikluha-phase-a/candidate.json')
p.add_argument('--scope', choices=['acceptance', 'working'], default='acceptance')
p.add_argument('--stage', choices=['database', 'runtime'], default='runtime')
a = p.parse_args()
try:
    c = json.loads(a.candidate.read_text())
    if a.scope == 'working' and c['scope'] != 'working':
        c = working(c)
    if a.action == 'validate-release':
        validate(c, ready=True)
        print('RELEASE_INPUTS=READY_FOR_OWNER_REVIEW; installation not authorized')
    elif a.action == 'compose':
        value = compose(c)
        if a.stage == 'database':
            value['services'] = {'postgres': value['services']['postgres']}
            value['networks'] = {'db': value['networks']['db']}
            value['volumes'] = {'pg-data': value['volumes']['pg-data']}
        print(json.dumps(value, indent=2))
    else:
        print(json.dumps({'format': c['format'], 'scope': c['scope'], 'missing': validate(c),
                          'installation': 'NO_GO', 'host_mutation': False,
                          'archive_storage': 'CLOUD_RU_ONLY', 'proposed_remote_days': 7}, indent=2))
except Exception:
    print('PREPARATION=FAIL; invalid or unqualified input', file=sys.stderr)
    sys.exit(1)
