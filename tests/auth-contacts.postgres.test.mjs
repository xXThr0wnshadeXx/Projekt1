import assert from 'node:assert/strict';
import {before, after, describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {once} from 'node:events';
import {Pool} from 'pg';
import {PgStore} from '../dist/packages/server/storage/postgres.js';
import {GoogleAuth} from '../dist/packages/server/auth/google.js';
import {GoogleContacts,CONTACTS_SCOPE} from '../dist/packages/server/auth/contacts.js';
import {ProviderTokenCipher} from '../dist/packages/server/auth/token-cipher.js';
import {createApiServer} from '../dist/packages/server/http.js';
import {BackendService} from '../dist/packages/server/service.js';
import {migratePrivateStorage,migrateContactsStorage} from '../dist/packages/server/storage/migrate.js';
const database=process.env.STORAGE_TEST_DATABASE_URL;
describe('PostgreSQL Contacts callback session serialization and token lifetime', {skip: !database}, () => {
const schema='contacts_review_'+randomUUID().replaceAll('-','');
const origin='https://contacts-review.example.test';
const config={appOrigin:origin,clientId:'review.apps.googleusercontent.com',clientSecret:'anonymous-review-secret',redirectUri:origin+'/api/auth/google/callback'};
const key=randomBytes(32).toString('base64url');
const contactConfig={...config,redirectUri:origin+'/api/auth/google/contacts/callback',encryptionKey:key};
const sha=s=>createHash('sha256').update(s).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const admin=new Pool({connectionString:database,connectionTimeoutMillis:1500});
let pool;
before(async () => {
 await admin.query('CREATE SCHEMA '+schema);
 pool=new Pool({connectionString:database,options:'-c search_path='+schema,application_name:schema,max:10,statement_timeout:5000});
 await migratePrivateStorage(pool,fileURLToPath(new URL('../migrations/001_private_storage.sql',import.meta.url)));
 await migrateContactsStorage(pool,fileURLToPath(new URL('../migrations/002_contacts_grants.sql',import.meta.url)));
});
after(async () => {await pool?.end(); await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE'); await admin.end();});
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;}
async function close(server){await new Promise(r=>{server.close(r);server.closeAllConnections();});}
async function fixture(){
 let now=Date.now(),nonce,refreshHook=async()=>{},tokenOverrides={},refreshCalls=0;
 const store=new PgStore(pool),user=await store.upsertGoogleUser({googleSubject:randomUUID(),displayName:'Anonymous review'});
 const scopeId=(await store.listPrivateScopes(user.userId))[0].id,credential=randomBytes(32).toString('base64url');
 await store.putSession({tokenHash:sha(credential),userId:user.userId,createdAt:now-1000,expiresAt:now+86400000,revokedAt:null});
 const auth=new GoogleAuth(store,config,{now:()=>now});
 const provider={
  exchangeCode:async()=>({accessToken:'anonymous-access',expiresIn:3600,scopes:['openid',CONTACTS_SCOPE],refreshToken:'anonymous-refresh',refreshExpiresIn:null,idToken:'anonymous-id',...tokenOverrides}),
  verifyIdToken:async()=>({sub:user.googleSubject,iss:'https://accounts.google.com',aud:config.clientId,iat:Math.floor(now/1000),exp:Math.floor(now/1000)+3600,nonce}),
  refresh:async()=>{refreshCalls++;await refreshHook();return {accessToken:'anonymous-refreshed',expiresIn:3600,scopes:null,refreshToken:null,refreshExpiresIn:null,idToken:null};}
 };
 const contacts=new GoogleContacts(auth,store,store,contactConfig,{provider,now:()=>now});
 const server=createApiServer({auth,oauth:auth,contacts,browserOrigin:origin,service:new BackendService({auth,reads:store})});
 const base=await listen(server);
 const send=(path,body,cookie='projekt1_session='+credential)=>fetch(base+path,{method:'POST',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify(body),redirect:'manual'});
 async function start(){const r=await send('/api/auth/google/contacts/start',{scopeId});assert.equal(r.status,200);const body=await r.json();assert.deepEqual(Object.keys(body),['authorizationUrl']);const url=new URL(body.authorizationUrl);
  const tx=(await pool.query('SELECT * FROM contacts_transactions WHERE state_hash=$1',[sha(url.searchParams.get('state'))])).rows[0];nonce=tx.nonce;
  return {sourceId:tx.source_id,cookie:r.headers.getSetCookie()[0].split(';')[0]+'; projekt1_session='+credential,path:'/api/auth/google/contacts/callback?'+new URLSearchParams({state:url.searchParams.get('state'),code:'anonymous-code'})};
 }
 const callback=a=>fetch(base+a.path,{headers:{cookie:a.cookie},redirect:'manual'});
 async function connect(){const a=await start(),r=await callback(a);assert.equal(r.status,303);return a;}
 return {store,user,scopeId,credential,auth,contacts,server,base,send,start,callback,connect,advance:ms=>now+=ms,onRefresh:fn=>refreshHook=fn,setTokens:x=>tokenOverrides=x,get refreshCalls(){return refreshCalls;}};
}
async function emptySource(f, sourceId) {
 assert.equal(await f.store.getContactsGrant(f.user.userId,sourceId),null);
 const graph=await f.store.readSnapshot(await f.store.authorizePrivateScope(f.user.userId,f.scopeId));
 assert.equal(graph.graphVersion,'0');assert.equal(graph.sources.length,0);assert.equal(graph.identities.length,0);
 assert.equal((await pool.query('SELECT count(*) FROM private_sources WHERE id=$1',[sourceId])).rows[0].count,'0');
}
async function waitingFor(queryText) {
 const deadline=Date.now()+3000;
 while(Date.now()<deadline){
  const r=await admin.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND state='active' AND wait_event_type='Lock' AND strpos(query,$2)>0",[schema,queryText]);
  if(r.rowCount)return;
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 assert.fail('Expected database lock wait did not occur');
}
it('rejects logout after final actor check without provisioning a source; replay stays rejected', async()=>{
 const f=await fixture(),entered=deferred(),resume=deferred();
 try{
  const a=await f.start(),original=f.store.getContactsGrant.bind(f.store);let first=true;
  f.store.getContactsGrant=async(...args)=>{if(first){first=false;entered.resolve();await resume.promise;}return original(...args);};
  const pending=f.callback(a);await entered.promise;
  assert.equal((await f.send('/api/auth/logout',{})).status,204);
  assert.equal(await f.auth.resolveSession(f.credential),null);resume.resolve();
  assert.equal((await pending).status,401);await emptySource(f,a.sourceId);
  assert.equal((await f.callback(a)).status,401);
 }finally{resume.resolve();await close(f.server);}
});
it('rejects initiating-session expiry after final actor check', async()=>{
 const f=await fixture(),entered=deferred(),resume=deferred();
 try{
  const a=await f.start(),original=f.store.getContactsGrant.bind(f.store);let first=true;
  f.store.getContactsGrant=async(...args)=>{if(first){first=false;entered.resolve();await resume.promise;}return original(...args);};
  const pending=f.callback(a);await entered.promise;f.advance(86400000);resume.resolve();
  assert.equal((await pending).status,401);await emptySource(f,a.sourceId);
 }finally{resume.resolve();await close(f.server);}
});
it('rejects expiry while grant transaction waits on scope and rolls back source/graph writes', async()=>{
 const f=await fixture(),blocker=await pool.connect();
 try{
  const a=await f.start(),expiresAt=Date.now()+1000;
  await pool.query('UPDATE app_sessions SET expires_at=$1 WHERE token_hash=$2',[expiresAt,sha(f.credential)]);
  await blocker.query('BEGIN');await blocker.query('SELECT id FROM private_scopes WHERE id=$1 FOR UPDATE',[f.scopeId]);
  const pending=f.callback(a);await waitingFor('FOR UPDATE OF s');
  // Leave the application clock unchanged: database time must advance after its lock wait.
  await admin.query('SELECT pg_sleep(GREATEST(0, $1/1000.0-extract(epoch FROM clock_timestamp())+0.02))',[expiresAt]);
  await blocker.query('COMMIT');assert.equal((await pending).status,401);await emptySource(f,a.sourceId);
 }finally{await blocker.query('ROLLBACK');blocker.release();await close(f.server);}
});
it('logout waits when callback owns the session lock, with no session/scope lock inversion', async()=>{
 const f=await fixture(),blocker=await pool.connect();
 try{
  const a=await f.start();await blocker.query('BEGIN');await blocker.query('SELECT id FROM private_scopes WHERE id=$1 FOR UPDATE',[f.scopeId]);
  const callback=f.callback(a);await waitingFor('FOR UPDATE OF s');
  const logout=f.send('/api/auth/logout',{});await waitingFor('UPDATE app_sessions SET revoked_at');
  await blocker.query('COMMIT');assert.equal((await callback).status,303);assert.equal((await logout).status,204);
  assert.equal(await f.auth.resolveSession(f.credential),null);
  assert.ok(await f.store.getContactsGrant(f.user.userId,a.sourceId));
 }finally{await blocker.query('ROLLBACK');blocker.release();await close(f.server);}
});
it('callback waits for an in-flight logout row lock and rejects after logout commits', async()=>{
 const f=await fixture(),blocker=await pool.connect();
 try{
  const a=await f.start();await blocker.query('BEGIN');
  await blocker.query('UPDATE app_sessions SET revoked_at=$1 WHERE token_hash=$2',[Date.now(),sha(f.credential)]);
  const callback=f.callback(a);await waitingFor('FROM app_sessions WHERE token_hash');
  await blocker.query('COMMIT');assert.equal((await callback).status,401);await emptySource(f,a.sourceId);
 }finally{await blocker.query('ROLLBACK');blocker.release();await close(f.server);}
});
for(const [name,tokens] of Object.entries({missing:{refreshToken:null,refreshExpiresIn:null},expired:{refreshExpiresIn:10}}))
 for(const [access,advance] of Object.entries({valid:3541000,expired:3600000}))
  it(`${name} refresh credential with ${access} access honors actual access expiry`,async()=>{
   const f=await fixture();try{
    f.setTokens(tokens);const a=await f.connect();f.advance(advance);
    if(access==='valid')assert.equal((await f.contacts.getFreshAccessToken(f.credential,a.sourceId)).accessToken,'anonymous-access');
    else await assert.rejects(f.contacts.getFreshAccessToken(f.credential,a.sourceId),e=>e.code==='SOURCE_UNAVAILABLE');
    assert.equal(f.refreshCalls,0);assert.ok(await f.store.getContactsGrant(f.user.userId,a.sourceId));
   }finally{await close(f.server);}
  });
it('successful callback encrypts credentials, isolates owner, and rejects replay',async()=>{
 const f=await fixture(),other=await fixture();try{
  const a=await f.connect(),grant=await f.store.getContactsGrant(f.user.userId,a.sourceId);
  assert.ok(!JSON.stringify(grant).includes('anonymous-access'));
  assert.equal(new ProviderTokenCipher(key).decrypt(grant.accessTokenCiphertext,grant,'access'),'anonymous-access');
  assert.equal(await f.store.getContactsGrant(other.user.userId,a.sourceId),null);
  await assert.rejects(f.contacts.getFreshAccessToken(other.credential,a.sourceId));assert.equal((await f.callback(a)).status,401);
  const response=await fetch(f.base+'/api/graph?scopeId='+f.scopeId,{headers:{cookie:'projekt1_session='+f.credential}});
  assert.equal(response.status,200);assert.ok(!(await response.text()).includes('anonymous-access'));
 }finally{await close(f.server);await close(other.server);}
});
it('refresh loses to revocation without restoring credentials',async()=>{
 const f=await fixture();try{
  const a=await f.connect();f.advance(3600000);f.onRefresh(()=>f.contacts.revoke(f.credential,a.sourceId));
  await assert.rejects(f.contacts.getFreshAccessToken(f.credential,a.sourceId));
  const row=(await pool.query('SELECT grant_data FROM contacts_grants WHERE source_id=$1',[a.sourceId])).rows[0].grant_data;
  assert.equal(row.accessTokenCiphertext,'');assert.equal(row.refreshTokenCiphertext,null);
 }finally{await close(f.server);}
});
});
