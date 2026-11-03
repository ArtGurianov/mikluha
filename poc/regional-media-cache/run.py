#!/usr/bin/env python3
"""Local fixture qualification; --real-s3 adds bounded public GETs. Never connects to VPS."""
import argparse
import concurrent.futures
import datetime
import hashlib
import http.client
import json
import math
import os
import pathlib
import shutil
import ssl
import subprocess
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('output', nargs='?', default=str(pathlib.Path(__file__).with_name('result.json')))
parser.add_argument('--vantage', choices=['operator-mac', 'adman-vps'], default='operator-mac')
parser.add_argument('--real-s3', action='store_true', help='also make bounded anonymous GETs to two fixed public S3 WebP')
args = parser.parse_args()
ROOT = pathlib.Path(__file__).resolve().parent
RUNTIME = ROOT / '.runtime'
BODY = b'RIFF synthetic WebP fixture (not a real photograph)'
DIGEST = hashlib.sha256(BODY).hexdigest()
PREFIX = f'/processed/{DIGEST}/'
NAMES = ['hero', 'gallery', 'collapse', 'missing', 'error', 'timeout', 'cookie', 'private',
         'wrong-type', 'oversize', 'chunked', 'redirect', 'changed', 'http-redirect', 'untrusted-tls']
# Refuse remote engines: this task grants read-only VPS access, not remote Docker writes.
endpoint = os.environ.get('DOCKER_HOST') or subprocess.check_output(
    ['docker', 'context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], text=True).strip()
if not endpoint.startswith('unix://'):
    raise RuntimeError('PoC requires a local Unix-socket Docker engine; remote Docker is prohibited')
PROJECT = 'mikluha-tour88-local'
os.environ['POC_UID'] = str(os.getuid() or 101)
os.environ['POC_GID'] = str(os.getgid() or 101)
REPORT = {'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'scope': 'LOCAL_SYNTHETIC_ONLY', 'checks': [], 'observations': {},
          'productionQualification': 'NO_GO', 'ownerDecision': 'PENDING'}


def compose(*args):
    return subprocess.check_output(['docker', 'compose', '-p', PROJECT, '-f', str(ROOT / 'compose.yaml'),
                                    *args], cwd=ROOT, text=True).strip()


def check(name, ok, evidence):
    REPORT['checks'].append({'check': name, 'pass': bool(ok), 'evidence': evidence})
    print(f'{"PASS" if ok else "FAIL"} {name}', flush=True)
    if not ok:
        raise AssertionError(f'{name}: {evidence}')


def request(path, headers=None, method='GET', origin=False):
    start = time.monotonic()
    if origin:
        conn = http.client.HTTPConnection('127.0.0.1', origin_port, timeout=5)
    else:
        conn = http.client.HTTPSConnection('127.0.0.1', edge_port, timeout=12, context=context)
    try:
        conn.request(method, path, headers={'Host': 'media.localhost', **(headers or {})})
        res = conn.getresponse()
        ttfb = time.monotonic() - start
        data = res.read()
        return {'status': res.status, 'headers': dict((k.lower(), v) for k, v in res.getheaders()),
                'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                'ttfbMs': round(ttfb * 1000, 3), 'totalMs': round((time.monotonic() - start) * 1000, 3)}
    finally:
        conn.close()


def stats():
    conn = http.client.HTTPConnection('127.0.0.1', origin_port, timeout=3)
    conn.request('GET', '/__stats')
    result = json.loads(conn.getresponse().read())
    conn.close()
    return result


def control(path):
    request('/__' + path, origin=True)


def count(path):
    return stats().get(path, 0)


def percentiles(values):
    values = sorted(values)
    return {f'p{p}': values[max(0, math.ceil(len(values) * p / 100) - 1)] for p in [50, 75, 95]}


def allow(names):
    # Fixed finite fixture keys; no user-controlled nginx configuration interpolation.
    (RUNTIME / 'allowed.map').write_text(''.join(f'~^{PREFIX}{n}[.]webp$ 1;\n' for n in names))


created = False
try:
    if RUNTIME.exists():
        raise RuntimeError('.runtime already exists: inspect/remove a previous run with compose down first')
    RUNTIME.mkdir()
    created = True
    (RUNTIME / 'cache').mkdir()
    (RUNTIME / 'cache').chmod(0o777)  # Only synthetic fixture data, isolated from host credentials.
    (RUNTIME / 'certs').mkdir()
    allow(NAMES)
    objects = {PREFIX + n + '.webp': {'url': 'http://origin:8080' + PREFIX + n + '.webp',
               'sha256': DIGEST, 'etag': f'"{DIGEST}"',
               'lastModified': 'Thu, 01 Jan 2026 00:00:00 GMT'} for n in NAMES}
    objects[PREFIX + 'untrusted-tls.webp']['url'] = 'https://origin:8443' + PREFIX + 'untrusted-tls.webp'
    (RUNTIME / 'objects.mjs').write_text('export default ' + json.dumps(objects) + ';\n')
    (RUNTIME / 'fetch-budget.conf').write_text('js_fetch_timeout 900ms;\n')
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                    '-subj', '/CN=media.localhost', '-addext',
                    'subjectAltName=DNS:media.localhost,IP:127.0.0.1',
                    '-keyout', str(RUNTIME / 'certs/key.pem'), '-out', str(RUNTIME / 'certs/cert.pem')],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    compose('up', '-d', '--wait', '--wait-timeout', '45')
    edge_port = int(compose('port', 'edge', '8443').rsplit(':', 1)[1])
    origin_port = int(compose('port', 'origin', '8080').rsplit(':', 1)[1])
    context = ssl.create_default_context(cafile=str(RUNTIME / 'certs/cert.pem'))
    hero, gallery = PREFIX + 'hero.webp', PREFIX + 'gallery.webp'
    for attempt in range(30):
        try:
            if request('/originals/exists.jpg')['status'] == 404:
                break
        except (OSError, ssl.SSLError):
            pass
        time.sleep(.2)
    REPORT['testedFiles'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                            for p in sorted(ROOT.iterdir()) if p.suffix in ['.py', '.yaml', '.conf', '.mjs']}
    REPORT['enforcedContainerLimits'] = {}
    for service in ['edge', 'cache', 'origin']:
        container = compose('ps', '-q', service)
        REPORT['enforcedContainerLimits'][service] = json.loads(subprocess.check_output(
            ['docker', 'inspect', container, '--format',
             '{"memory":{{.HostConfig.Memory}},"nanoCpus":{{.HostConfig.NanoCpus}},'
             '"pids":{{.HostConfig.PidsLimit}},"readOnly":{{.HostConfig.ReadonlyRootfs}}}'], text=True))
    REPORT['boundedFetcherPackage'] = compose('exec', '-T', 'cache', 'apk', 'info', 'nginx-module-njs')
    REPORT['images'] = json.loads(compose('images', '--format', 'json'))
    direct = request(hero, origin=True)
    first, second = request(hero), request(hero)
    check('verified TLS, MISS then HIT, identical bytes',
          first['status'] == second['status'] == 200 and
          first['headers'].get('x-cache-status') == 'MISS' and second['headers'].get('x-cache-status') == 'HIT'
          and first['sha256'] == second['sha256'] == direct['sha256'], [first, second])
    h = second['headers']
    check('WebP, nosniff, CORS, no cookie, browser revalidation', h.get('content-type') == 'image/webp'
          and h.get('x-content-type-options') == 'nosniff' and h.get('access-control-allow-origin') == '*'
          and 'set-cookie' not in h and h.get('cache-control') == 'public, max-age=0, must-revalidate', h)
    check('HEAD has no body', request(hero, method='HEAD')['bytes'] == 0, 'HEAD')
    conditional = request(hero, {'If-None-Match': h['etag']})
    check('browser ETag conditional request', conditional['status'] == 304, conditional)
    existing = request('/originals/exists.jpg', origin=True)
    check('private sentinel actually exists at fixture origin', existing['status'] == 200, existing)
    for path in ['/originals/exists.jpg', '/processed/../originals/exists.jpg',
                 '/processed/%2e%2e/originals/exists.jpg', '/processed/%252e%252e/originals/exists.jpg',
                 hero + '?x=1', hero + '?url=http://origin/originals/exists.jpg', hero + '/..', '/https://origin/originals/exists.jpg',
                 '/processed/%2f..%2foriginals/exists.jpg', '/processed/%5c..%5coriginals/exists.jpg',
                 '/processed/unknown/hero.webp', hero.upper()]:
        response = request(path)
        check('deny raw target ' + path, response['status'] in [400, 404], response['status'])
        time.sleep(.06)
    for alias in [hero.replace('/hero', '/%68ero'), hero.replace('/hero', '//hero')]:
        normalized = request(alias)
        check('edge normalization only reaches the same public key',
              normalized['status'] == 404 or (normalized['status'] == 200
              and normalized['sha256'] == direct['sha256']), normalized)
    check('private denial never contacted origin', count('/originals/exists.jpg') == 1, stats())
    for headers in [{'Authorization': 'Bearer synthetic'}, {'Cookie': 'synthetic=1'}]:
        check('reject credential-bearing request', request(hero, headers)['status'] == 403, list(headers))
    check('reject mutation', request(hero, method='POST')['status'] == 405, 'POST')
    check('host override rejected at edge', request(hero, {'Host': 'attacker.invalid'})['status'] == 404, 'Host')
    poisoned = request(gallery, {'X-Forwarded-Host': 'evil.invalid', 'Range': 'bytes=0-3',
                                'Accept-Encoding': 'made-up', 'X-Original-URL': '/originals/exists.jpg'})
    check('untrusted headers cannot vary origin bytes', poisoned['sha256'] == direct['sha256']
          and 'vary' not in poisoned['headers'], poisoned)
    collapse = PREFIX + 'collapse.webp'
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        burst = list(pool.map(lambda _: request(collapse), range(12)))
    check('concurrent MISS collapse', count(collapse) == 1 and all(x['status'] == 200 for x in burst),
          {'upstreamRequests': count(collapse), 'statuses': [x['headers'].get('x-cache-status') for x in burst]})
    time.sleep(2.2)
    before = count(hero)
    revalidated = request(hero)
    check('expired cache revalidated with ETag', revalidated['headers'].get('x-cache-status') == 'REVALIDATED'
          and count(hero) == before + 1 and revalidated['sha256'] == direct['sha256'], revalidated)
    for name, code in [('missing', 404), ('error', 503), ('timeout', 504)]:
        path = PREFIX + name + '.webp'
        responses = [request(path), request(path)]
        check(name + ' is not cached', all(r['status'] in ([502, 504] if name == 'timeout' else [code]) for r in responses) and count(path) == 2,
              {'statuses': [r['status'] for r in responses], 'upstreamRequests': count(path)})
    for name in ['cookie', 'private', 'wrong-type']:
        path = PREFIX + name + '.webp'
        responses = [request(path), request(path)]
        check(name + ' response never enters cache', count(path) == 2
              and all(r['headers'].get('x-cache-status') != 'HIT' for r in responses)
              and all('set-cookie' not in r['headers'] for r in responses), responses)
    check('X-Accel-Redirect cannot expose original', request(PREFIX + 'redirect.webp')['sha256'] == direct['sha256'],
          'upstream internal redirect ignored')
    for name, expected in [('wrong-type', 415), ('oversize', 502), ('chunked', 502),
                           ('changed', 502), ('http-redirect', 502), ('untrusted-tls', 502)]:
        blocked = request(PREFIX + name + '.webp')
        check(name + ' is refused before delivery/cache', blocked['status'] == expected
              and blocked['bytes'] < 1024 and blocked['sha256'] != direct['sha256'], blocked)
    REPORT['observations']['responseSizeGate'] = {'status': 'PASS', 'maxBytes': 1048576,
        'contentLengthAndChunkedOversize': '502; generic error only; never cached', 'njsMinimum': '1.0.2'}
    REPORT['observations']['mimeGate'] = {'status': 'PASS', 'wrongType': '415; generic error only; never cached'}
    # Origin outage AFTER expiry: never serve stale, including a previously warmed key.
    time.sleep(2.2)
    control('down')
    outage = request(hero)
    check('origin outage never serves stale cached photo', outage['status'] == 503, outage)
    control('up')
    # Restart closes workers before deletion; durable allowlist denial precedes any reopening.
    request(hero)
    request(gallery)
    compose('stop', 'cache')
    allow([n for n in NAMES if n != 'hero'])
    key = hashlib.md5(('public-v1:' + hero).encode(), usedforsecurity=False).hexdigest()
    removed = 0
    for file in (RUNTIME / 'cache').rglob(key):
        if file.is_file():
            file.unlink()
            removed += 1
    compose('start', 'cache')
    time.sleep(.3)
    revoked = request(hero)
    sibling = request(gallery)
    check('scoped revoke: denied key, removed cache file, sibling retained', revoked['status'] == 404
          and removed == 1 and sibling['headers'].get('x-cache-status') in ['HIT', 'REVALIDATED'],
          {'revokedStatus': revoked['status'], 'removedFiles': removed, 'sibling': sibling})
    compose('stop', 'cache')
    check('cache failure is visible (no fabricated success)', request(gallery)['status'] in [502, 503, 504], 'edge upstream down')
    check('direct origin remains independently available', request(gallery, origin=True)['status'] == 200, 'direct')
    compose('start', 'cache')
    # Very small local synthetic timing run, explicitly not regional user evidence.
    samples = [request(gallery) for _ in range(12)]
    REPORT['observations']['localWarmSynthetic'] = {
        'ttfbMs': percentiles([r['ttfbMs'] for r in samples]),
        'totalMs': percentiles([r['totalMs'] for r in samples]),
        'hitRate': sum(r['headers'].get('x-cache-status') == 'HIT' for r in samples) / len(samples),
        'sampleCount': len(samples), 'warning': 'local Docker TLS, tiny synthetic bytes; not S3, regional speed or LCP'}
    REPORT['observations']['upstreamRequestsByFixtureKey'] = stats()
    REPORT['resources'] = compose('stats', '--no-stream', '--format', 'json')
    if args.real_s3:
        # Real bytes, same operator network. No credentials or S3 writes; not regional evidence.
        real = []
        manifest = {}
        urls = ['https://mikluha-maklai.s3.cloud.ru/cms/mikluha-thumbnail.webp',
                'https://mikluha-maklai.s3.cloud.ru/cms/organized.webp']
        def direct_s3(url):
            started = time.monotonic()
            with urllib.request.urlopen(url, timeout=8) as response:
                first_byte = time.monotonic() - started
                body = response.read(1048577)
                if response.status != 200 or response.headers.get('Content-Type') != 'image/webp' or len(body) > 1048576:
                    raise ValueError('real public WebP does not meet admission bounds')
                return {'status': response.status, 'ttfbMs': round(first_byte * 1000, 3),
                        'totalMs': round((time.monotonic() - started) * 1000, 3),
                        'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest(),
                        'etag': response.headers.get('ETag'), 'lastModified': response.headers.get('Last-Modified')}
        for index, url in enumerate(urls):
            original = direct_s3(url)
            prefix = f"/processed/{original['sha256']}/source-{index}"
            keys = [prefix + '-warm.webp'] + [prefix + f'-cold-{i}.webp' for i in range(10)]
            for key in keys:
                manifest[key] = {'url': url, 'sha256': original['sha256'], 'etag': original['etag'],
                                 'lastModified': original['lastModified']}
            real.append({'url': url, 'expected': original, 'keys': keys,
                         'direct': [], 'cold': [], 'warm': []})
        compose('stop', 'cache')
        (RUNTIME / 'allowed.map').write_text(''.join('~^' + key.replace('.', '[.]') + '$ 1;\n' for key in manifest))
        (RUNTIME / 'objects.mjs').write_text('export default ' + json.dumps(manifest) + ';\n')
        (RUNTIME / 'fetch-budget.conf').write_text('js_fetch_timeout 8s;\n')
        compose('start', 'cache')
        time.sleep(.3)
        for item in real:
            for i in range(10):
                # Alternate direct/cold ordering; warm is primed immediately before measuring.
                if i % 2 == 0:
                    item['direct'].append(direct_s3(item['url']))
                    item['cold'].append(request(item['keys'][i + 1]))
                else:
                    item['cold'].append(request(item['keys'][i + 1]))
                    item['direct'].append(direct_s3(item['url']))
                prime = request(item['keys'][0])
                if prime['status'] != 200:
                    raise AssertionError('real S3 cache prime failed: ' + str(prime))
                item['warm'].extend([request(item['keys'][0]), request(item['keys'][0])])
            for mode in ['direct', 'cold', 'warm']:
                samples = item[mode]
                good = [r for r in samples if r['status'] == 200]
                item[mode + 'Summary'] = {'sampleCount': len(samples), 'errorCount': len(samples) - len(good),
                    'ttfbMs': percentiles([r['ttfbMs'] for r in good]),
                    'totalMs': percentiles([r['totalMs'] for r in good]),
                    'hitCount': sum(r.get('headers', {}).get('x-cache-status') == 'HIT' for r in samples)}
                check('real S3 ' + mode + ' byte identity', all(r['status'] == 200
                      and r['sha256'] == item['expected']['sha256'] for r in samples), item[mode + 'Summary'])
            check('real S3 cold requests are MISS', all(r['headers'].get('x-cache-status') == 'MISS'
                  for r in item['cold']), item['coldSummary'])
            check('real S3 measured warm requests are HIT', item['warmSummary']['hitCount'] == 20, item['warmSummary'])
            del item['keys']
        REPORT['realS3LocalComparison'] = {'scope': 'ONE_VANTAGE_LOCAL_DOCKER_NOT_REGIONAL_OR_LCP', 'vantage': args.vantage,
            'tls': 'test CA for local edge; system CA and verify=true for S3 via njs',
            'originNames': 'legacy mutable sources; local content-addressed alias verifies pinned SHA-256',
            'objects': real}
    REPORT['result'] = 'SYNTHETIC_CHECKS_PASS_PRODUCTION_NOT_QUALIFIED'
except BaseException as exc:
    if created:
        print(compose('logs', '--tail', '20'), flush=True)
    REPORT['result'] = 'FAIL'
    REPORT['error'] = str(exc)
    raise
finally:
    output = pathlib.Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(REPORT, ensure_ascii=False, indent=2) + '\n')
    if created:
        compose('down', '--remove-orphans')
        shutil.rmtree(RUNTIME)
