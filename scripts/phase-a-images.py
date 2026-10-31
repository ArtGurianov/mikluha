#!/usr/bin/env python3
"""Build-only image publication receipts. No deploy, cloud credentials or live target."""
import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
import tempfile
import uuid
from urllib.parse import urlsplit

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPOSITORY = 'ArtGurianov/mikluha'
ROLES = {
    'site': dict(image='mikluha-site-ssr', context='.', file='Dockerfile', target='runtime',
                 path='/app/public/release.json', service='mikluha-site', schema=2,
                 command=['node', '--no-experimental-require-module', 'server.js']),
    'commerce': dict(image='mikluha-commerce', context='.', file='commerce/Dockerfile', target='service',
                     path='/app/identity/identity.json', service='mikluha-commerce', schema=1,
                     command=['node', 'dist/bin/serve.js']),
    'admin': dict(image='mikluha-control-room', context='control-room', file='control-room/Dockerfile', target='runtime',
                  path='/usr/share/nginx/html/identity.json', service='mikluha-control-room', schema=1,
                  command=['nginx', '-g', 'daemon off;']),
    'worker': dict(image='mikluha-media-worker', context='.', file='commerce/Dockerfile', target='media-worker',
                   path='/app/identity/identity.json', service='mikluha-commerce', schema=1,
                   command=['node', 'dist/bin/media-worker.js']),
    'decoder': dict(image='mikluha-media-decoder', context='.', file='commerce/Dockerfile', target='media-decoder',
                    path='/app/identity/identity.json', service='mikluha-commerce', schema=1,
                    command=['node', 'dist/bin/media-decoder.js']),
}
LEGAL_HASHES = {
    'privacy-policy': '359615e732329e3f85a0807d153ff3a153bbe53a55105ae9e7610c308a5cc0e4',
    'cookies': '71d4e6fbbca71d707d904fe2f370d2245a4e4faa16ecdd998f7cd0d980e2252c',
}


def image_name(role):
    return 'ghcr.io/artgurianov/' + ROLES[role]['image']


def inputs(source, deploy_env, site_url):
    if not re.fullmatch('[0-9a-f]{40}', source or '') or deploy_env not in ('staging', 'production'):
        raise ValueError('exact source and deployment environment required')
    u = urlsplit(site_url)
    if (u.scheme != 'https' or not u.hostname or u.username or u.password or u.query or u.fragment
        or u.path not in ('', '/') or u.port not in (None, 443)
        or not re.fullmatch(r'https://[a-z0-9.-]+(?::443)?/?', site_url)):
        raise ValueError('HTTPS site origin required')
    return dict(source_commit=source, deploy_env=deploy_env, site_url=site_url.rstrip('/'))


def run_identity(run_id, attempt):
    if not re.fullmatch('[1-9][0-9]*', str(run_id)) or not re.fullmatch('[1-9][0-9]*', str(attempt)):
        raise ValueError('run identity required')
    return dict(run_id=str(run_id), run_attempt=str(attempt))


def plan(source, deploy_env, site_url, ref, repository):
    build = inputs(source, deploy_env, site_url)
    if ref != 'refs/heads/main' or repository != REPOSITORY:
        raise ValueError('publication only from canonical main')
    matrix = [dict(role=role, image=image_name(role), context=s['context'], file=s['file'], target=s['target'])
              for role, s in ROLES.items()]
    return dict(build=build, matrix={'include': matrix})


def source_check(source):
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if head != source:
        raise ValueError('checkout differs from dispatched commit')
    for slug, expected in LEGAL_HASHES.items():
        p = ROOT / 'docs/legal/2026-10-30-ssr-admin' / (slug + '.md')
        if hashlib.sha256(p.read_bytes()).hexdigest() != expected:
            raise ValueError('approved legal source changed')
    if not (ROOT / 'docs/runbooks/2026-10-30-ssr-admin-operational-acceptance.md').is_file():
        raise ValueError('Phase A runbook missing')
    descriptor = (ROOT / 'lib/release-descriptor.ts').read_text()
    if 'legalAuthority: "commerce"' not in descriptor or 'schema: 2' not in descriptor:
        raise ValueError('live legal authority source missing')


def image_receipt(role, digest, source, deploy_env, site_url, run_id, attempt, inspect, identity):
    build = inputs(source, deploy_env, site_url)
    workflow = run_identity(run_id, attempt)
    if role not in ROLES or not re.fullmatch(r'sha256:[0-9a-f]{64}', digest or ''):
        raise ValueError('unknown role or nonimmutable digest')
    spec = ROLES[role]; ref = image_name(role) + '@' + digest
    if (inspect.get('Os') != 'linux' or inspect.get('Architecture') != 'amd64'
        or ref not in (inspect.get('RepoDigests') or []) or inspect.get('Config', {}).get('Cmd') != spec['command']):
        raise ValueError('registry digest/platform/role command mismatch')
    if (not isinstance(identity, dict) or identity.get('sourceCommit') != source
        or type(identity.get('schema')) is not int or identity.get('schema') != spec['schema'] or identity.get('service') != spec['service']
        or (role == 'site' and identity.get('legalAuthority') != 'commerce')):
        raise ValueError('baked source/service identity mismatch')
    return dict(format='mikluha.phase-a-image/1', role=role, image=ref, platform='linux/amd64',
                build=build, workflow=workflow, identity=identity,
                verification='REGISTRY_DIGEST_AND_BAKED_IDENTITY', deployment='NOT_RUN')


