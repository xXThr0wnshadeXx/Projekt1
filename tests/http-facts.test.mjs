import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';import {createHash} from 'node:crypto';
import {createApiServer} from '../dist/packages/server/http.js';import {FactReviewService} from '../dist/packages/server/facts/service.js';import {ServiceError} from '../dist/packages/server/service.js';
const origin='https://app.example',token='a'.repeat(43),cookie=`projekt1_session=${token}`;
const command={scopeId:'s0',expectedGraphVersion:'v1',idempotencyKey:'k0',confirm:true,change:{type:'RELATIONSHIP',relationshipId:'r0',decision:'REJECT'}};
async function setup(t,store){const auth={resolveSession:async c=>c===token?{userId:'u0'}:null};const facts=store?new FactReviewService({auth,facts:store}):undefined;const server=createApiServer({auth,service:{},browserOrigin:origin,...(facts?{facts}:{})});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));const base=`http://127.0.0.1:${server.address().port}`;return{base,post:(body=command,headers={})=>fetch(base+'/api/facts/confirm',{method:'POST',headers:{origin,cookie,'content-type':'application/json',...headers},body:JSON.stringify(body)})};}
test('fact HTTP facade derives actor/session hash and forwards strict review/confirm requests',async t=>{
 const verify=a=>assert.deepEqual(a,{userId:'u0',sessionHash:createHash('sha256').update(token).digest('hex')});
 const h=await setup(t,{review:async(a,r)=>{verify(a);assert.deepEqual(r,{scopeId:'s0'});return{scopeId:'s0',graphVersion:'v1',relationships:[],affiliations:[],sources:[],evidence:[],warnings:[]};},confirm:async(a,r)=>{verify(a);assert.deepEqual(r,command);return{decisionId:'d0',graphVersion:'v2'};}});
 const r=await fetch(h.base+'/api/facts/review?scopeId=s0',{headers:{cookie}});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.ok(!(await r.text()).includes(token));assert.equal((await h.post()).status,200);
});
test('facts guards reject missing session, cross-origin, body overrides, oversized input and missing confirmation',async t=>{
 let calls=0;const h=await setup(t,{review:async()=>{calls++;},confirm:async()=>{calls++;}});
 assert.equal((await h.post(command,{cookie:''})).status,401);assert.equal((await h.post(command,{origin:'https://other.example'})).status,403);
 for(const extra of [{confirm:false},{actorUserId:'other'},{sessionHash:'fake'}])assert.equal((await h.post({...command,...extra})).status,400);
 assert.equal((await h.post({...command,padding:'x'.repeat(17000)})).status,413);
 assert.equal((await fetch(h.base+'/api/facts/review',{headers:{cookie}})).status,400);assert.equal(calls,0);
});
test('facts failures remain sanitized and unavailable discovery names do not return success',async t=>{
 for(const [error,status] of [[new ServiceError('FORBIDDEN',403),403],[new ServiceError('VERSION_CONFLICT',409),409],[new Error('private ledger detail'),500]]){const h=await setup(t,{confirm:async()=>{throw error;}});const r=await h.post();assert.equal(r.status,status);assert.ok(!(await r.text()).includes('private ledger'));}
 const h=await setup(t);assert.equal((await h.post()).status,502);assert.equal((await fetch(h.base+'/api/discovery/capabilities')).status,404);assert.equal((await fetch(h.base+'/api/discovery')).status,404);
});
