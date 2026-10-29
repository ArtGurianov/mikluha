#!/usr/bin/env python3
"""Manual regional HTTP probe: stdlib + curl; no Docker, SSH, credentials or S3 writes."""
import argparse
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import random
import shutil
import subprocess
import tempfile
import time
from urllib.parse import urlsplit

SOURCES = [
    ('thumbnail', 'https://mikluha-maklai.s3.cloud.ru/cms/mikluha-thumbnail.webp'),
    ('gallery', 'https://mikluha-maklai.s3.cloud.ru/cms/organized.webp'),
]
SAFE_HEADERS = {'content-type', 'content-length', 'etag', 'last-modified', 'cache-control',
                'x-cache-status', 'x-content-type-options', 'access-control-allow-origin'}
TIMINGS = {'dnsMs': 'time_namelookup', 'connectMs': 'time_connect',
           'tlsMs': 'time_appconnect', 'ttfbMs': 'time_starttransfer', 'totalMs': 'time_total'}


def quantiles(values):
    ordered = sorted(values)
    return {f'p{p}': ordered[math.ceil(len(ordered) * p / 100) - 1]
            for p in (50, 75, 95)} if ordered else None


def summarize(rows):
    good = [r for r in rows if r['ok']]
    states = {}
    for r in rows:
        state = r.get('headers', {}).get('x-cache-status', 'UNKNOWN')
        states[state] = states.get(state, 0) + 1
    return {'requests': len(rows), 'ok': len(good), 'errors': len(rows) - len(good),
            'ttfbMs': quantiles([r['ttfbMs'] for r in good]),
            'totalMs': quantiles([r['totalMs'] for r in good]),
            'downloadedBytes': sum(r.get('bytes', 0) for r in rows), 'cacheStates': states}


