import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApiServer } from '../dist/packages/server/http.js';
import { BackendService } from '../dist/packages/server/service.js';
import { graph, result } from './fixtures.mjs';
const origin='http://127.0.0.1:5173';
const cookie=`projekt1_session=${'a'.repeat(32)}`;
async function setup(t) {
  let revoked=0;
  const auth={resolveSession:async token=>token==='a'.repeat(32)?{userId:'u0'}:null,displaySession:async()=>({actor:{id:'u0',displayName:'u0'},scopes:[{id:'s0',label:'s0'}]}),revokeSession:async()=>{revoked++;}};
  const service=new BackendService({auth,reads:{authorizePrivateScope:async (user,scope)=>scope==='s0'?{scopeId:'s0',ownerUserId:user,rootPersonId:'p0',sourceIds:new Set(['s1'])}:null,readSnapshot:async()=>graph()},goals:{resolve:async()=>({goal:result().goal,targets:result().targets})},engine:{findBestPaths:()=>result()}});
  const server=createApiServer({auth,service,browserOrigin:origin});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return {auth,base:`http://127.0.0.1:${server.address().port}`,revoked:()=>revoked};
}
test('HTTP matches session DTO and rejects missing/ambiguous cookies',async t=>{
 const h=await setup(t);
 for(const headers of [{},{cookie:`${cookie}; ${cookie}`}])assert.equal((await fetch(`${h.base}/api/session`,{headers})).status,401);
 const response=await fetch(`${h.base}/api/session`,{headers:{cookie}});
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{actor:{id:'u0',displayName:'u0'},scopes:[{id:'s0',label:'s0'}]});
 h.auth.displaySession=async()=>({actor:{id:'u0',displayName:'u0',token:'private'},scopes:[]});
 const bad=await fetch(`${h.base}/api/session`,{headers:{cookie}});assert.equal(bad.status,500);assert.ok(!(await bad.text()).includes('private'));
});
test('Google full-page GET fails explicitly; wrong issue-prose routes do not masquerade as success',async t=>{
 const h=await setup(t);assert.equal((await fetch(`${h.base}/api/auth/google/start`)).status,502);assert.equal((await fetch(`${h.base}/api/auth/google/callback?code=opaque`)).status,502);
 assert.equal((await fetch(`${h.base}/api/auth/google/start`,{method:'POST',headers:{origin}})).status,404);
 assert.equal((await fetch(`${h.base}/api/logout`,{method:'POST',headers:{origin}})).status,404);
});
test('logout requires same origin, revokes through port and clears HttpOnly cookie',async t=>{
 const h=await setup(t);
 assert.equal((await fetch(`${h.base}/api/auth/logout`,{method:'POST',headers:{origin:'https://example.org',cookie}})).status,403);assert.equal(h.revoked(),0);
 const response=await fetch(`${h.base}/api/auth/logout`,{method:'POST',headers:{origin,cookie}});assert.equal(response.status,204);assert.equal(h.revoked(),1);assert.match(response.headers.get('set-cookie'),/HttpOnly; SameSite=Lax; Max-Age=0/);
});
test('graph HTTP wiring authorizes scopes and search preserves service version checks',async t=>{
 const h=await setup(t);
 assert.equal((await fetch(`${h.base}/api/graph?scopeId=s0`)).status,401);
 assert.equal((await fetch(`${h.base}/api/graph?scopeId=s9`,{headers:{cookie}})).status,403);
 assert.equal((await fetch(`${h.base}/api/graph?scopeId=s0`,{headers:{cookie}})).status,200);
 const send=body=>fetch(`${h.base}/api/search`,{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify(body)});
 const request={scopeId:'s0',expectedGraphVersion:'v1',goalText:'g0'};
 const response=await send(request);assert.equal(response.status,200);assert.equal((await response.json()).paths.length,1);
 assert.equal((await send({...request,expectedGraphVersion:'v0'})).status,409);
 assert.equal((await send({...request,rootPersonId:'p9'})).status,400);
});
test('search HTTP enforces JSON, body limit and origin before dispatch',async t=>{
 const h=await setup(t);
 const send=(headers,body)=>fetch(`${h.base}/api/search`,{method:'POST',headers,body});
 assert.equal((await send({origin,cookie,'content-type':'text/plain'},'{}')).status,415);
 assert.equal((await send({origin,cookie,'content-type':'application/json'},'{')).status,400);
 assert.equal((await send({origin,cookie,'content-type':'application/json'},JSON.stringify({text:'a'.repeat(17000)}))).status,413);
 assert.equal((await send({cookie,'content-type':'application/json'},'{}')).status,403);
});
