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
 let r=await h.post();assert.equal(r.status,200);const result=await r.json();assert.equal(result.status,'INSUFFICIENT_PUBLIC_EVIDENCE');assert.deepEqual(result.proposalRefs,[]);assert.ok(result.warnings.some(w=>w.includes('No supported proposals')));assert.ok(queries.length>0);assert.ok(queries.every(q=>!q.includes('PRIVATE_CONTACT_NAME')));
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
 await assert.rejects(h.receipts.complete(h.actor,h.request,claim.id,result,claim.runId),e=>e.code==='VERSION_CONFLICT');
 await h.db.store.revokeSession(h.actor.sessionHash,Date.now());await assert.rejects(h.receipts.claim(h.actor,h.request),e=>e.code==='UNAUTHENTICATED');
});
test('completed authorized receipts survive unrelated version advance but disabled sources do not',{skip:!url},async t=>{
 let calls=0;const h=await setup(t,{search:async()=>{calls++;return[];}});const r=await h.post();assert.equal(r.status,200);const original=await r.json(),count=calls;
 const source=await h.provision.provision(h.actor,{scopeId:h.request.scopeId,expectedGraphVersion:'0',document:{url:'https://example.org/a',kind:'PUBLIC_ARTICLE',title:'Public article',retrievedAt:'2026-09-05T12:00:00.000Z'}});
 const replay=await h.post();assert.equal(replay.status,200);assert.deepEqual(await replay.json(),original);assert.equal(calls,count);
 await h.pool.query('UPDATE private_sources SET enabled=false WHERE id=$1',[source.sourceId]);assert.equal((await h.post()).status,403);assert.equal(calls,count);
});
function article(url,text){return{id:hash(url),revision:hash([url,text].join('|')),sourceUrl:url,fetchedUrl:url,title:'Public test article',publisher:null,publishedAt:null,retrievedAt:'2026-09-05T00:00:00.000Z',contentDigest:hash(text),digestBasis:'NORMALIZED_TEXT_SHA256',normalizedText:text,upstreamRevisionId:null,normalizationVersion:'public-source-text-v1',persistence:'NOT_PERSISTED',metadataStatus:'SOURCE_SUPPLIED_NOT_VERIFIED'};}
function publicPipeline(){const calls={queries:[],pages:[]};const a='https://example.org/first',b='https://example.org/second';return{calls,options:{search:async q=>{calls.queries.push(q);return[{url:q.includes('Person Beta')?b:a,title:'Public hint',snippet:'Hint only',provider:'TAVILY',evidenceStatus:'DISCOVERY_HINT'}];},documents:{fetch:async url=>{calls.pages.push(url);return article(url,url===a?'Person Alpha is a friend of Person Beta.':'Person Beta is a friend of Person Gamma.');}}}};}
test('one globally bounded planner stages real extracted proposals with sequenced source versions and exact HTTP replay',{skip:!url},async t=>{
 const pipeline=publicPipeline(),h=await setup(t,pipeline.options);let r=await h.post();assert.equal(r.status,200);const result=await r.json();assert.equal(result.status,'REVIEW_REQUIRED');assert.ok(result.proposalRefs.length>0);assert.ok(pipeline.calls.queries.length<=4);assert.ok(pipeline.calls.pages.length<=5);assert.ok(pipeline.calls.queries.some(q=>q.includes('Person Beta')));
 const sources=await h.pool.query('SELECT count(*)::int n FROM private_sources');const staged=await h.pool.query('SELECT response,envelope FROM public_fact_batches ORDER BY (response->>\'graphVersion\')::bigint');assert.equal(sources.rows[0].n,2);assert.equal(staged.rows.length,2);assert.deepEqual(staged.rows.map(s=>s.response.graphVersion),['2','4']);
 const refs=staged.rows.flatMap(s=>s.envelope.proposals.map(p=>({id:p.id,revision:p.revision})));assert.deepEqual(result.proposalRefs,refs);assert.ok(staged.rows.every(s=>s.envelope.proposals.every(p=>p.reviewState==='PENDING'&&!p.includeInSearch)));
 assert.ok(!JSON.stringify(result).includes('normalizedText'));assert.ok(!JSON.stringify(result).includes('privatePayloadRef'));assert.ok(!JSON.stringify(result).includes('supportingExcerpt'));
 const calls=structuredClone(pipeline.calls);r=await h.post();assert.equal(r.status,200);assert.deepEqual(await r.json(),result);assert.deepEqual(pipeline.calls,calls);
 const g=await h.db.store.readSnapshot(await h.db.store.authorizePrivateScope(h.actor.userId,h.request.scopeId));assert.equal(g.graphVersion,'4');assert.equal(g.people.length,1);assert.deepEqual(g.searchEdges,[]);
});
test('retry after source commit/checkpoint interruption reuses the provision receipt and never refetches',{skip:!url},async t=>{
 const pipeline=publicPipeline(),h=await setup(t,pipeline.options),original=h.app.publicSources.provision.bind(h.app.publicSources);let first=true;
 h.app.publicSources.provision=async(...args)=>{const response=await original(...args);if(first){first=false;throw new Error('simulated worker interruption after source commit');}return response;};
 assert.equal((await h.post()).status,500);const calls=structuredClone(pipeline.calls);const retry=await h.post();assert.equal(retry.status,200);assert.equal((await retry.json()).status,'REVIEW_REQUIRED');assert.deepEqual(pipeline.calls,calls);
 assert.equal((await h.pool.query('SELECT count(*)::int n FROM discovery_source_steps')).rows[0].n,2);assert.equal((await h.pool.query('SELECT count(*)::int n FROM public_fact_batches')).rows[0].n,2);
});
test('retry after stage commit/response interruption repeats exact private stage request with no queries',{skip:!url},async t=>{
 const pipeline=publicPipeline(),h=await setup(t,pipeline.options),original=h.app.publicFacts.stage.bind(h.app.publicFacts);let first=true;
 h.app.publicFacts.stage=async(...args)=>{const response=await original(...args);if(first){first=false;throw new Error('simulated stage response loss');}return response;};
 assert.equal((await h.post()).status,500);const calls=structuredClone(pipeline.calls);const r=await h.post();assert.equal(r.status,200);assert.equal((await r.json()).status,'REVIEW_REQUIRED');assert.deepEqual(pipeline.calls,calls);assert.equal((await h.pool.query('SELECT count(*)::int n FROM public_fact_batches')).rows[0].n,2);
});
test('incomplete retained workflow cannot return proposal references after source disable or logout',{skip:!url},async t=>{
 const pipeline=publicPipeline(),h=await setup(t,pipeline.options),original=h.app.publicFacts.stage.bind(h.app.publicFacts);
 h.app.publicFacts.stage=async(...args)=>{await original(...args);throw new Error('pause');};assert.equal((await h.post()).status,500);const count=pipeline.calls.queries.length;
 await h.pool.query('UPDATE private_sources SET enabled=false');assert.equal((await h.post()).status,403);assert.equal(pipeline.calls.queries.length,count);
 await h.db.store.revokeSession(h.actor.sessionHash,Date.now());assert.equal((await h.post()).status,401);assert.equal(pipeline.calls.queries.length,count);
});
test('denied public assertions and snippets do not create sources or staged proposals',{skip:!url},async t=>{
 const h=await setup(t,{search:async()=>[{url:'https://example.org/denied',title:'Hint',snippet:'Person Alpha is a friend of Person Beta.',provider:'TAVILY',evidenceStatus:'DISCOVERY_HINT'}],documents:{fetch:async u=>article(u,"Person Alpha isn't a friend of Person Beta.")}});
 const r=await h.post();assert.equal(r.status,200);const result=await r.json();assert.equal(result.status,'INSUFFICIENT_PUBLIC_EVIDENCE');assert.deepEqual(result.proposalRefs,[]);assert.equal((await h.pool.query('SELECT count(*)::int n FROM public_fact_batches')).rows[0].n,0);assert.equal((await h.pool.query('SELECT count(*)::int n FROM private_sources')).rows[0].n,0);
});
test('completed workflow replay rechecks newly provisioned source policies and observation heads',{skip:!url},async t=>{
 const pipeline=publicPipeline(),h=await setup(t,pipeline.options);assert.equal((await h.post()).status,200);const count=pipeline.calls.queries.length;
 await h.pool.query("UPDATE private_sources SET policy_version='changed-policy'");assert.equal((await h.post()).status,403);assert.equal(pipeline.calls.queries.length,count);
 await h.pool.query("UPDATE private_sources SET policy_version='public-citation-review-v1'");
 const head=(await h.pool.query("SELECT source_id,id FROM public_fact_heads WHERE kind='DOCUMENT' LIMIT 1")).rows[0];
 await h.pool.query("DELETE FROM public_fact_heads WHERE source_id=$1 AND id=$2 AND kind='DOCUMENT'",[head.source_id,head.id]);assert.equal((await h.post()).status,409);assert.equal(pipeline.calls.queries.length,count);
});