def observe(url, work):
    # No proxy credentials or request headers from the shell/system are forwarded.
    # curl -q also ignores ~/.curlrc. VPN routing itself cannot be verified by this script.
    header_file, body_file = work / 'headers', work / 'body'
    for file in (header_file, body_file):
        file.unlink(missing_ok=True)
    process = subprocess.run([
        'curl', '-q', '--silent', '--show-error', '--noproxy', '*',
        '--proto', '=https', '--connect-timeout', '5', '--max-time', '15',
        '--max-filesize', '1048576', '--dump-header', str(header_file),
        '--output', str(body_file), '--write-out', '%{json}', url,
    ], capture_output=True, text=True)
    try:
        metrics = json.loads(process.stdout)
    except (ValueError, TypeError):
        metrics = {}
    headers = {}
    if header_file.exists():
        for line in header_file.read_text(errors='replace').splitlines():
            if ':' in line:
                key, value = line.split(':', 1)
                if key.lower() in SAFE_HEADERS:
                    headers[key.lower()] = value.strip()
    body = body_file.read_bytes() if body_file.exists() else b''
    status = int(metrics.get('http_code', 0))
    result = {'status': status, 'curlExit': process.returncode, 'headers': headers,
              'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest() if status == 200 else None,
              'ok': process.returncode == 0 and status == 200 and headers.get('content-type') == 'image/webp'}
    for name, key in TIMINGS.items():
        result[name] = round(float(metrics.get(key, 0)) * 1000, 3)
    # These are cumulative curl timings, not isolated phase durations.
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--city', required=True, help='operator-declared location, e.g. Кемерово')
    parser.add_argument('--network', required=True, help='non-personal label: home, mobile, office')
    parser.add_argument('--vpn', choices=['off', 'on', 'unknown'], required=True,
                        help='operator declaration; the script cannot prove system VPN routing')
    parser.add_argument('--samples', type=int, default=30, help='GETs per image per path (1..100)')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cache-base', help='optional REAL test cache base, e.g. https://media-test.example/processed/')
    args = parser.parse_args()
    if not 1 <= args.samples <= 100:
        parser.error('--samples must be between 1 and 100')
    if not shutil.which('curl'):
        parser.error('curl is required')
    if args.cache_base:
        parsed = urlsplit(args.cache_base)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            parser.error('--cache-base must be an HTTPS base without credentials, query or fragment')
        if not parsed.path.endswith('/'):
            parser.error('--cache-base must end in /')
    report = {
        'schema': 'tour88-manual-probe-v1',
        'probeSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'curlVersion': subprocess.check_output(['curl', '-q', '--version'], text=True).splitlines()[0],
        'requestedSamplesPerPath': args.samples,
        'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'operatorDeclared': {'city': args.city, 'network': args.network, 'vpn': args.vpn},
        'scope': 'REGIONAL_DIRECT_BASELINE' if not args.cache_base else 'REGIONAL_DIRECT_AND_TEST_CACHE_HTTP',
        'cacheBase': args.cache_base, 'coldCacheControlled': False,
        'samplePolicy': 'fresh curl process and TLS per request; randomized image/mode order; OS DNS cache may be warm',
        'proxyPolicy': 'curl config ignored, explicit/system HTTP proxies bypassed; VPN declaration not independently verified',
        'proxyEnvironmentNamesPresent': sorted(k for k in os.environ if k.lower() in
            ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']),
        'limitations': ['HTTP timings only; no browser/mobile LCP',
                        'MISS/HIT uses observed header only; first request is not assumed cold',
                        'No regional VPS-cache comparison without an actual test cache endpoint',
                        'Do not use a localhost cache result as Kemerovo-to-VPS performance'],
        'objects': [], 'result': 'RUNNING',
    }
    args.output = args.output.expanduser().resolve()
    args.output.parent.mkdir(parents=True, exist_ok=True)

    def save():
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')

    print(f"Location: {args.city}; network: {args.network}; VPN: {args.vpn} (operator declaration)", flush=True)
    if not args.cache_base:
        print('Direct S3 only: a VPS cache endpoint has not been supplied.', flush=True)
    try:
        with tempfile.TemporaryDirectory(prefix='tour88-probe-') as directory:
            work = Path(directory)
            tasks = []
            for index, (name, url) in enumerate(SOURCES):
                item = {'name': name, 'originUrl': url, 'direct': [], 'cache': []}
                report['objects'].append(item)
                # Pin reference bytes for comparison; this is not counted as a timing sample.
                item['reference'] = observe(url, work)
                if not item['reference']['ok']:
                    raise RuntimeError(f'Cannot pin public reference {name}; see JSON')
                if args.cache_base:
                    item['cacheUrl'] = (args.cache_base + item['reference']['sha256']
                                        + f'/source-{index}-warm.webp')
                for _ in range(args.samples):
                    tasks.append((item, 'direct', url))
                    if args.cache_base:
                        tasks.append((item, 'cache', item['cacheUrl']))
            random.Random(88).shuffle(tasks)
            for index, (item, mode, url) in enumerate(tasks, 1):
                sample = observe(url, work)
                if sample['ok'] and sample['sha256'] != item['reference']['sha256']:
                    sample['ok'] = False
                    sample['failure'] = 'BYTE_IDENTITY_MISMATCH'
                item[mode].append(sample)
                if index % 10 == 0 or index == len(tasks):
                    print(f'{index}/{len(tasks)} requests', flush=True)
                save()  # Partial results survive an interruption.
                time.sleep(.1)
        errors = 0
        for item in report['objects']:
            for mode in ['direct', 'cache']:
                if not item[mode]:
                    continue
                summary = summarize(item[mode])
                item[mode + 'Summary'] = summary
                errors += summary['errors']
                print(f"{item['name']} / {mode}: {summary['ok']}/{summary['requests']} OK; "
                      f"TTFB ms {summary['ttfbMs']}; total ms {summary['totalMs']}; "
                      f"cache {summary['cacheStates']}", flush=True)
                if mode == 'cache':
                    item['cacheByObservedState'] = {
                        state: summarize([r for r in item[mode] if r.get('headers', {}).get('x-cache-status') == state])
                        for state in ['MISS', 'HIT', 'REVALIDATED', 'EXPIRED', 'BYPASS']
                        if any(r.get('headers', {}).get('x-cache-status') == state for r in item[mode])}
        report['result'] = 'PASS_HTTP_OBSERVATIONS' if errors == 0 else 'ERRORS_OBSERVED'
    except BaseException as error:
        report['result'] = 'INTERRUPTED' if isinstance(error, KeyboardInterrupt) else 'FAILED'
        report['errorType'] = type(error).__name__
        raise
    finally:
        report['finishedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        save()
        print(f'Result: {args.output}', flush=True)
    return 0 if report['result'] == 'PASS_HTTP_OBSERVATIONS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
