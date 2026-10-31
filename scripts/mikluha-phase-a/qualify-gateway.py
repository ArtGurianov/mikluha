#!/usr/bin/env python3
"""Local TLS/Host routing test, fixed mock origins. NOT real Admin authentication evidence."""
import argparse
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import uuid
ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'config/mikluha-phase-a/lib'))
from maa_backup import run


def main():
    p = argparse.ArgumentParser(); p.add_argument('--commerce-image', required=True); p.add_argument('--output', type=pathlib.Path, required=True)
    a = p.parse_args()
    if a.output.exists(): raise ValueError('existing receipt')
    spec = importlib.util.spec_from_file_location('maa_gateway_engine', ROOT/'scripts/mikluha-phase-a/local-engine.py')
    engine = importlib.util.module_from_spec(spec); spec.loader.exec_module(engine)
    docker = engine.local_docker()
    def d(*args):
        engine.verify_engine(docker); return run([*docker,*args])
    suffix = uuid.uuid4().hex[:12]; net='maa-tls-'+suffix; origin=net+'-origin'; gateway=net+'-gateway'
    image=json.loads((ROOT/'config/mikluha-phase-a/candidate.json').read_text())['images']['gateway']
    front=net+'-ingress'
    made_front=made_net=made_origin=made_gateway=False
    with tempfile.TemporaryDirectory(prefix='maa-tls-') as temp:
        path=pathlib.Path(temp).resolve()
        cert=path/'cert.pem'; key=path/'key.pem'; conf=path/'nginx.conf'
        run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',str(key),'-out',str(cert),
             '-subj','/CN=Phase A disposable TLS fixture','-addext','subjectAltName=DNS:admin.acceptance.mikluha.test,DNS:site.acceptance.mikluha.test'])
        key.chmod(0o600)
        conf.write_text((ROOT/'config/mikluha-phase-a/gateway.conf').read_text().replace('__SCOPE__','acceptance'))
        try:
            d('network','create','--internal',net);made_net=True
            d('network','create',front);made_front=True
            source="const h=require('http');for(const port of [80,3000])h.createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({host:q.headers.host,forwarded:q.headers['x-forwarded-for']??null}));}).listen(port,'0.0.0.0');"
            d('run','-d','--name',origin,'--network',net,'--network-alias','admin','--network-alias','site',
              '--memory','128m','--pids-limit','32','--user','0',a.commerce_image,'node','-e',source);made_origin=True
            d('run','-d','--name',gateway,'--network',front,'--read-only','--memory','128m','--pids-limit','32',
              '--cap-drop','ALL','--cap-add','NET_BIND_SERVICE','--cap-add','CHOWN','--cap-add','SETGID','--cap-add','SETUID',
              '--tmpfs','/tmp:size=8m,mode=1777','--tmpfs','/var/cache/nginx:size=8m,mode=1777',
              '--tmpfs','/var/run:size=1m,mode=1777','-p','127.0.0.1::443',
              '--mount',f'type=bind,source={conf},target=/etc/nginx/nginx.conf,readonly',
              '--mount',f'type=bind,source={path},target=/run/tls,readonly',
              '--entrypoint','nginx',image,'-g','daemon off;');made_gateway=True
            d('network','connect',net,gateway)
            time.sleep(1)
            state=json.loads(d('inspect',gateway))[0]
            if not state['State']['Running']:
                print(d('logs',gateway).decode()[:2000],file=sys.stderr)
                raise ValueError('local TLS fixture failed startup')
            ports=state['NetworkSettings']['Ports']
            cases=[]
            for kind,internal in [('admin','443/tcp'),('site','443/tcp')]:
                port=ports[internal][0]['HostPort']; host=kind+'.acceptance.mikluha.test'
                base=['curl','--silent','--show-error','--max-time','10','--noproxy','*','--cacert',str(cert),
                      '--connect-to',host+':443:127.0.0.1:'+port,'https://'+host+'/']
                response=json.loads(run(base));assert response['host']==host and response['forwarded'] is None
                rejected=run([*base,'-H','Host: incorrect.test','-o','/dev/null','-w','%{http_code}']).decode()
                assert rejected=='421'
                cases.append({'origin':host,'tls_and_exact_host':'PASS','forged_host':'421'})
            result={'format':'mikluha.phase-a-gateway-local/1','result':'PASS','cases':cases,
                'shared_sni_listener':'443/tcp','gateway_image':image,'backend':'MOCK_HTTP_ORIGINS','real_admin_authentication':'NOT_RUN',
                'owner_browser_trust_and_tunnel':'NOT_RUN','vps_installation':'NOT_RUN'}
        finally:
            if made_gateway:d('rm','-f',gateway)
            if made_origin:d('rm','-f',origin)
            if made_net:d('network','rm',net)
            if made_front:d('network','rm',front)
    a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2)+'\n')
    print('LOCAL_GATEWAY_TLS_HOST=PASS; real Admin/browser/install NOT_RUN')


if __name__=='__main__':
    try: main()
    except Exception:
        print('LOCAL_GATEWAY=FAIL; diagnostic values suppressed',file=sys.stderr);sys.exit(1)
