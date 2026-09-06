import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID,randomBytes,createHash} from 'node:crypto';import {once} from 'node:events';import {Pool} from 'pg';
import {createApplication,openPostgresStorage} from '../dist/packages/server/application.js';
import {PgDiscoveryReceipts} from '../dist/packages/server/discovery/receipts.js';
import {PublicSourceProvisioner} from '../dist/packages/server/storage/public-source-provision.js';
const url=process.env.STORAGE_TEST_DATABASE_URL;if(url){const u=new URL(url);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'55439');assert.equal(u.username,'projekt1_test');assert.equal(u.pathname,'/postgres');}
const hash=s=>createHash('sha256').update(s).digest('hex'),origin='https://app.example';
async function setup(t,{search=async()=>[],documents={fetch:async()=>{throw new Error('unexpected document');}}}={}){
 const schema='discovery_app_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA ${schema}`);
 const scoped=new URL(url);scoped.searchParams.set('options',`-c search_path=${schema}`);let db;
 const pool=new Pool({connectionString:scoped.href});let app;
 t.after(async()=>{await app?.close();if(!app)await db?.close();await pool.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
 app=await createApplication({env:{DATABASE_URL:scoped.href,APP_ORIGIN:origin,GOOGLE_CLIENT_ID:'unit.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'unit-only'},openStorage:async u=>{db=await openPostgresStorage(u);return db;},discovery:{provider:{kind:'TAVILY',configured:true,search},documents}});
 const user=await db.store.upsertGoogleUser({googleSubject:randomUUID(),displayName:'PRIVATE_CONTACT_NAME'}),scopeId=(await db.store.listPrivateScopes(user.userId))[0].id;
 const token=randomBytes(32).toString('base64url'),actor={userId:user.userId,sessionHash:hash(token)};
 await db.store.putSession({tokenHash:actor.sessionHash,userId:user.userId,createdAt:Date.now()-1000,expiresAt:Date.now()+60000,revokedAt:null});
 const request={scopeId,expectedGraphVersion:'0',idempotencyKey:'query1',anchors:{linkedinUrl:'https://www.linkedin.com/in/unit-profile/',instagramUrl:'https://www.instagram.com/unit.profile/'},target:{organizationName:'Unit Public Organization'}};
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://127.0.0.1:${app.server.address().port}`,headers={cookie:`projekt1_session=${token}`};
 return{app,db,pool,actor,request,base,headers,post:(body=request,h={})=>fetch(base+'/api/discovery',{method:'POST',headers:{...headers,origin,'content-type':'application/json',...h},body:JSON.stringify(body)}),receipts:new PgDiscoveryReceipts(pool),provision:new PublicSourceProvisioner(pool)};
}
test('durable actual HTTP collection is truthful and exact retry spends no provider calls',{skip:!url},async t=>{
 const queries=[];const h=await setup(t,{search:async q=>{queries.push(q);return[];}});
 const caps=await fetch(h.base+'/api/discovery/capabilities',{headers:h.headers});assert.equal(caps.status,200);assert.equal((await caps.json()).generalWeb,'UNAVAILABLE');assert.equal(queries.length,0);
 let r=await h.post();assert.equal(r.status,200);const result=await r.json();assert.equal(result.status,'INSUFFICIENT_PUBLIC_EVIDENCE');assert.deepEqual(result.proposalRefs,[]);assert.ok(result.warnings.some(w=>w.includes('not implemented')));assert.ok(queries.length>0);assert.ok(queries.every(q=>!q.includes('PRIVATE_CONTACT_NAME')));
 const calls=queries.length;r=await h.post();assert.equal(r.status,200);assert.deepEqual(await r.json(),result);assert.equal(queries.length,calls);
 assert.equal((await h.post({...h.request,target:{personName:'Different'}})).status,409);assert.equal(queries.length,calls);
 const capability=await fetch(h.base+'/api/discovery/capabilities',{headers:h.headers});assert.equal((await capability.json()).generalWeb,'AVAILABLE');
 assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM discovery_receipts')).rows[0].n,1);
 assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM private_sources')).rows[0].n,0);
});
test('session, scope, private context, write origin and overrides stop outbound collection',{skip:!url},async t=>{
 let calls=0;const h=await setup(t,{search:async()=>{calls++;return[];}});
 const g=await h.db.store.readSnapshot(await h.db.store.authorizePrivateScope(h.actor.userId,h.request.scopeId));
 for(const [body,headers,status] of [[h.request,{cookie:''},401],[h.request,{origin:'https://other.example'},403],[{...h.request,scopeId:'foreign'},{},403],[{...h.request,selectedContextPersonIds:[g.rootPersonId]},{},403],[{...h.request,actorUserId:'forged'},{},400]])assert.equal((await h.post(body,headers)).status,status);
 assert.equal(calls,0);
 assert.equal((await fetch(h.base+'/api/discovery/capabilities')).status,401);
});
test('concurrent and abandoned receipts fail closed instead of repeating potentially billed requests',{skip:!url},async t=>{
 const h=await setup(t);const outcomes=await Promise.all([h.receipts.claim(h.actor,h.request),h.receipts.claim(h.actor,h.request)]);assert.deepEqual(outcomes.map(o=>o.kind).sort(),['BUSY','NEW']);
 await h.pool.query("UPDATE discovery_receipts SET lease_expires_at=clock_timestamp()-interval '1 second'");assert.equal((await h.receipts.claim(h.actor,h.request)).kind,'FAILED');assert.equal((await h.post()).status,502);
});
test('session-aware public provisioning preserves version order, no verified owner identity, safe retry',{skip:!url},async t=>{
 const h=await setup(t);const first={scopeId:h.request.scopeId,expectedGraphVersion:'0',document:{url:'https://example.org/article',kind:'PUBLIC_ARTICLE',title:'Public unit article',retrievedAt:'2026-09-05T12:00:00.000Z'}};
 const result=await h.provision.provision(h.actor,first);assert.equal(result.graphVersion,'1');assert.deepEqual(await h.provision.provision(h.actor,first),result);
 const second={...first,document:{...first.document,url:'https://example.org/second'}};await assert.rejects(h.provision.provision(h.actor,second),e=>e.code==='VERSION_CONFLICT');
 const next=await h.provision.provision(h.actor,{...second,expectedGraphVersion:result.graphVersion});assert.equal(next.graphVersion,'2');
 const source=(await h.pool.query('SELECT summary,owner_identity FROM private_sources WHERE id=$1',[result.sourceId])).rows[0];assert.equal(source.summary.provider,'PUBLIC_ARTICLE');assert.equal(source.owner_identity,null);
 await h.db.store.revokeSession(h.actor.sessionHash,Date.now());await assert.rejects(h.provision.provision(h.actor,first),e=>e.code==='UNAUTHENTICATED');
});
test('receipt finalization rejects a concurrent graph mutation and logout',{skip:!url},async t=>{
 const h=await setup(t);const claim=await h.receipts.claim(h.actor,h.request);assert.equal(claim.kind,'NEW');
 await h.provision.provision(h.actor,{scopeId:h.request.scopeId,expectedGraphVersion:'0',document:{url:'https://example.org/article',kind:'PUBLIC_ARTICLE',title:'Public unit article',retrievedAt:'2026-09-05T12:00:00.000Z'}});
 const result={discoveryId:claim.id,scopeId:h.request.scopeId,baseGraphVersion:'0',proposalRefs:[],status:'SOURCE_UNAVAILABLE'};
 await assert.rejects(h.receipts.complete(h.actor,h.request,claim.id,result),e=>e.code==='VERSION_CONFLICT');
 await h.db.store.revokeSession(h.actor.sessionHash,Date.now());await assert.rejects(h.receipts.claim(h.actor,h.request),e=>e.code==='UNAUTHENTICATED');
});
test('completed authorized receipts survive unrelated version advance but disabled sources do not',{skip:!url},async t=>{
 let calls=0;const h=await setup(t,{search:async()=>{calls++;return[];}});const r=await h.post();assert.equal(r.status,200);const original=await r.json(),count=calls;
 const source=await h.provision.provision(h.actor,{scopeId:h.request.scopeId,expectedGraphVersion:'0',document:{url:'https://example.org/a',kind:'PUBLIC_ARTICLE',title:'Public article',retrievedAt:'2026-09-05T12:00:00.000Z'}});
 const replay=await h.post();assert.equal(replay.status,200);assert.deepEqual(await replay.json(),original);assert.equal(calls,count);
 await h.pool.query('UPDATE private_sources SET enabled=false WHERE id=$1',[source.sourceId]);assert.equal((await h.post()).status,403);assert.equal(calls,count);
});
