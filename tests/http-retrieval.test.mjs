import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';
import {createApiServer} from '../dist/packages/server/http.js';
import {BackendService,ServiceError} from '../dist/packages/server/service.js';
import {GoogleImportBridge} from '../dist/packages/server/imports/bridge.js';
import {withGoogleRetrievalErrors} from '../dist/packages/server/imports/retrieval.js';
import {createGoogleContactsRetriever,GoogleContactsRetrievalError} from '../dist/packages/ingestion/googleContactsRetriever.js';
import {createApplication} from '../dist/packages/server/application.js';
import {graph} from './fixtures.mjs';
const origin='https://app.example',token='a'.repeat(43),cookie=`projekt1_session=${token}`;
const command={scopeId:'s0',sourceId:'s1',expectedGraphVersion:'v1',idempotencyKey:'k0'};
async function serve(t,server){server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));return `http://127.0.0.1:${server.address().port}`;}
async function setup(t,retrieve,{consent=true}={}){
 let staged=0;const snapshot=graph();snapshot.sources[0].provider='GOOGLE_CONTACTS';snapshot.sources[0].origin='AUTHORIZED_API';
 const auth={resolveSession:async c=>c===token?{userId:'u0'}:null,displaySession:async()=>({actor:{id:'u0',displayName:'Unit'},scopes:[{id:'s0',label:'Private'}]}),revokeSession:async()=>{}};
 const store={authorizePrivateScope:async(_u,s)=>s==='s0'?{scopeId:'s0',ownerUserId:'u0',rootPersonId:'p0',sourceIds:new Set(['s1'])}:null,readSnapshot:async()=>snapshot,lookupRetry:async()=>null,stage:async()=>{staged++;throw new Error('unexpected stage');}};
 const contacts={getFreshAccessToken:async()=>{if(!consent)throw new ServiceError('SOURCE_UNAVAILABLE',502);return{accessToken:'anonymous-provider-token',scopeId:'s0',sourceId:'s1'};}};
 const imports=new GoogleImportBridge({auth,store,contacts,retrieveAndNormalize:withGoogleRetrievalErrors(retrieve)});
 const base=await serve(t,createApiServer({auth,service:new BackendService({auth,reads:store}),imports,browserOrigin:origin}));
 return {base,staged:()=>staged,post:(body=command,headers={})=>fetch(base+'/api/imports/google',{method:'POST',headers:{origin,cookie,'content-type':'application/json',...headers},body:JSON.stringify(body)})};
}
for(const [status,expected,code] of [[401,502,'SOURCE_UNAVAILABLE'],[403,502,'SOURCE_UNAVAILABLE'],[429,429,'RATE_LIMITED'],[500,502,'SOURCE_UNAVAILABLE']]){
 test(`HTTP bridge maps provider ${status} without ending the app session`,async t=>{
  const h=await setup(t,createGoogleContactsRetriever({fetch:async()=>new Response('private-provider-detail anonymous-provider-token',{status})}));
  const response=await h.post();assert.equal(response.status,expected);const body=await response.json();assert.equal(body.error.code,code);assert.ok(!JSON.stringify(body).includes('provider-token'));assert.ok(!JSON.stringify(body).includes('private-provider'));assert.equal(h.staged(),0);
  assert.equal((await fetch(h.base+'/api/session',{headers:{cookie}})).status,200);
 });
}
test('HTTP wrapper maps internal failures and other fixed reasons without staging',async t=>{
 for(const [reason,status,code] of [['INVALID_CONTEXT',500,'INTERNAL'],['INVALID_RESPONSE',502,'SOURCE_UNAVAILABLE'],['LIMIT_EXCEEDED',502,'SOURCE_UNAVAILABLE'],['TIMEOUT',502,'SOURCE_UNAVAILABLE'],['ABORTED',502,'SOURCE_UNAVAILABLE']]){
  const h=await setup(t,async()=>{throw new GoogleContactsRetrievalError(reason);});const r=await h.post();assert.equal(r.status,status);assert.equal((await r.json()).error.code,code);assert.equal(h.staged(),0);
 }
 const h=await setup(t,async()=>{throw new Error('private-provider-detail');});const r=await h.post();assert.equal(r.status,500);assert.ok(!(await r.text()).includes('private-provider-detail'));
});
test('HTTP scope/origin/session guards, missing consent and token override prevent transport',async t=>{
 let calls=0;const retrieve=createGoogleContactsRetriever({fetch:async()=>{calls++;return new Response('{}');}});
 const h=await setup(t,retrieve);
 assert.equal((await h.post(command,{cookie:''})).status,401);
 assert.equal((await h.post({...command,scopeId:'other'})).status,403);
 assert.equal((await h.post(command,{origin:'https://other.example'})).status,403);
 assert.equal((await h.post({...command,accessToken:'forbidden'})).status,400);
 const missing=await setup(t,retrieve,{consent:false});assert.equal((await missing.post()).status,502);assert.equal(calls,0);
});
test('application without auth/storage cannot activate an injected provider',async t=>{
 let calls=0;const retrieve=async()=>{calls++;throw new Error('not allowed');};
 for(const options of [{env:{APP_ORIGIN:origin},retrieveAndNormalize:retrieve},{env:{APP_ORIGIN:origin}}]){
  const app=await createApplication(options);const base=await serve(t,app.server);assert.equal(app.configured.retrieval,false);
  const r=await fetch(base+'/api/imports/google',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(command)});assert.equal(r.status,401);
 }
 assert.equal(calls,0);
});
async function configuredApp(t,{provider,contacts=true}={}){
 const env={APP_ORIGIN:origin,GOOGLE_CLIENT_ID:'unit.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'unit-only',DATABASE_URL:'postgresql://unused',...(contacts?{GOOGLE_CONTACTS_REDIRECT_URI:origin+'/api/auth/google/contacts/callback',PROVIDER_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,1).toString('base64url')}:{})};
 const snapshot=graph();snapshot.sources[0].provider='GOOGLE_CONTACTS';snapshot.sources[0].origin='AUTHORIZED_API';
 const store={getSession:async()=>({userId:'u0',createdAt:0,expiresAt:Date.now()+60000,revokedAt:null}),getUser:async()=>({userId:'u0',displayName:'Unit'}),authorizePrivateScope:async()=>({scopeId:'s0',ownerUserId:'u0',rootPersonId:'p0',sourceIds:new Set(['s1'])}),readSnapshot:async()=>snapshot,lookupRetry:async()=>null};
 const app=await createApplication({env,openStorage:async()=>({store,importStore:store,migrate:async()=>{},close:async()=>{},probe:async()=>true}),...(provider?{retrieveAndNormalize:provider}:{})});
 const base=await serve(t,app.server);
 return {app,post:()=>fetch(base+'/api/imports/google',{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify(command)})};
}
test('configured application without Contacts or injected retriever fails before credential access',async t=>{
 let calls=0;const provider=async()=>{calls++;throw new Error('not allowed');};
 for(const options of [{provider,contacts:false},{contacts:true}]){
  const {app,post}=await configuredApp(t,options);app.contactsAccess.getFreshAccessToken=async()=>{calls++;throw new Error('not allowed');};
  assert.equal(app.configured.retrieval,false);assert.equal((await post()).status,502);
 }
 assert.equal(calls,0);
});
test('actual application installs the error wrapper around its injected provider',async t=>{
 const {app,post}=await configuredApp(t,{provider:async()=>{throw new GoogleContactsRetrievalError('RATE_LIMITED');}});
 app.contactsAccess.getFreshAccessToken=async()=>({accessToken:'anonymous-provider-token',scopeId:'s0',sourceId:'s1'});
 assert.equal(app.configured.retrieval,true);const response=await post();assert.equal(response.status,429);assert.equal((await response.json()).error.code,'RATE_LIMITED');
});
