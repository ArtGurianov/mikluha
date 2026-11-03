#!/usr/bin/env python3
"""Read-only direct-S3 baseline, 20 sequential GETs/key (not a cache comparison).
May run via ssh adman-vps 'python3 - --vantage adman-vps' < this-file.
No credentials, cookies, private objects, image persistence or client IP logs.
"""
import argparse
import datetime
import hashlib
import json
import math
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('--vantage', required=True, choices=['adman-vps', 'operator-mac'])
args = parser.parse_args()
urls = ['https://mikluha-maklai.s3.cloud.ru/cms/mikluha-thumbnail.webp',
        'https://mikluha-maklai.s3.cloud.ru/cms/organized.webp']
report = {'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'vantage': args.vantage,
          'scope': 'DIRECT_S3_READ_ONLY_BASELINE_NOT_REGIONAL_COMPARISON',
          'notes': ['operator-mac location/network not independently verified',
                    'new TLS connection per sample; cold browser, no cookies; no provider billing measurement',
                    'legacy mutable object names: inventory only, not eligible immutable cache keys'], 'objects': []}
for url in urls:
    rows = []
    headers = {}
    for _ in range(20):
        start = time.monotonic()
        try:
            with urllib.request.urlopen(url, timeout=8) as res:
                ttfb = time.monotonic() - start
                body = res.read(1024 * 1024 + 1)
                row = {'status': res.status, 'ttfbMs': round(ttfb * 1000, 3),
                       'totalMs': round((time.monotonic() - start) * 1000, 3), 'bytes': len(body),
                       'sha256': hashlib.sha256(body).hexdigest()}
                headers = {k.lower(): v for k, v in res.headers.items() if k.lower() in
                           ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified',
                            'access-control-allow-origin', 'x-content-type-options']}
        except (OSError, urllib.error.URLError) as error:
            row = {'status': 'ERROR', 'errorType': type(error).__name__}
        rows.append(row)
        time.sleep(.1)
    good = [row for row in rows if row['status'] == 200]
    def percentiles(field):
        values = sorted(row[field] for row in good)
        return {f'p{p}': values[math.ceil(len(values) * p / 100) - 1] for p in [50, 75, 95]} if values else None
    report['objects'].append({'url': url, 'headers': headers, 'samples': rows,
                              'ttfbMs': percentiles('ttfbMs'), 'totalMs': percentiles('totalMs'),
                              'errorCount': len(rows) - len(good), 'requests': len(rows),
                              'downloadedBytes': sum(row['bytes'] for row in good)})
print(json.dumps(report, ensure_ascii=False, indent=2))
