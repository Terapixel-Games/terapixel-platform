import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createIdentityGatewayHttpServer, createIdentityGatewayService } from '../services/identity-gateway/index.js';

it('preserves deployed edge guard, its exemptions and backend-proof requirement', async()=>{
 const service=createIdentityGatewayService({nakamaExchangeKeysJson:JSON.stringify({game:'fixed-local-backend-test-key-32-bytes'}),sessionSecret:'fixed-local-session-test-secret'});
 const server=createIdentityGatewayHttpServer({service,sessionSecret:'fixed-local-session-test-secret',edgeIngressSecret:'fixed-local-origin-fixture',internalServiceKey:'fixed-local-admin-fixture'});
 const {baseUrl}=await server.listen();
 const send=(path,{method='GET',headers={},body}={})=>fetch(baseUrl+path,{method,headers:{'content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
 try{
  assert.equal((await send('/healthz?probe=1')).status,200);
  assert.equal((await send('/.well-known/jwks.json?probe=1')).status,200);
  assert.equal((await send('/v1/auth/nakama',{method:'OPTIONS'})).status,204);
  for(const supplied of [null,'wrong','x'.repeat(26)]) {
   const res=await send('/v1/web/session',{headers:supplied?{'x-terapixel-origin-secret':supplied}:{}});
   assert.equal(res.status,403);assert.equal((await res.json()).error.message,'missing or invalid edge ingress secret');
  }
  const origin={'x-terapixel-origin-secret':'fixed-local-origin-fixture'};
  assert.equal((await send('/v1/web/session',{headers:origin})).status,200);
  assert.equal((await send('/v1/account/magic-link/consume')).status,403);
  assert.equal((await send('/v1/account/magic-link/consume',{headers:origin})).status,400);
  assert.equal((await send('/v1/auth/nakama',{method:'POST',headers:origin,body:{game_id:'game',nakama_user_id:'player'}})).status,401);
  assert.equal((await send('/v1/auth/nakama',{method:'POST',headers:{...origin,'x-nakama-exchange-key':'fixed-local-backend-test-key-32-bytes'},body:{game_id:'game',nakama_user_id:'player'}})).status,200);
  assert.equal((await send('/v1/identity/internal/username/validate',{method:'POST',body:{game_id:'game',username:'player'}})).status,401);
  assert.equal((await send('/v1/identity/internal/username/validate',{method:'POST',headers:{'x-admin-key':'fixed-local-admin-fixture'},body:{game_id:'game',username:'player'}})).status,200);
 }finally{await server.close()}
});
it('gateway main merges cannot trigger the all-service staging deployment',()=>{
 const workflow=fs.readFileSync(new URL('../.github/workflows/cloudrun-deploy.yml',import.meta.url),'utf8');
 const triggers=workflow.split('permissions:')[0];
 assert.doesNotMatch(triggers,/branches:\s*\["main"\]/);
 assert.match(triggers,/tags:\s*\["v\*"\]/);
 assert.match(triggers,/workflow_dispatch:/);
});
