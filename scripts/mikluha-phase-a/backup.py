#!/usr/bin/env python3
"""Opt-in root job; candidate RELEASE validation is mandatory. No install or timer activation."""
import argparse
import fcntl
import json
import os
import pathlib
import stat
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
LIB = ROOT / 'config/mikluha-phase-a/lib'
# Installed layout has the same module set in /usr/local/libexec/mikluha-phase-a.
if not LIB.is_dir():
    LIB = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(LIB))
from maa_plan import validate
from maa_backup import atomic, capture, encoded, encrypt, freshness, publish, stamp, checked_freshness
from maa_host import Database
from maa_provider import AwsProvider


def main():
    p = argparse.ArgumentParser()
    p.add_argument('action', choices=['capture', 'check'])
    p.add_argument('--scope', choices=['acceptance', 'working'], required=True)
    a = p.parse_args()
    if os.geteuid() != 0:
        raise ValueError('root-owned backup context required')
    os.umask(0o077)
    root = pathlib.Path('/etc/mikluha-native') / a.scope
    state = pathlib.Path('/var/lib/mikluha-native-backup') / a.scope
    for path in (root, state):
        st = path.lstat()
        if path.is_symlink() or path.resolve() != path or st.st_uid != 0 or stat.S_IMODE(st.st_mode) != 0o700:
            raise ValueError('private root/state directory')
    config = json.loads((root / 'release.json').read_text())
    if config['scope'] != a.scope:
        raise ValueError('scope mismatch')
    validate(config, ready=True)
    lock_path = state / 'lock'
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        if a.action == 'check':
            print(json.dumps(checked_freshness(config, state, lock)))
            return
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            # Unit-owned /run tmpfs, not retained archive storage. Docker sees this path.
            runtime=pathlib.Path('/run/mikluha-native-backup-'+a.scope)
            st=runtime.lstat()
            if runtime.resolve()!=runtime or st.st_uid!=0 or stat.S_IMODE(st.st_mode)!=0o700:
                raise ValueError('private unit runtime directory required')
            from maa_backup import run
            if run(['findmnt','-n','-o','FSTYPE','--target',str(runtime)]).strip()!=b'tmpfs':
                raise ValueError('encrypted transfer scratch must be RAM-backed')
            with tempfile.TemporaryDirectory(prefix='transfer-',dir=runtime) as tmp:
                scratch=pathlib.Path(tmp);scratch.chmod(0o700)
                provider=AwsProvider(config,root/'backup.credentials',scratch)
                provider.assert_configuration()
                db=Database(config)
                clear,meta=capture(config,db.inspect,db.dump)
                cipher=encrypt(clear,config['backup']['recipient']);del clear
                receipt=publish(config,provider,cipher,meta,state)
            print('MIKLUHA_BACKUP=PASS scope=' + a.scope + ' object=' + receipt['object'])
        except Exception:
            atomic(state / 'last-failure.json', encoded({'result': 'FAIL', 'at': stamp().isoformat(), 'scope': a.scope}))
            raise


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('MIKLUHA_BACKUP=FAIL; diagnostic values suppressed', file=sys.stderr)
        sys.exit(1)
