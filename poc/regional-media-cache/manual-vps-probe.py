import argparse,datetime,hashlib,http.client,importlib.util,json,pathlib,random,socket,subprocess,tempfile,time
parser=argparse.ArgumentParser(description='Temporary TOUR-88 VPS tunnel probe; no VPN or system trust changes')
parser.add_argument('--vpn',choices=['off','on'],required=True)
parser.add_argument('--session',type=pathlib.Path,default=pathlib.Path.home()/'Documents/TOUR-88/vps-session.json')
args=parser.parse_args()
BASE=args.session.expanduser().resolve().parent
session=json.loads(args.session.expanduser().read_text())
ready=session['ready']
remaining=session['clientDeadlineEpoch']-time.time()
if remaining<30: raise SystemExit('Not enough authorized stage time for a client run')
DEADLINE=time.monotonic()+min(180,remaining)
spec=importlib.util.spec_from_file_location('manual',pathlib.Path(__file__).with_name('manual-probe.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
probe=socket.socket();probe.bind(('127.0.0.1',18489));probe.close()
tunnel=subprocess.Popen(['ssh','-N','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','-L','127.0.0.1:18489:127.0.0.1:18488','adman-vps'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
report={'scope':'KEMEROVO_TO_VPS_VIA_PERSISTENT_SSH_TUNNEL_EXPLORATORY','startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'operatorDeclared':{'city':'Кемерово','network':'home','vpn':args.vpn},'samplePolicy':'10/image/path; interleaved fresh curl/TLS connections over a shared SSH connection for cache','probeSha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'coldCacheControlled':False,'limitations':['SSH tunnel is not production public HTTPS/DNS','Shared SSH TCP avoids fresh remote TCP per cache request; direct path has fresh TCP/TLS','2-second experimental cache TTL; HIT rate is not a production estimate','No mobile/browser LCP or commercial regression qualification'],'objects':[]}
output=BASE/'kemerovo-vps-tunnel.json'
def save(): output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
def observe(url,cached,work):
 header=work/'headers';body=work/'body'
 for file in [header,body]: file.unlink(missing_ok=True)
 command=['curl','-q','--silent','--show-error','--noproxy','*','--proto','=https','--connect-timeout','4','--max-time',str(max(1,min(8,int(DEADLINE-time.monotonic())))),'--max-filesize','1048576','--dump-header',str(header),'--output',str(body),'--write-out','%{json}']
 if cached: command+=['--cacert',str(BASE/session['caFile']),'--resolve','media.localhost:18489:127.0.0.1']
 process=subprocess.run(command+[url],capture_output=True,text=True)
 try: metrics=json.loads(process.stdout)
 except ValueError: metrics={}
 headers={}
 if header.exists():
  for line in header.read_text(errors='replace').splitlines():
   if ':' in line:
    key,value=line.split(':',1)
    if key.lower() in module.SAFE_HEADERS: headers[key.lower()]=value.strip()
 data=body.read_bytes() if body.exists() else b''
 row={'status':int(metrics.get('http_code',0)),'curlExit':process.returncode,'headers':headers,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'ok':process.returncode==0 and int(metrics.get('http_code',0))==200 and headers.get('content-type')=='image/webp'}
 for name,key in module.TIMINGS.items(): row[name]=round(float(metrics.get(key,0))*1000,3)
 return row
try:
 for _ in range(30):
  if tunnel.poll() is not None: raise RuntimeError('SSH forwarding failed')
  s=socket.socket();s.settimeout(.2)
  try: s.connect(('127.0.0.1',18489));s.close();break
  except OSError: s.close();time.sleep(.2)
 with tempfile.TemporaryDirectory(prefix='tour88-client-') as folder:
  tasks=[]
  for item in ready['manifest']:
   obj={'originUrl':item['origin'],'cacheUrl':'https://media.localhost:18489'+item['path'],'expectedSha256':item['sha256'],'direct':[],'cache':[]};report['objects'].append(obj)
   for i in range(10): tasks.extend([(obj,'direct'),(obj,'cache')])
  random.Random(88).shuffle(tasks)
  for index,(obj,mode) in enumerate(tasks,1):
   if time.monotonic()>=DEADLINE: report['budgetReached']=True;break
   row=observe(obj['cacheUrl'] if mode=='cache' else obj['originUrl'],mode=='cache',pathlib.Path(folder))
   if row['ok'] and row['sha256']!=obj['expectedSha256']: row['ok']=False;row['error']='BYTE_IDENTITY_MISMATCH'
   obj[mode].append(row);save()
   print(f'{index}/40 {mode} {row["status"]} {row["headers"].get("x-cache-status","UNKNOWN")}',flush=True)
   time.sleep(.1)
 for obj in report['objects']:
  for mode in ['direct','cache']: obj[mode+'Summary']=module.summarize(obj[mode])
  obj['cacheByObservedState']={state:module.summarize([r for r in obj['cache'] if r['headers'].get('x-cache-status')==state]) for state in ['MISS','HIT','REVALIDATED'] if any(r['headers'].get('x-cache-status')==state for r in obj['cache'])}
 for obj in report['objects']:
  for mode in ['direct','cache']:
   summary=obj[mode+'Summary']
   print(obj['originUrl'].rsplit('/',1)[-1], mode, 'TTFB ms', summary['ttfbMs'], 'total ms', summary['totalMs'], 'cache', summary['cacheStates'], flush=True)
 report['result']='PASS_HTTP_OBSERVATIONS' if not report.get('budgetReached') and all(o[m+'Summary']['errors']==0 for o in report['objects'] for m in ['direct','cache']) else 'ERRORS_OR_BUDGET_REACHED'
except BaseException as error:
 report['result']='INTERRUPTED' if isinstance(error,KeyboardInterrupt) else 'FAILED'
 report['errorType']=type(error).__name__
 raise
finally:
 tunnel.terminate()
 try: tunnel.wait(timeout=5)
 except subprocess.TimeoutExpired: tunnel.kill();tunnel.wait()
 report['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat();save()
 print('RESULT '+str(output),flush=True)
