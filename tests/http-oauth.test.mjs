import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createApiHandler} from '../dist/packages/server/http.js';
import {BackendService,ServiceError} from '../dist/packages/server/service.js';

async function setup(t,oauth) {
 const auth={resolveSession:async()=>null,displaySession:async()=>{throw new Error('unused');},revokeSession:async()=>{}};
 const service=new BackendService({auth,reads:{authorizePrivateScope:async()=>null,readSnapshot:async()=>null}});
 const server=createServer(createApiHandler({auth,service,oauth,browserOrigin:'https://app.example'}));
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 return `http://127.0.0.1:${server.address().port}`;
}
test('extracted API handler forwards start redirect and all cookie headers',async t=>{
 const cookies=['transaction=t0; HttpOnly; Secure','other=t1; HttpOnly; Secure'];
 const base=await setup(t,{start:async()=>({location:'https://accounts.google.com/o/oauth2/v2/auth?state=s0',cookies})});
 const response=await fetch(`${base}/api/auth/google/start`,{redirect:'manual'});
 assert.equal(response.status,302);assert.equal(response.headers.get('location'),'https://accounts.google.com/o/oauth2/v2/auth?state=s0');assert.deepEqual(response.headers.getSetCookie(),cookies);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');
});
test('callback preserves duplicate query parameters/raw cookies and success cookie array',async t=>{
 const rawCookie='projekt1_oauth=a0; projekt1_session=b0';
 const base=await setup(t,{callback:async(params,cookie)=>{assert.deepEqual(params.getAll('state'),['s0','s1']);assert.equal(cookie,rawCookie);return{location:'https://app.example/',cookies:['projekt1_oauth=; Max-Age=0','projekt1_session=t0; Secure; HttpOnly']};}});
 const response=await fetch(`${base}/api/auth/google/callback?state=s0&state=s1&code=c0`,{headers:{cookie:rawCookie},redirect:'manual'});
 assert.equal(response.status,302);assert.equal(response.headers.getSetCookie().length,2);assert.equal(response.headers.get('location'),'https://app.example/');
});
test('callback error clears transaction cookie and never serializes raw provider error',async t=>{
 const base=await setup(t,{callback:async()=>{throw new Error('private provider detail');},clearTransactionCookie:()=> 'projekt1_oauth=; Path=/; HttpOnly; Secure; Max-Age=0'});
 const response=await fetch(`${base}/api/auth/google/callback?code=c0`,{redirect:'manual'});
 assert.equal(response.status,500);assert.match(response.headers.get('set-cookie'),/Max-Age=0/);assert.ok(!(await response.text()).includes('private provider'));
});
test('provider-unavailable start does not issue redirect or cookies',async t=>{
 const base=await setup(t,{start:async()=>{throw new ServiceError('SOURCE_UNAVAILABLE',502);}});
 const response=await fetch(`${base}/api/auth/google/start`,{redirect:'manual'});assert.equal(response.status,502);assert.equal(response.headers.get('location'),null);assert.equal(response.headers.get('set-cookie'),null);
});
