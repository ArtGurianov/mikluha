#!/usr/bin/env python3
"""Read-only, sanitized VPS inventory. Run only with owner SSH authority; no env/secret dumps."""
import datetime
import json
import os
import socket
import subprocess


def run(*args):
    return subprocess.check_output(args, text=True, timeout=15).strip()

containers = run('docker', 'ps', '--format', '{{.Names}}').splitlines()
site = next(n for n in containers if n.startswith('pxetekoyzceundmfpuapik4q-'))
# Sparse Docker format avoids full Config.Env and labels that can contain credentials.
identity = json.loads(run('docker', 'inspect', site, '--format',
    '{"image":{{json .Config.Image}},"memoryLimit":{{.HostConfig.Memory}},"nanoCpus":{{.HostConfig.NanoCpus}}}'))
conf = run('docker', 'exec', site, 'cat', '/etc/nginx/conf.d/default.conf')
mem = dict((line.split(':')[0], line.split(':')[1].strip()) for line in open('/proc/meminfo'))
result = {'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'scope': 'READ_ONLY_NO_VPS_INSTALL_OR_MUTATION', 'cpuCount': os.cpu_count(),
          'loadAverage': os.getloadavg(), 'memoryAvailable': mem['MemAvailable'],
          'memoryTotal': mem['MemTotal'], 'rootDisk': run('df', '-B1', '/'),
          'site': identity, 'siteNginxConfig': conf,
          's3IPv4': sorted(set(x[4][0] for x in socket.getaddrinfo('mikluha-maklai.s3.cloud.ru', 443,
                                                                                family=socket.AF_INET))),
          'proxyImage': run('docker', 'inspect', 'coolify-proxy', '--format', '{{.Config.Image}}'),
          'siteStats': run('docker', 'stats', '--no-stream', '--format',
                          '{{.CPUPerc}} | {{.MemUsage}} | {{.NetIO}} | {{.BlockIO}}', site),
          'qualification': {'vpsExactPhysicalLocation': 'NOT_CONFIRMED_BY_ACCOUNT_RECEIPT',
                            's3ExactPhysicalLocation': 'NOT_CONFIRMED_BY_BUCKET_ACCOUNT_RECEIPT',
                            'commercialRegression': 'NOT_RUN_NO_LOAD_ON_SHARED_VPS'}}
print(json.dumps(result, ensure_ascii=False, indent=2))