def assemble(receipts, source, deploy_env, site_url, run_id, attempt):
    build = inputs(source, deploy_env, site_url); workflow = run_identity(run_id, attempt)
    if len(receipts) != len(ROLES) or {r.get('role') for r in receipts} != set(ROLES):
        raise ValueError('exactly one receipt for every role required')
    images = {}
    for r in receipts:
        role = r['role']; ref = r.get('image', '')
        if (r.get('format') != 'mikluha.phase-a-image/1' or r.get('build') != build or r.get('workflow') != workflow
            or r.get('verification') != 'REGISTRY_DIGEST_AND_BAKED_IDENTITY' or r.get('deployment') != 'NOT_RUN'
            or r.get('platform') != 'linux/amd64' or not ref.startswith(image_name(role) + '@')):
            raise ValueError('mixed/unqualified publication receipts')
        # Revalidate copied artifact data, including its exact image repository.
        digest = ref.removeprefix(image_name(role) + '@')
        image_receipt(role, digest, source, deploy_env, site_url, run_id, attempt,
                      {'Os':'linux','Architecture':'amd64','RepoDigests':[ref],'Config':{'Cmd':ROLES[role]['command']}},r.get('identity'))
        images[role] = ref
    return dict(format='mikluha.phase-a-image-bundle/1', build=build, workflow=workflow, images=images,
                publication='ALL_FIVE_IMAGES_VERIFIED', installation='NOT_AUTHORIZED_BY_THIS_BUNDLE',
                database_backup_restore='NOT_RUN', legal_publication='NOT_PUBLISHED', sales='CLOSED')


def docker_output(args):
    p = subprocess.run(['docker', *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
    if p.returncode or len(p.stdout) > 2 * 1024**2:
        raise RuntimeError('registry image check failed; diagnostic output suppressed')
    return p.stdout


def inspect_published(role, digest, source, deploy_env, site_url, run_id, attempt):
    # Validate before using the reference in any command. No shell interpolation.
    inputs(source, deploy_env, site_url); run_identity(run_id, attempt)
    if role not in ROLES or not re.fullmatch(r'sha256:[0-9a-f]{64}', digest or ''):
        raise ValueError('unknown role or digest')
    ref = image_name(role) + '@' + digest
    docker_output(['pull', '--platform', 'linux/amd64', ref])
    inspect = json.loads(docker_output(['image', 'inspect', ref]))[0]
    name = 'phase-a-identity-' + uuid.uuid4().hex
    created = False
    try:
        docker_output(['create', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                       '--security-opt', 'no-new-privileges:true', '--memory', '128m', '--cpus', '.25',
                       '--pids-limit', '16', ref]); created = True
        with tempfile.TemporaryDirectory(prefix='phase-a-identity-') as td:
            p = pathlib.Path(td) / 'identity.json'
            docker_output(['cp', name + ':' + ROLES[role]['path'], str(p)])
            if p.is_symlink() or not p.is_file() or p.stat().st_size > 16384:
                raise ValueError('identity path/size invalid')
            identity = json.loads(p.read_bytes())
        return image_receipt(role,digest,source,deploy_env,site_url,run_id,attempt,inspect,identity)
    finally:
        if created: docker_output(['rm', name])


def main():
    p = argparse.ArgumentParser();p.add_argument('action',choices=['plan','source-check','verify','assemble'])
    p.add_argument('--source',required=True);p.add_argument('--deploy-env',required=True);p.add_argument('--site-url',required=True)
    p.add_argument('--ref');p.add_argument('--repository');p.add_argument('--role');p.add_argument('--digest')
    p.add_argument('--run-id');p.add_argument('--attempt');p.add_argument('--receipts',type=pathlib.Path);p.add_argument('--output',type=pathlib.Path)
    a = p.parse_args();inputs(a.source,a.deploy_env,a.site_url)
    if a.action == 'plan': result=plan(a.source,a.deploy_env,a.site_url,a.ref,a.repository)
    elif a.action == 'source-check':source_check(a.source);result={'source_check':'PASS'}
    elif a.action == 'verify':result=inspect_published(a.role,a.digest,a.source,a.deploy_env,a.site_url,a.run_id,a.attempt)
    else:
        if not a.receipts or not a.receipts.is_dir():raise ValueError('receipt directory required')
        paths = sorted(a.receipts.glob('*.json'))
        if len(paths) != len(ROLES) or any(x.is_symlink() or x.stat().st_size>32768 for x in paths):
            raise ValueError('exactly five bounded regular receipts required')
        result=assemble([json.loads(x.read_text()) for x in paths],a.source,a.deploy_env,a.site_url,a.run_id,a.attempt)
    output = json.dumps(result,sort_keys=True,indent=2)+'\n'
    if a.output:
        a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(output)
    else:print(output,end='')


if __name__ == '__main__':main()
