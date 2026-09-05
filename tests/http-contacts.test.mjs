import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createApiServer} from '../dist/packages/server/http.js';
import {BackendService,ServiceError} from '../dist/packages/server/service.js';
const origin='https://app.example',token='a'.repeat(43),cookie=`projekt1_session=${token}`;
async function setup(t,contacts){
 const auth={resolveSession:async()=>null,displaySession:async()=>{throw new Error();},revokeSession:async()=>{}};
 const service=new BackendService({auth,reads:{authorizePrivateScope:async()=>null,readSnapshot:async()=>null}});
 const server=createApiServer({auth,service,browserOrigin:origin,...(contacts?{contacts}:{})});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 return `http://127.0.0.1:${server.address().port}`;
}
test('Contacts start returns only authorization URL and binding cookie, not a redirect or tokens',async t=>{
 const base=await setup(t,{start:async(credential,scopeId)=>{assert.equal(credential,token);assert.equal(scopeId,'s0');return{location:'https://accounts.google.com/o/oauth2/v2/auth?state=s0',cookies:['projekt1_contacts_oauth=b0; HttpOnly; Secure'],accessToken:'must-not-be-returned'};}});
 const response=await fetch(base+'/api/auth/google/contacts/start',{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify({scopeId:'s0'}),redirect:'manual'});
 assert.equal(response.status,200);assert.equal(response.headers.get('location'),null);assert.deepEqual(await response.json(),{authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?state=s0'});assert.match(response.headers.get('set-cookie'),/projekt1_contacts_oauth/);
});
test('Contacts start retains origin and strict body checks before adapter invocation',async t=>{
 let calls=0;const base=await setup(t,{start:async()=>{calls++;throw new ServiceError('UNAUTHENTICATED',401);}});
 const send=(body,requestOrigin=origin)=>fetch(base+'/api/auth/google/contacts/start',{method:'POST',headers:{origin:requestOrigin,cookie,'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await send({scopeId:'s0'},'https://other.example')).status,403);assert.equal((await send({scopeId:'s0',actorUserId:'u9'})).status,400);assert.equal(calls,0);assert.equal((await send({scopeId:'s0'})).status,401);
});
test('Contacts callback forwards original params/cookies and fixed 303 redirect',async t=>{
 const rawCookie=`${cookie}; projekt1_contacts_oauth=b0`;
 const base=await setup(t,{callback:async(params,header)=>{assert.deepEqual(params.getAll('state'),['s0','s1']);assert.equal(header,rawCookie);return{location:origin+'/',cookies:['projekt1_contacts_oauth=; Max-Age=0']};}});
 const response=await fetch(base+'/api/auth/google/contacts/callback?state=s0&state=s1&code=c0',{headers:{cookie:rawCookie},redirect:'manual'});
 assert.equal(response.status,303);assert.equal(response.headers.get('location'),origin+'/');assert.equal(response.headers.getSetCookie().length,1);
});
test('Contacts callback failure clears only Contacts cookie and sanitizes errors',async t=>{
 const base=await setup(t,{callback:async()=>{throw new Error('private provider response');},clearTransactionCookie:()=> 'projekt1_contacts_oauth=; HttpOnly; Max-Age=0'});
 const response=await fetch(base+'/api/auth/google/contacts/callback?code=c0',{redirect:'manual'});assert.equal(response.status,500);assert.match(response.headers.get('set-cookie'),/^projekt1_contacts_oauth=/);assert.ok(!response.headers.get('set-cookie').includes('projekt1_session'));assert.ok(!(await response.text()).includes('private provider'));
});
test('unconfigured Contacts is explicit and no credential retrieval HTTP route exists',async t=>{
 const base=await setup(t);
 const start=await fetch(base+'/api/auth/google/contacts/start',{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify({scopeId:'s0'})});assert.equal(start.status,502);
 const callback=await fetch(base+'/api/auth/google/contacts/callback?code=c0',{redirect:'manual'});assert.equal(callback.status,502);assert.match(callback.headers.get('set-cookie'),/projekt1_contacts_oauth=;.*Max-Age=0/);
 assert.equal((await fetch(base+'/api/auth/google/contacts/token')).status,404);
});
test('Contacts callback rejects redirect destinations outside fixed application root',async t=>{
 const base=await setup(t,{callback:async()=>({location:'https://other.example/',cookies:[]}),clearTransactionCookie:()=> 'projekt1_contacts_oauth=; Max-Age=0'});
 const response=await fetch(base+'/api/auth/google/contacts/callback',{redirect:'manual'});assert.equal(response.status,500);assert.equal(response.headers.get('location'),null);
});
