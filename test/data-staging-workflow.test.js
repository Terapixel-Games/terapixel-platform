import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const script = new URL('../scripts/cloudrun/deploy-data-staging.py', import.meta.url).pathname;
it('data rollout is manual/main-only, fixed staging, required PG and pinned actions', async () => {
 const text = await fs.readFile(new URL('../.github/workflows/data-safety-staging.yml', import.meta.url), 'utf8');
 assert.match(text, /workflow_dispatch:/); assert.doesNotMatch(text, /\n  push:|\n  pull_request:/);
 assert.match(text, /github.ref == 'refs\/heads\/main'/); assert.match(text, /environment: staging/);
 assert.match(text, /sh tools\/test-compose.sh/); assert.match(text, /for service in identity-gateway save-service iap-service/);
 assert.match(text, /github-cloudrun-deployer@terapixel-platform-staging.iam.gserviceaccount.com/);
 for (const match of text.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)) assert.match(match[1], /^[a-f0-9]{40}$/);
});
for (const failure of ['', 'runtime', 'secret', 'iam', 'readiness', 'image', 'store', 'traffic', 'guard', 'foreign', 'branch']) {
 it(`data release boundary with ${failure || 'success'} (mock APIs, no cloud access)`, () => {
 const harness = String.raw`
import importlib.util,os,copy,io,json,contextlib
spec=importlib.util.spec_from_file_location('release',os.environ['RELEASE_SCRIPT']);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
failure=os.environ['TEST_FAILURE'];images={s:'us-central1-docker.pkg.dev/terapixel-platform-staging/terapixel-platform/'+s+'@sha256:'+'a'*64 for s in m.SERVICES}
os.environ.update(GITHUB_REF='refs/heads/main',GITHUB_SHA='b'*40)
for s,img in images.items():os.environ[s.upper().replace('-','_')+'_IMAGE']=img
if failure=='foreign':os.environ['SAVE_SERVICE_IMAGE']=images['save-service'].replace('terapixel-platform-staging','production')
if failure=='branch':os.environ['GITHUB_REF']='refs/heads/not-main'
state={};calls=[];summaries=[]
def description(s):
 changed=s in state;flag=m.SERVICES[s]
 env=[{'name':'DATABASE_URL','valueFrom':{'secretKeyRef':{'name':'existing-db','key':'latest'}}},{'name':'OPAQUE','value':'never-print-this'}]
 if s=='identity-gateway':env.append({'name':'EDGE_INGRESS_SECRET','valueFrom':{'secretKeyRef':{'name':'existing-edge','key':'latest'}}})
 if changed and flag:env.append({'name':flag,'value':'postgres' if failure!='store' else 'memory'})
 data={'metadata':{'annotations':{'run.googleapis.com/ingress':'all'}},'spec':{'template':{'metadata':{'annotations':{'network':'existing'}},'spec':{'serviceAccountName':'existing-runtime','containers':[{'image':'new' if changed else 'old','env':env}]}}},'status':{'url':'https://'+s+'.test','traffic':[{'revisionName':'terapixel-'+s+'-old','percent':100}]}}
 if changed and failure=='runtime':data['spec']['template']['spec']['serviceAccountName']='other'
 if changed and failure=='secret':env[0]['valueFrom']['secretKeyRef']['name']='other'
 if changed and failure=='traffic':data['status']['traffic'][0]['revisionName']='unexpected'
 if state.get(s)=='promoted':data['status']['traffic'][0]['revisionName']='terapixel-'+s+'-new'
 return data
m.describe=description
m.policy=lambda s:{'bindings':[],'etag':'changed' if s in state and failure=='iam' else 'same'}
m.summary=summaries.append
class Response:
 def __init__(self,body):self.status=200;self.body=body
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def read(self):return self.body
# Exercise actual smoke assertions; HTTP errors carry only mock bodies.
def urlopen(url,timeout):
 if url.endswith('jwks.json'):return Response(b'{"keys":[]}')
 if url.endswith('/v1/web/session'):
  if failure=='guard':return Response(b'{}')
  raise m.urllib.error.HTTPError(url,403,'forbidden',None,io.BytesIO(b'{"error":{"message":"missing or invalid edge ingress secret"}}'))
 raise m.urllib.error.HTTPError(url,404,'frontend',None,io.BytesIO(b'{}'))
m.urllib.request.urlopen=urlopen
def cloud(*args,**kwargs):
 calls.append(args)
 if args[:3]==('run','services','update'):
  s=args[3].removeprefix('terapixel-');assert '--no-traffic' in args
  assert '--image='+images[s] in args
  flags=[a for a in args if a.startswith('--update-env-vars=')]
  assert flags==(['--update-env-vars='+m.SERVICES[s]+'=postgres'] if m.SERVICES[s] else [])
  assert not any(a.startswith(('--set-env','--update-secrets','--service-account','--allow-unauth')) for a in args)
  state[s]='ready';return 'terapixel-'+s+'-new'
 if args[:3]==('run','revisions','describe'):
  s=args[3].removeprefix('terapixel-').removesuffix('-new')
  return json.dumps({'status':{'conditions':[{'type':'Ready','status':'False' if failure=='readiness' else 'True'}],'imageDigest':images[s] if failure!='image' else 'wrong'}})
 if args[:3]==('run','services','update-traffic'):
  assert len(state)==3 and all(x in ('ready','promoted') for x in state.values())
  s=args[3].removeprefix('terapixel-');assert '--to-revisions=terapixel-'+s+'-new=100' in args
  state[s]='promoted';return ''
 raise AssertionError('unexpected cloud operation')
m.cloud=cloud
success=False
with contextlib.redirect_stdout(io.StringIO()) as output:
 try:m.main();success=True
 except AssertionError:
  if not failure:raise
assert success==(not failure)
assert 'never-print-this' not in output.getvalue()+'\n'.join(summaries)
promotions=[a for a in calls if a[:3]==('run','services','update-traffic')]
assert len(promotions)==(0 if failure else 3)
if failure in ('foreign','branch','guard'):assert not calls
if not failure:assert len([a for a in calls if a[:3]==('run','services','update')])==3
print('validated')
`;
 const result = spawnSync('python3', ['-c', harness], { env: {...process.env, RELEASE_SCRIPT:script, TEST_FAILURE:failure, PYTHONDONTWRITEBYTECODE:"1"}, encoding:'utf8' });
 assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /validated/);
 });
}
