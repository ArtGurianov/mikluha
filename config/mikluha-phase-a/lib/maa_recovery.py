"""Manual Phase A retrieval helpers. Trusted provider metadata, not producer pins."""
import datetime as dt
import os
import pathlib
import stat
from email.utils import parsedate_to_datetime


def private_file(path):
    path=pathlib.Path(path);s=path.lstat()
    if path.resolve()!=path or not path.is_file() or s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)!=0o600:
        raise ValueError('private identity/generation file ownership/mode')
    return path


def timestamp(value):
    try:t=dt.datetime.fromisoformat(value.replace('Z','+00:00'))
    except ValueError:t=parsedate_to_datetime(value)
    if t.tzinfo is None:raise ValueError('explicit timezone required')
    return t.astimezone(dt.timezone.utc)


def owner_cutoff(value, now=None):
    now=now or dt.datetime.now(dt.timezone.utc)
    t=timestamp(value)
    if t>now:raise ValueError('incident cutoff cannot be in the future')
    # Exclude the WHOLE cutoff second: S3 timestamps may have second precision.
    return t.replace(microsecond=0)


def checked_head(c, provider, key, cutoff):
    h=provider.head(key)
    modified=timestamp(h['LastModified'])
    now=dt.datetime.now(dt.timezone.utc)
    days=c['backup']['remote_days']+c['backup'].get('noncurrent_days',0)
    if not modified<cutoff or not 0<=(now-modified).total_seconds()<=days*86400:
        raise ValueError('provider object not before cutoff or outside retention window')
    return h


def select_manifest(c, provider, cutoff, manifest_key=None):
    """Choose the newest complete provider pair strictly before owner cutoff.

    Partial/unmatched uploads may be skipped; provider errors, inconsistent metadata
    and later integrity failures are NOT silently replaced with an older archive.
    """
    from maa_backup import object_pattern
    end=owner_cutoff(cutoff)
    if manifest_key is not None and (not isinstance(manifest_key,str) or not object_pattern(c).fullmatch(manifest_key) or not manifest_key.endswith('.manifest.json')):
        raise ValueError('unowned manifest selection')
    rows=provider.records(manifest_key.removesuffix('.manifest.json')) if manifest_key else provider.records()
    if any('VersionId' in r for r in rows):
        grouped={}
        for row in rows:
            if not object_pattern(c).fullmatch(row['Key']) or not isinstance(row.get('VersionId'),str) or not row['VersionId']:
                raise ValueError('unqualified version listing')
            if timestamp(row['LastModified'])<end:
                grouped.setdefault(row['Key'],[]).append(row)
        snapshot={}
        for key,versions in grouped.items():
            newest=max(timestamp(r['LastModified']) for r in versions)
            latest=[r for r in versions if timestamp(r['LastModified'])==newest]
            if len(latest)!=1:raise ValueError('ambiguous provider version time')
            if not latest[0].get('DeleteMarker'):snapshot[key]=latest[0]
        candidates=[r for k,r in snapshot.items() if k.endswith('.manifest.json') and (manifest_key is None or k==manifest_key)]
        for row in sorted(candidates,key=lambda r:(timestamp(r['LastModified']),r['Key']),reverse=True):
            cipher=row['Key'].removesuffix('.manifest.json')+'.tar.age'
            if cipher not in snapshot:continue
            refs={}
            for label,record in [('manifest',row),('cipher',snapshot[cipher])]:
                ref={k:record[k] for k in ('Key','VersionId')}
                head=checked_head(c,provider,ref,end)
                # Cloud.ru listings retain milliseconds, HTTP HEAD uses seconds.
                # The whole cutoff second is excluded, and immutable VersionId
                # plus ETag must STILL match exactly; do not compare text formats.
                same_second=timestamp(head['LastModified']).replace(microsecond=0)==timestamp(record['LastModified']).replace(microsecond=0)
                if not same_second or any(head.get(k)!=record.get(k) for k in ('VersionId','ETag')):
                    raise ValueError('provider version differs from listing')
                refs[label]=ref
            return refs
        raise ValueError('no complete versioned backup before owner cutoff')
    # Legacy non-versioned fixture/provider contract. AwsProvider always supplies
    # VersionId, including the literal "null" for pre-enablement data.
    keys={r['Key'] for r in rows}
    eligible=[]
    for row in rows:
        if not object_pattern(c).fullmatch(row['Key']):raise ValueError('foreign backup record')
        if row['Key'].endswith('.manifest.json') and timestamp(row['LastModified'])<end:
            cipher=row['Key'].removesuffix('.manifest.json')+'.tar.age'
            if cipher in keys:eligible.append(row)
    for row in sorted(eligible,key=lambda r:(timestamp(r['LastModified']),r['Key']),reverse=True):
        key=row['Key'];cipher=key.removesuffix('.manifest.json')+'.tar.age'
        m=provider.head(key);a=provider.head(cipher)
        # Listing->HEAD overwrite is a race, not a new candidate to trust.
        if any(m.get(k)!=row.get(k) for k in ('ETag','LastModified')):
            raise ValueError('provider changed after listing')
        if timestamp(m['LastModified'])>=end or timestamp(a['LastModified'])>=end:continue
        checked_head(c,provider,key,end);checked_head(c,provider,cipher,end)
        return key
    raise ValueError('no complete provider backup before owner cutoff')
