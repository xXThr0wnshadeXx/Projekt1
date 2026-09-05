import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {before,after,describe,it} from 'node:test';
import {Pool} from 'pg';
import {PgStore} from '../dist/packages/server/storage/postgres.js';
import {migratePrivateStorage} from '../dist/packages/server/storage/migrate.js';
import {migratePublicFactsStorage} from '../dist/packages/server/public-facts/migrate.js';
import {PgPublicFactsStore} from '../dist/packages/server/public-facts/postgres.js';
import {PublicFactsService} from '../dist/packages/server/public-facts/service.js';
import {validateGraphBuildEvent} from '../dist/contracts/validation.js';
import {publicStage,publicTime,textHash} from './public-facts-fixture.mjs';
const url=process.env.STORAGE_TEST_DATABASE_URL;
if(url){const u=new URL(url);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'55439');assert.equal(u.pathname,'/postgres');assert.equal(u.username,'projekt1_test');}
const migration=name=>fileURLToPath(new URL(`../migrations/${name}`,import.meta.url));
const rejectsCode=(fn,code)=>assert.rejects(fn,error=>error.code===code);

describe('private public-citation staging and explicit intermediate identity review', {skip:!url},()=>{
 let admin,pool,store,publicFacts,api;
 const schema=`public_facts_${randomUUID().replaceAll('-','')}`;
 before(async()=>{
  admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA ${schema}`);
  pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,application_name:schema,max:16});
  store=new PgStore(pool);publicFacts=new PgPublicFactsStore(pool);
  await migratePrivateStorage(pool,migration('001_private_storage.sql'));
  await Promise.all([migratePublicFactsStorage(pool,migration('004_public_fact_staging.sql')),migratePublicFactsStorage(pool,migration('004_public_fact_staging.sql'))]);
  api=new PublicFactsService({auth:{resolveSession:async credential=>{if(typeof credential!=='string')return null;const s=await store.getSession(textHash(credential));return s?{userId:s.userId}:null;}},publicFacts});
 });
 after(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}});
 async function owner(){
  const user=await store.upsertGoogleUser({googleSubject:randomUUID(),displayName:'0'}),scopeId=(await store.listPrivateScopes(user.userId))[0].id;
  const token=randomBytes(32).toString('base64url'),sessionHash=textHash(token),sourceId=randomUUID();
  await store.putSession({tokenHash:sessionHash,userId:user.userId,createdAt:Date.now()-1000,expiresAt:Date.now()+60000,revokedAt:null});
  await store.provisionSource({actorUserId:user.userId,scopeId,expectedGraphVersion:'0',source:{id:sourceId,provider:'PUBLIC_ARTICLE',origin:'PUBLIC_SOURCE',label:'1',importedAt:publicTime},policyVersion:'public-citation-review-v1'});
  const scope=await store.authorizePrivateScope(user.userId,scopeId);
  return {user,scopeId,sourceId,scope,token,sessionHash};
 }
 const stageInput=(a,revision='v1',expectedGraphVersion='1')=>publicStage({userId:a.user.userId,scopeId:a.scopeId,sourceId:a.sourceId,revision,expectedGraphVersion});
 const graph=a=>store.readSnapshot(a.scope);
 const review=(a,batch)=>api.review(a.token,{scopeId:a.scopeId,batchId:batch.batchId});
 const resolution=(a,r,index=0,disposition='NEW_PERSON',personId)=>({scopeId:a.scopeId,expectedGraphVersion:r.graphVersion,idempotencyKey:randomUUID(),confirm:true,
  endpointId:r.endpoints[index].endpointId,expectedEndpointRevision:r.endpoints[index].endpointRevision,expectedResolutionDecisionId:r.endpoints[index].latestResolutionDecisionId,
  disposition,...(disposition==='LINK_EXISTING'?{personId}:{})});
 const count=async(a,table)=>(await pool.query(`SELECT count(*) FROM ${table} WHERE owner_user_id=$1`,[a.user.userId])).rows[0].count;
 async function waitLock(query){for(let i=0;i<150;i++){const r=await admin.query("SELECT query FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",[schema]);if(r.rows.some(row=>row.query.includes(query)))return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('lock wait not observed');}
 it('atomically stages exact private text/citations and pending proposals without creating graph entities',async()=>{
  assert.equal((await pool.query("SELECT count(*) FROM app_migrations WHERE id='004_public_fact_staging'")).rows[0].count,'1');
  const a=await owner(),before=await graph(a),input=stageInput(a),batch=await api.stage(a.token,input),after=await graph(a);
  assert.equal(batch.graphVersion,'2');assert.deepEqual({...after,graphVersion:before.graphVersion},before);
  const r=await review(a,batch);assert.equal(r.endpoints.length,2);assert.ok(r.endpoints.every(e=>e.current&&e.resolution===null));
  assert.equal(r.proposals[0].confidence.value,null);assert.equal(r.proposals[0].reviewState,'PENDING');assert.equal(r.proposals[0].includeInSearch,false);
  const serialized=JSON.stringify(r);assert.equal(serialized.includes('privatePayloadRef'),false);assert.equal(serialized.includes('normalizedText'),false);assert.equal(serialized.includes(a.sessionHash),false);
  const stored=(await pool.query("SELECT payload FROM public_fact_resources WHERE owner_user_id=$1 AND kind='DOCUMENT'",[a.user.userId])).rows[0].payload;
  assert.equal(stored.normalizedText,input.texts[0].normalizedText);assert.equal(stored.document.contentDigest,textHash(stored.normalizedText));
  assert.equal((await api.stage(a.token,input)).duplicate,true);assert.equal(await count(a,'public_fact_batches'),'1');
  await rejectsCode(()=>api.stage(a.token,{...input,idempotencyKey:'changed-key'}),'VERSION_CONFLICT');
 });
 it('stages and retains a 64KiB document beyond the shared metadata string cap',async()=>{
  const a=await owner(),input=stageInput(a),text=input.texts[0].normalizedText.padEnd(64*1024,'x');
  input.texts[0].normalizedText=text;input.envelope.documents[0].contentDigest=textHash(text);input.envelope.normalized.records[0].contentDigest=textHash(text);
  const result=await api.stage(a.token,input);assert.equal(result.graphVersion,'2');
  const stored=(await pool.query("SELECT payload FROM public_fact_resources WHERE owner_user_id=$1 AND kind='DOCUMENT'",[a.user.userId])).rows[0].payload;
  assert.equal(Buffer.byteLength(stored.normalizedText),64*1024);assert.equal(stored.normalizedText,text);assert.equal(stored.document.contentDigest,textHash(text));
  const visible=await review(a,result);assert.equal(visible.citations[0].supportingExcerpt,'1');assert.equal(JSON.stringify(visible).includes('normalizedText'),false);
  assert.equal((await graph(a)).people.length,1);assert.equal((await graph(a)).searchEdges.length,0);
 });
 it('explicitly creates previously unknown intermediate people with citations and no social claims or fuzzy merge',async()=>{
  const a=await owner(),input=stageInput(a);input.envelope.proposals[0].object.mention='1';input.envelope.proposals[0].object.identityEvidenceIds=['i1_v1'];
  const batch=await api.stage(a.token,input),r=await review(a,batch),before=await graph(a),request=resolution(a,r);
  const first=await api.resolve(a.token,request),middle=await graph(a);
  assert.equal(middle.people.length,2);assert.equal(first.graphVersion,'3');assert.equal(middle.people.find(p=>p.id===first.personId).displayName,'1');
  for(const e of first.events)validateGraphBuildEvent(e,{jobId:first.decisionId,scopeId:a.scopeId,afterSeq:-1,before,after:middle,candidateIds:new Set(),proposalIds:new Set()});
  const r2=await review(a,batch),second=await api.resolve(a.token,resolution(a,r2,1));const final=await graph(a);
  assert.notEqual(first.personId,second.personId);assert.equal(final.people.filter(p=>p.displayName==='1').length,2);assert.equal(final.identities.length,2);
  assert.equal(final.relationships.length,0);assert.equal(final.observedLinks.length,0);assert.equal(final.searchEdges.length,0);assert.ok(final.people.every(p=>p.affiliations.length===0));
  assert.ok(final.evidence.every(e=>e.claimKind==='IDENTITY'&&e.sourceId===a.sourceId&&e.confidence===0));assert.equal(final.sources.length,1);assert.equal(final.sources[0].provider,'PUBLIC_ARTICLE');
  const ledger=(await pool.query('SELECT request,person_id FROM public_identity_decisions WHERE id=$1',[first.decisionId])).rows[0];assert.equal(ledger.request.disposition,'NEW_PERSON');
  const retry=await api.resolve(a.token,request);assert.equal(retry.duplicate,true);assert.equal(retry.personId,first.personId);assert.equal((await graph(a)).graphVersion,'4');
 });
 it('LINK_EXISTING is explicit, scoped, and never silently reassigns an accepted source identity',async()=>{
  const a=await owner(),b=await owner(),batch=await api.stage(a.token,stageInput(a)),r=await review(a,batch),g=await graph(a);
  await rejectsCode(()=>api.resolve(a.token,resolution(a,r,0,'LINK_EXISTING',b.scope.rootPersonId)),'FORBIDDEN');
  const result=await api.resolve(a.token,resolution(a,r,0,'LINK_EXISTING',g.rootPersonId));assert.equal(result.personId,g.rootPersonId);assert.equal((await graph(a)).people.length,1);
  const latest=await review(a,batch);await rejectsCode(()=>api.resolve(a.token,resolution(a,latest,0)),'VERSION_CONFLICT');assert.equal(await count(a,'public_identity_decisions'),'1');
 });
 it('foreign scope/source/context, malformed citation and unconfirmed caller mappings never stage',async()=>{
  const a=await owner(),b=await owner(),input=stageInput(a),g=await graph(a);
  await rejectsCode(()=>api.stage(null,input),'UNAUTHENTICATED');await rejectsCode(()=>api.stage(b.token,input),'FORBIDDEN');
  const foreign=structuredClone(input);foreign.envelope.normalized.context.ownerUserId=b.user.userId;await rejectsCode(()=>api.stage(a.token,foreign),'FORBIDDEN');
  const bad=structuredClone(input);bad.envelope.citations[0].supportingExcerpt='made up';await assert.rejects(()=>api.stage(a.token,bad));
  const mapped=structuredClone(input);mapped.envelope.proposals[0].subject.personId=g.rootPersonId;await assert.rejects(()=>api.stage(a.token,mapped));
  const mismatched=structuredClone(input);mismatched.envelope.documents[0].kind='PUBLIC_PROFILE';await rejectsCode(()=>api.stage(a.token,mismatched),'FORBIDDEN');
  assert.deepEqual(await graph(a),g);assert.equal(await count(a,'public_fact_batches'),'0');
 });
 it('new document revisions invalidate old endpoint selections/retries; explicit current mapping can be re-reviewed',async()=>{
  const a=await owner(),b1=await api.stage(a.token,stageInput(a)),r1=await review(a,b1),request=resolution(a,r1),resolved=await api.resolve(a.token,request);
  const b2=await api.stage(a.token,stageInput(a,'v2','3'));assert.equal(b2.graphVersion,'4');
  const old=await review(a,b1);assert.ok(old.endpoints.every(e=>!e.current));assert.equal(old.endpoints[0].resolution,null);
  await rejectsCode(()=>api.resolve(a.token,request),'VERSION_CONFLICT');
  const next=await review(a,b2);assert.equal(next.endpoints[0].latestResolutionDecisionId,resolved.decisionId);assert.equal(next.endpoints[0].resolution,null);
  await rejectsCode(()=>api.resolve(a.token,resolution(a,next,0)),'VERSION_CONFLICT');
  const refresh=await api.resolve(a.token,resolution(a,next,0,'LINK_EXISTING',resolved.personId));assert.equal(refresh.personId,resolved.personId);assert.equal((await graph(a)).people.length,2);
  const revive=stageInput(a,'v1','5');revive.idempotencyKey='revive';revive.envelope.normalized.context.batchId='revive';revive.envelope.normalized.batch.batchId='revive';
  await rejectsCode(()=>api.stage(a.token,revive),'VERSION_CONFLICT');
 });
 it('immutable document/proposal revisions cannot acquire changed content or citations under new requests',async()=>{
  const a=await owner(),input=stageInput(a);await api.stage(a.token,input);
  const changed=structuredClone(input);changed.expectedGraphVersion='2';changed.idempotencyKey='next';changed.envelope.normalized.context.batchId='next';changed.envelope.normalized.batch.batchId='next';changed.envelope.documents[0].title='changed';
  await rejectsCode(()=>api.stage(a.token,changed),'VERSION_CONFLICT');assert.equal(await count(a,'public_fact_batches'),'1');
  const newDoc=stageInput(a,'v2','2');newDoc.envelope.proposals[0].revision='v1';await rejectsCode(()=>api.stage(a.token,newDoc),'VERSION_CONFLICT');
  assert.equal((await graph(a)).graphVersion,'2');
 });
 it('new proposals reuse exact immutable identity evidence after materialization but cannot rewrite citation IDs',async()=>{
  const a=await owner(),input=stageInput(a),batch=await api.stage(a.token,input),r=await review(a,batch);
  await api.resolve(a.token,resolution(a,r));
  const next=structuredClone(input);next.expectedGraphVersion='3';next.idempotencyKey='new-proposal';
  next.envelope.normalized.context.batchId='new-proposal';next.envelope.normalized.batch.batchId='new-proposal';
  next.envelope.proposals[0].id='p2';next.envelope.proposals[0].factKey='fact2';
  const staged=await api.stage(a.token,next);assert.equal(staged.graphVersion,'4');assert.equal((await graph(a)).people.length,2);
  const bad=structuredClone(next);bad.expectedGraphVersion='4';bad.idempotencyKey='rewrite';
  bad.envelope.normalized.context.batchId='rewrite';bad.envelope.normalized.batch.batchId='rewrite';bad.envelope.citations[0].locator.section='rewritten';
  await rejectsCode(()=>api.stage(a.token,bad),'VERSION_CONFLICT');assert.equal((await graph(a)).graphVersion,'4');
 });
 it('source policy/revocation and changed canonical mappings block review and replay',async()=>{
  const a=await owner(),batch=await api.stage(a.token,stageInput(a)),r=await review(a,batch),request=resolution(a,r);await api.resolve(a.token,request);
  await pool.query('UPDATE private_sources SET policy_version=$1 WHERE id=$2',['revoked-policy',a.sourceId]);
  await rejectsCode(()=>review(a,batch),'FORBIDDEN');await rejectsCode(()=>api.resolve(a.token,request),'FORBIDDEN');
  await pool.query('UPDATE private_sources SET enabled=false WHERE id=$1',[a.sourceId]);await rejectsCode(()=>api.stage(a.token,stageInput(a)),'FORBIDDEN');
  const b=await owner(),bb=await api.stage(b.token,stageInput(b)),br=await review(b,bb),brequest=resolution(b,br);const result=await api.resolve(b.token,brequest),g=await graph(b);
  g.people.find(p=>p.id===result.personId).identityIds=[];g.identities[0].personId=null;g.identities[0].assignmentState='PENDING';
  await pool.query('UPDATE private_scopes SET snapshot=$1 WHERE id=$2',[g,b.scopeId]);
  await rejectsCode(()=>api.resolve(b.token,brequest),'VERSION_CONFLICT');assert.equal((await review(b,bb)).endpoints[0].resolution,null);
 });
 it('same-key concurrency commits once and changed/stale decisions cannot overwrite',async()=>{
  const a=await owner(),input=stageInput(a),batches=await Promise.all(Array.from({length:5},()=>api.stage(a.token,input)));assert.equal(batches.filter(b=>!b.duplicate).length,1);
  const r=await review(a,batches[0]),req=resolution(a,r),results=await Promise.all(Array.from({length:5},()=>api.resolve(a.token,req)));
  assert.equal(results.filter(r=>!r.duplicate).length,1);assert.equal(new Set(results.map(r=>r.personId)).size,1);assert.equal(await count(a,'public_identity_decisions'),'1');
  await rejectsCode(()=>api.resolve(a.token,{...req,disposition:'LINK_EXISTING',personId:a.scope.rootPersonId}),'VERSION_CONFLICT');
  await rejectsCode(()=>api.resolve(a.token,resolution(a,r,1)),'VERSION_CONFLICT');
 });
 it('forced identity ledger failure rolls back new person, source identity, citation evidence and version',async()=>{
  const a=await owner(),batch=await api.stage(a.token,stageInput(a)),r=await review(a,batch),g=await graph(a),req=resolution(a,r);req.idempotencyKey='rollback';
  await pool.query("CREATE FUNCTION reject_public_resolution() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.idempotency_key='rollback' THEN RAISE EXCEPTION 'test'; END IF; RETURN NEW; END $$");
  await pool.query('CREATE TRIGGER reject_public_resolution BEFORE INSERT ON public_identity_decisions FOR EACH ROW EXECUTE PROCEDURE reject_public_resolution()');
  try{await assert.rejects(()=>api.resolve(a.token,req));assert.deepEqual(await graph(a),g);assert.equal(await count(a,'public_identity_decisions'),'0');}
  finally{await pool.query('DROP TRIGGER reject_public_resolution ON public_identity_decisions');await pool.query('DROP FUNCTION reject_public_resolution()');}
 });
 it('logout first denies identity resolution and later logout waits behind its session-before-scope lock',async()=>{
  const a=await owner(),batch=await api.stage(a.token,stageInput(a)),r=await review(a,batch),blocker=await pool.connect();
  try{
   await blocker.query('BEGIN');await blocker.query('UPDATE app_sessions SET revoked_at=$1 WHERE token_hash=$2',[Date.now(),a.sessionHash]);
   const pending=api.resolve(a.token,resolution(a,r)),rejection=rejectsCode(()=>pending,'UNAUTHENTICATED');await waitLock('SELECT token_hash FROM app_sessions');await blocker.query('COMMIT');await rejection;
  }finally{await blocker.query('ROLLBACK');blocker.release();}
  assert.equal(await count(a,'public_identity_decisions'),'0');
  const b=await owner(),bb=await api.stage(b.token,stageInput(b)),br=await review(b,bb),block=await pool.connect();
  try{
   await block.query('BEGIN');await block.query('SELECT id FROM private_scopes WHERE id=$1 FOR UPDATE',[b.scopeId]);
   const pending=api.resolve(b.token,resolution(b,br));await waitLock('SELECT * FROM private_scopes');const logout=store.revokeSession(b.sessionHash,Date.now());await waitLock('UPDATE app_sessions SET revoked_at');
   await block.query('COMMIT');await pending;await logout;
  }finally{await block.query('ROLLBACK');block.release();}
  assert.equal(await count(b,'public_identity_decisions'),'1');
 });
 it('session expiry during scope lock waits rolls back public staging and identity creation',async()=>{
  for(const operation of ['stage','resolve']){
   const a=await owner(),batch=operation==='resolve'?await api.stage(a.token,stageInput(a)):null,r=batch?await review(a,batch):null,g=await graph(a),block=await pool.connect();
   await pool.query('UPDATE app_sessions SET expires_at=$1 WHERE token_hash=$2',[Date.now()+300,a.sessionHash]);
   try{
    await block.query('BEGIN');await block.query('SELECT id FROM private_scopes WHERE id=$1 FOR UPDATE',[a.scopeId]);
    const pending=operation==='stage'?api.stage(a.token,stageInput(a)):api.resolve(a.token,resolution(a,r));const rejection=rejectsCode(()=>pending,'UNAUTHENTICATED');
    await waitLock('SELECT * FROM private_scopes');await new Promise(resolve=>setTimeout(resolve,350));await block.query('COMMIT');await rejection;
   }finally{await block.query('ROLLBACK');block.release();}
   assert.deepEqual(await graph(a),g);assert.equal(await count(a,'public_identity_decisions'),'0');if(operation==='stage')assert.equal(await count(a,'public_fact_resources'),'0');
  }
 });
});
