import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';
import {createApiServer} from '../dist/packages/server/http.js';import {BackendService,ServiceError} from '../dist/packages/server/service.js';import {graph} from './fixtures.mjs';
const origin='https://app.example',token='a'.repeat(43),cookie=`projekt1_session=${token}`;
async function setup(t,imports){
 const auth={resolveSession:async value=>value===token?{userId:'u0'}:null,displaySession:async()=>{throw new Error();},revokeSession:async()=>{}};
 const service=new BackendService({auth,reads:{authorizePrivateScope:async(user,id)=>id==='s0'?{scopeId:id,ownerUserId:user,rootPersonId:'p0',sourceIds:new Set(['s1'])}:null,readSnapshot:async()=>graph()}});
 const server=createApiServer({auth,service,browserOrigin:origin,...(imports?{imports}:{})});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const base=`http://127.0.0.1:${server.address().port}`;
 return {base,post:(path,input,headers={})=>fetch(base+path,{method:'POST',headers:{origin,cookie,'content-type':'application/json',...headers},body:JSON.stringify(input)})};
}
test('sources returns only actor-authorized persisted summaries and snapshot version',async t=>{
 const h=await setup(t);const response=await fetch(h.base+'/api/sources?scopeId=s0',{headers:{cookie}});assert.equal(response.status,200);assert.deepEqual(await response.json(),{scopeId:'s0',graphVersion:'v1',sources:graph().sources});
 assert.equal((await fetch(h.base+'/api/sources?scopeId=s0')).status,401);assert.equal((await fetch(h.base+'/api/sources?scopeId=s9',{headers:{cookie}})).status,403);
});
test('import start forwards only validated command and opaque session credential',async t=>{
 const command={scopeId:'s0',sourceId:'s1',expectedGraphVersion:'v1',idempotencyKey:'k0'};
 const h=await setup(t,{start:async(credential,input)=>{assert.equal(credential,token);assert.deepEqual(input,command);return{jobId:'j0',scopeId:'s0',sourceId:'s1',status:'PENDING_REVIEW',duplicate:false};}});
 const response=await h.post('/api/imports/google',command);assert.equal(response.status,202);assert.equal((await response.json()).status,'PENDING_REVIEW');assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal((await h.post('/api/imports/google',{...command,accessToken:'forbidden'})).status,400);
});
test('review binds job path and scope query; helper scope denial is preserved',async t=>{
 const h=await setup(t,{review:async(credential,input)=>{assert.equal(credential,token);assert.equal(input.jobId,'j0');if(input.scopeId!=='s0')throw new ServiceError('FORBIDDEN',403);return{jobId:'j0',status:'PENDING_REVIEW'};}});
 assert.equal((await fetch(h.base+'/api/imports/j0?scopeId=s0',{headers:{cookie}})).status,200);assert.equal((await fetch(h.base+'/api/imports/j0?scopeId=s9',{headers:{cookie}})).status,403);
});
test('approval requires explicit confirmation and rejects body identity/job overrides',async t=>{
 let calls=0;const h=await setup(t,{approve:async(credential,input)=>{calls++;assert.equal(credential,token);assert.deepEqual(input,{scopeId:'s0',jobId:'j0',expectedGraphVersion:'v1',idempotencyKey:'k0',confirm:true});return{jobId:'j0',graphVersion:'v2',duplicate:false,events:[]};}});
 const command={scopeId:'s0',expectedGraphVersion:'v1',idempotencyKey:'k0',confirm:true};
 assert.equal((await h.post('/api/imports/j0/approve',command)).status,200);
 for(const extra of [{confirm:false},{jobId:'j9'},{personAssignments:[]}])assert.equal((await h.post('/api/imports/j0/approve',{...command,...extra})).status,400);assert.equal(calls,1);
});
test('missing import bridge fails explicitly after authentication; POST origin check applies',async t=>{
 const h=await setup(t),command={scopeId:'s0',sourceId:'s1',expectedGraphVersion:'v1',idempotencyKey:'k0'};
 assert.equal((await h.post('/api/imports/google',command)).status,502);assert.equal((await h.post('/api/imports/google',command,{cookie:''})).status,401);assert.equal((await h.post('/api/imports/google',command,{origin:'https://other.example'})).status,403);
});
test('import provider errors never echo details',async t=>{
 const h=await setup(t,{start:async()=>{throw new Error('private provider content');}});const response=await h.post('/api/imports/google',{scopeId:'s0',sourceId:'s1',expectedGraphVersion:'v1',idempotencyKey:'k0'});assert.equal(response.status,500);assert.ok(!(await response.text()).includes('private provider'));
});
