import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const script=new URL('../scripts/cloudrun/deploy-identity-staging.sh',import.meta.url);
const image='us-central1-docker.pkg.dev/terapixel-platform-staging/terapixel-platform/identity-gateway@sha256:'+'a'.repeat(64);
it('workflow is manual, main-only, fixed staging and uses full action SHAs',async()=>{
 const s=await fs.readFile(new URL('../.github/workflows/identity-gateway-staging.yml',import.meta.url),'utf8');
 assert.match(s,/workflow_dispatch:/);assert.doesNotMatch(s,/\n  push:|\n  pull_request:/);
 assert.match(s,/github.ref == 'refs\/heads\/main'/);assert.match(s,/environment: staging/);
 assert.match(s,/GCP_PROJECT_ID: terapixel-platform-staging/);
 assert.match(s,/service_account: \$\{\{ env.GCP_SERVICE_ACCOUNT \}\}/);
 for(const m of s.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g))assert.match(m[1],/^[a-f0-9]{40}$/);
});
for(const failure of [null,'metadata','smoke'])it(`targeted release ${failure||'success'} preserves safety boundary (mock CLI)`,async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gateway-release-test-'));const bin=path.join(dir,'bin');await fs.mkdir(bin);
 const env={...process.env,PATH:bin+':'+process.env.PATH,RUNNER_TEMP:dir,GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),GATEWAY_IMAGE:image,GITHUB_STEP_SUMMARY:path.join(dir,'summary'),MOCK_DIR:dir,MOCK_SCRIPT:script.pathname,MOCK_FAILURE:failure||''};
 const mock=`#!/usr/bin/env python3
import os,sys,json,pathlib
p=pathlib.Path(os.environ['MOCK_DIR']);a=sys.argv[1:]
with open(p/'calls','a') as f:f.write(json.dumps(a)+'\\n')
assert '--account=github-cloudrun-deployer@terapixel-platform-staging.iam.gserviceaccount.com' in a
assert '--project=terapixel-platform-staging' in a
assert '--region=us-central1' in a
if a[:3]==['run','services','describe']:
 changed=(p/'updated').exists()
 d={'metadata':{'annotations':{'run.googleapis.com/ingress':'all','run.googleapis.com/invoker-iam-disabled':'true'}},'spec':{'template':{'spec':{'serviceAccountName':'existing-runtime','containers':[{'env':[{'name':'EDGE_INGRESS_SECRET','valueFrom':{'secretKeyRef':{'name':'existing-secret','key':'latest'}}}]}]}}},'status':{'traffic':[{'revisionName':'old-revision','percent':100}],'url':'https://staging.test'}}
 if changed and os.environ['MOCK_FAILURE']=='metadata':d['spec']['template']['spec']['serviceAccountName']='changed-runtime'
 print(json.dumps(d))
elif a[:3]==['run','services','get-iam-policy']:print(json.dumps({'etag':'same'}))
elif a[:3]==['run','services','update']:
 assert a[3]=='terapixel-identity-gateway' and '--no-traffic' in a
 assert not any(x.startswith(('--update-env','--set-env','--update-secrets','--service-account','--allow-unauth')) for x in a)
 (p/'updated').touch();print('new-revision')
elif a[:3]==['run','revisions','describe']:print(json.dumps({'status':{'conditions':[{'type':'Ready','status':'True'}]}}))
elif a[:3]==['run','services','update-traffic']:
 assert '--to-revisions=new-revision=100' in a;(p/'promoted').touch()
else:raise RuntimeError('unexpected command')
`;
 const curl=`#!/usr/bin/env python3
import sys,json,os,pathlib
args=sys.argv[1:];url=args[-1];out=args[args.index('--output')+1];p=pathlib.Path(os.environ['MOCK_DIR'])
if url.endswith('/healthz'):code=404;body={}
elif url.endswith('/.well-known/jwks.json'):code=200;body={'keys':[]}
else:code=403;body={'error':{'message':'missing or invalid edge ingress secret'}}
if (p/'promoted').exists() and os.environ['MOCK_FAILURE']=='smoke' and url.endswith('/v1/web/session'):code=200
pathlib.Path(out).write_text(json.dumps(body));print(code,end='')
`;
 try{
  // Read fixtures through the interpreter: /tmp is deliberately noexec in the
  // isolated runner. No executable temp files or relaxed mount flags are needed.
  await fs.writeFile(path.join(dir,'gcloud.py'),mock);await fs.writeFile(path.join(dir,'curl.py'),curl);
  await fs.writeFile(path.join(dir,'shims'), 'gcloud() { python3 "$MOCK_DIR/gcloud.py" "$@"; }\ncurl() { python3 "$MOCK_DIR/curl.py" "$@"; }\n');
  const run=spawnSync('bash',['-c','source "$MOCK_DIR/shims"; source "$MOCK_SCRIPT"'],{env,encoding:'utf8'});
  assert.equal(run.status===0,failure===null,run.stderr);
  const calls=(await fs.readFile(path.join(dir,'calls'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(x=>x[2]==='update').length,1);assert.equal(calls.filter(x=>x[2]==='update-traffic').length,failure==='metadata'?0:1);
  assert.match(await fs.readFile(env.GITHUB_STEP_SUMMARY,'utf8'),/Rollback revision: `old-revision`/);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});
it('release rejects non-main refs and foreign image repositories before cloud calls',async()=>{
 for(const changes of [{GITHUB_REF:'refs/heads/feature'},{GATEWAY_IMAGE:image.replace('terapixel-platform-staging','other-project') }]){
  const r=spawnSync('bash',[script.pathname],{env:{...process.env,GITHUB_REF:'refs/heads/main',GATEWAY_IMAGE:image,...changes},encoding:'utf8'});assert.notEqual(r.status,0);
 }
});
