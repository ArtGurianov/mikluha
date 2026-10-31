"""Manual Mac qualification uses an explicit owner-held local policy, never Git/private infra."""
import json
import os
from pathlib import Path
import stat
import subprocess

OVERRIDES = ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
             'BUILDX_BUILDER', 'BUILDKIT_HOST', 'DOCKER_BUILDKIT')


def command(args):
    p = subprocess.run(args, capture_output=True, timeout=60)
    if p.returncode:
        raise RuntimeError('Local Docker command failed; output suppressed')
    return p.stdout


def engine_policy():
    path = Path(os.environ.get('MIKLUHA_LOCAL_DOCKER_POLICY',
                              str(Path.home() / '.config/mikluha/local-docker.json')))
    st = path.lstat()
    if (not path.is_absolute() or not stat.S_ISREG(st.st_mode)
            or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) != 0o600):
        raise ValueError('Private operator Docker policy required')
    p = json.loads(path.read_text())
    if (set(p) != {'schema', 'context', 'endpoint', 'socket_owner_uid', 'daemon'}
            or p['schema'] != 1 or p['context'] != 'desktop-linux'
            or not isinstance(p['endpoint'], str) or not p['endpoint'].startswith('unix:///')
            or type(p['socket_owner_uid']) is not int
            or set(p['daemon']) != {'ID', 'Name', 'OperatingSystem', 'OSType'}
            or not p['daemon']['ID'] or p['daemon']['Name'] != 'docker-desktop'
            or p['daemon']['OperatingSystem'] != 'Docker Desktop' or p['daemon']['OSType'] != 'linux'):
        raise ValueError('Invalid explicitly approved local Docker policy')
    return p


class DockerEngine(list):
    def __init__(self, policy):
        super().__init__(['docker', '--host', policy['endpoint']])
        self.policy = policy


def verify_engine(docker):
    if not isinstance(docker, DockerEngine):
        raise ValueError('Unapproved Docker handle')
    if any(os.environ.get(name) for name in OVERRIDES):
        raise ValueError('Remote Docker override refused')
    p = docker.policy
    context = command(['docker', 'context', 'show']).decode().strip()
    if context != p['context']:
        raise ValueError('Docker context differs from owner approval')
    details = json.loads(command(['docker', 'context', 'inspect', context]))
    if (len(details) != 1 or details[0].get('Name') != context
            or details[0]['Endpoints']['docker']['Host'] != p['endpoint']):
        raise ValueError('Docker endpoint differs from owner approval')
    st = Path(p['endpoint'].removeprefix('unix://')).lstat()
    if (not stat.S_ISSOCK(st.st_mode) or st.st_uid != p['socket_owner_uid']
            or st.st_uid != os.getuid() or st.st_mode & 0o022):
        raise ValueError('Untrusted local Docker socket')
    info = json.loads(command([*docker, 'info', '--format', '{{json .}}']))
    if {k: info.get(k) for k in p['daemon']} != p['daemon']:
        raise ValueError('Docker daemon differs from owner approval')
    return p


def local_docker():
    docker = DockerEngine(engine_policy())
    verify_engine(docker)
    return docker
