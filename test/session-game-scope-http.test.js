import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionToken, sessionAllowsGame } from '../packages/shared-utils/index.js';
import { createSaveHttpServer } from '../services/save-service/index.js';
import { createIapHttpServer } from '../services/iap-service/index.js';
import { createFeatureFlagsHttpServer } from '../services/feature-flags/index.js';
import { createTelemetryIngestHttpServer } from '../services/telemetry-ingest/index.js';
const secret='fixed-local-game-scope-session-fixture';
const options={sessionSecret:secret,sessionIssuer:'test.identity',sessionAudience:'test.games'};
const token=(claims,audience='test.games')=>createSessionToken({sub:'player',...claims},secret,{issuer:'test.identity',audience,ttlSeconds:600});
it('scope helper preserves absent scope and rejects malformed present scope',()=>{
 assert.equal(sessionAllowsGame({sub:'player'},'other'),true);
 for(const game_id of [null,undefined,'',42,[],{},' GAME ','Game']) assert.equal(sessionAllowsGame({game_id},'game'),false);
 assert.equal(sessionAllowsGame({game_id:'game'},'other'),false);
 assert.equal(sessionAllowsGame({game_id:'game'},'game'),true);
 for (const request of ['GAME',' game ',null,42]) assert.equal(sessionAllowsGame({game_id:'game'},request),false);
});
const routes=[
 {name:'save sync',factory:createSaveHttpServer,method:'POST',path:'/v1/save/sync',stub:'syncSave',body:{game_id:'game'}},
 {name:'iap verify',factory:createIapHttpServer,method:'POST',path:'/v1/iap/verify',stub:'verifyPurchase',body:{game_id:'game'}},
 {name:'iap adjust',factory:createIapHttpServer,method:'POST',path:'/v1/iap/coins/adjust',stub:'adjustCoins',body:{game_id:'game'}},
 {name:'flags inferred profile',factory:createFeatureFlagsHttpServer,method:'GET',path:'/v1/flags?game_id=game',stub:'getFlags'},
 {name:'flags explicit profile',factory:createFeatureFlagsHttpServer,method:'GET',path:'/v1/flags?game_id=game&profile_id=player',stub:'getFlags'},
 {name:'telemetry required',factory:createTelemetryIngestHttpServer,method:'POST',path:'/v1/telemetry/events',stub:'ingestEvents',body:{game_id:'game',events:[]},extra:{requireSession:true}},
 {name:'telemetry optional',factory:createTelemetryIngestHttpServer,method:'POST',path:'/v1/telemetry/events',stub:'ingestEvents',body:{game_id:'game',events:[]},extra:{requireSession:false}}
];
for(const route of routes) it(`${route.name}: enforces verified game scope before downstream work; preserves web sessions`,async()=>{
 let calls=0;
 const noop=async()=>({envelope:{},source:'mock'});
 const service={syncSave:noop,mergeProfiles:noop,verifyPurchase:noop,getFlags:noop,ingestEvents:noop};
 service[route.stub]=async()=>{calls++;return {envelope:{},source:'mock'}};
 const server=route.factory({...options,...route.extra,service});
 const {baseUrl}=await server.listen();
 const send=async(auth)=>{
  const res=await fetch(baseUrl+route.path,{method:route.method,headers:{'content-type':'application/json',...(auth?{authorization:`Bearer ${auth}`}:{})},...(route.body?{body:JSON.stringify(route.body)}:{})});
  return {status:res.status,body:await res.json()};
 };
 try {
  for(const game_id of ['other','',null,42,{},[], ' GAME ']) {
   const before=calls;const res=await send(token({game_id}));
   assert.equal(res.status,403,JSON.stringify(game_id));assert.equal(res.body.error.code,'game_scope_mismatch');assert.equal(calls,before);
  }
  for(const claims of [{game_id:'game'},{},{nakama_user_id:'legacy-player'}]) {
   const before=calls;assert.equal((await send(token(claims))).status,route.name.startsWith('telemetry')?202:200);assert.equal(calls,before+1);
  }
  const before=calls;const wrong=await send(token({game_id:'game'},'wrong.audience'));
  // Flags retains its existing anonymous fallback; telemetry rejects invalid supplied sessions even in optional mode.
  const optional=route.name==='flags inferred profile';
  assert.equal(wrong.status,optional?200:401);assert.equal(calls,before+(optional?1:0));
 } finally {await server.close()}
});
it('public flags and optional telemetry remain accessible without a session',async()=>{
 for(const route of routes.filter(x=>x.name==='flags inferred profile'||x.name==='telemetry optional')) {
  const noop=async()=>({});const server=route.factory({...options,...route.extra,service:{getFlags:noop,ingestEvents:noop,mergeProfiles:noop}});
  const {baseUrl}=await server.listen();try{
   const res=await fetch(baseUrl+route.path,{method:route.method,headers:{'content-type':'application/json'},...(route.body?{body:JSON.stringify(route.body)}:{})});assert.equal(res.status,route.name.startsWith('telemetry')?202:200);
  }finally{await server.close()}
 }
});

it('account-wide entitlement response remains unchanged pending explicit product policy',async()=>{
 let calls=0;
 const service={async verifyPurchase(){},async getEntitlements(){calls++;return {coins:{game:{balance:1},other:{balance:2}}}}};
 const server=createIapHttpServer({...options,service});const {baseUrl}=await server.listen();
 try{
  const response=await fetch(baseUrl+'/v1/iap/entitlements',{headers:{authorization:`Bearer ${token({game_id:'game'})}`}});
  assert.equal(response.status,200);assert.equal((await response.json()).coins.other.balance,2);assert.equal(calls,1);
 }finally{await server.close()}
});
