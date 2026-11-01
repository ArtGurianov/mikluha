#!/usr/bin/env python3
"""Scoped backup failures only; fixed operational payload, no DB/log access."""
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import sys
import urllib.request
import urllib.error
import uuid

URL = 'https://telebuzzy.xyz/api/notify'
EVENTS = {s + '-' + e for s in ('acceptance', 'working') for e in ('capture', 'freshness')}


def private(path, mode=0o600):
    st = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != mode or st.st_size > 16384:
        raise ValueError('private file required')
    return json.loads(path.read_text())


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def send(body, reference):
    req = urllib.request.Request(URL, json.dumps(body).encode(),
        {'Content-Type': 'application/json', 'Idempotency-Key': reference}, method='POST')
    # Neither exceptions nor response bodies are printed: they may reflect credentials.
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=10) as r:
        raw = r.read(16385)
        if not 200 <= r.status < 300 or len(raw) > 16384:
            raise ValueError('provider refusal/oversize')
        answer = json.loads(raw)
        if not isinstance(answer, dict) or answer.get('error') or answer.get('success') is False or answer.get('ok') is False:
            raise ValueError('provider did not accept')
        return {'provider_acceptance': 'ACCEPTED', 'http_status': r.status,
                'independent_delivery': 'NOT_CONFIRMED'}


def notify(event, credentials, state, sender=send, now=None):
    if event not in EVENTS:
        raise ValueError('unknown scoped event')
    scope, kind = event.split('-');now = now or dt.datetime.now(dt.timezone.utc)
    key = private(credentials)
    if set(key) != {'apiKey'} or not isinstance(key['apiKey'], str) or not re.fullmatch(r'[^\s\x00-\x1f\x7f]{1,512}', key['apiKey']):
        raise ValueError('invalid credential')
    st = state.lstat()
    if state.is_symlink() or not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != 0o700:
        raise ValueError('private state required')
    lock = os.open(state / 'alert.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock, 'a') as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'result': 'BUSY', 'notification_in_progress': True}
        failure = state / 'last-failure.json';success = state / 'last-success.json'
        if failure.exists() and (not success.exists() or failure.stat().st_mtime_ns >= success.stat().st_mtime_ns):
            incident = 'failed:' + private(failure)['at']
        elif success.exists():
            incident = 'stale:' + private(success)['created_at']
        else:
            incident = 'missing-success'
        ref = str(uuid.uuid5(uuid.NAMESPACE_URL, 'mikluha-backup/' + scope + '/' + incident))
        ack = state / 'last-alert.json'
        if ack.exists() and private(ack).get('reference') == ref:
            return {'result': 'DEDUPLICATED', 'reference': ref}
        body = {'apiKey': key['apiKey'], 'title': '[P1][' + scope.upper() + '] Mikluha backup failure',
                'app': 'mikluha-native-backup', 'event': kind, 'action': 'Check backup and freshness units',
                'timestamp': now.isoformat(), 'reference': ref}
        outcome = sender(body, ref)
        if outcome.get('provider_acceptance') != 'ACCEPTED':
            raise ValueError('unconfirmed provider acceptance')
        report = dict(result='PASS', reference=ref, at=now.isoformat(), event=event, **outcome)
        tmp = state / ('.alert-' + uuid.uuid4().hex)
        fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as h:
            json.dump(report, h);h.flush();os.fsync(h.fileno())
        os.replace(tmp, ack)
        return report


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2 or sys.argv[1] not in EVENTS:
        raise ValueError('root scoped handler only')
    event = sys.argv[1];scope = event.split('-')[0]
    print(json.dumps(notify(event, Path('/etc/mikluha-native') / scope / 'notify.credentials',
                            Path('/var/lib/mikluha-native-backup') / scope)))


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as error:
        print('MIKLUHA_BACKUP_ALERT=REFUSED http_status=' + str(error.code), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('MIKLUHA_BACKUP_ALERT=FAIL; diagnostic values suppressed', file=sys.stderr)
        sys.exit(1)
