import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {before,after,describe,it} from 'node:test';
import {Pool} from 'pg';
import {canonicalJson} from '../dist/contracts/canonical.js';
import {PgStore} from '../dist/packages/server/storage/postgres.js';
import {migratePrivateStorage} from '../dist/packages/server/storage/migrate.js';
import {migrateFactsStorage} from '../dist/packages/server/facts/migrate.js';
import {migratePublicFactsStorage} from '../dist/packages/server/public-facts/migrate.js';
import {migratePublicClaimDecisions} from '../dist/packages/server/public-facts/acceptance-migrate.js';
import {PgPublicFactsStore} from '../dist/packages/server/public-facts/postgres.js';
import {PublicFactsService} from '../dist/packages/server/public-facts/service.js';
import {PgPublicClaimStore,PublicClaimReviewService} from '../dist/packages/server/public-facts/acceptance.js';
import {PgFactStore} from '../dist/packages/server/facts/postgres.js';
import {FactReviewService} from '../dist/packages/server/facts/service.js';
import {withFactScope,saveFactSnapshot} from '../dist/packages/server/facts/transaction.js';
import {refreshPublicCitationProjection} from '../dist/packages/server/public-facts/projection.js';
import {publicStage,publicTime,textHash} from './public-facts-fixture.mjs';
import {attributedStage} from './public-attribution-fixture.mjs';
const url=process.env.STORAGE_TEST_DATABASE_URL;
if(url){const u=new URL(url);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'55439');assert.equal(u.pathname,'/postgres');assert.equal(u.username,'projekt1_test');}
const migration=name=>fileURLToPath(new URL(`../migrations/${name}`,import.meta.url));
const rejectsCode=(fn,code)=>assert.rejects(fn,error=>error.code===code);
// Anonymous test calibration only. Product code supplies no default policy or numerical weights.
const policy={version:'anonymous-test-only-v1',semantics:{strength:'Anonymous relative preference, not willingness.',confidence:'Anonymous evidence-support heuristic, not a probability.',recency:'No decay in this anonymous fixture; does not attest recent contact.'},
 assess:({relativeStrength})=>({strength:relativeStrength??0.6,confidence:0.7,recencyFactor:0.8,warnings:['Anonymous test policy only.']})};
function directStage(a,revision='v1',version='1'){
 const x=publicStage({userId:a.user.userId,scopeId:a.scopeId,sourceId:a.sourceId,revision,expectedGraphVersion:version});
 const text='1 is a friend of 2.\n1.\n2.';
 x.texts[0].normalizedText=text;x.envelope.documents[0].contentDigest=textHash(text);x.envelope.normalized.records[0].contentDigest=textHash(text);
 x.envelope.normalized.batch.evidence[2].summary='1 is a friend of 2.';
 x.envelope.citations.forEach((c,i)=>{c.supportingExcerpt=x.envelope.normalized.batch.evidence[i].summary;c.locator.start=i===0?20:i===1?23:0;c.locator.end=i===0?21:i===1?24:19;});
 Object.assign(x.envelope.proposals[0],{predicate:'FRIEND_OF',relationshipKind:'FRIEND',support:'DIRECT_EXPLICIT',extractionUncertainties:[]});return x;
}
describe('public relationship review: current proof, explicit policy and atomic projection',{skip:!url},()=>{
 let admin,pool,store,facts,claims,manual,auth;
 const schema=`public_claims_${randomUUID().replaceAll('-','')}`;
 before(async()=>{
  admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA ${schema}`);
  pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,application_name:schema,max:16});store=new PgStore(pool);
  await migratePrivateStorage(pool,migration('001_private_storage.sql'));
  await migrateFactsStorage(pool,migration('003_fact_reviews.sql'));await migratePublicFactsStorage(pool,migration('004_public_fact_staging.sql'));
  await Promise.all([migratePublicClaimDecisions(pool,migration('006_public_claim_decisions.sql')),migratePublicClaimDecisions(pool,migration('006_public_claim_decisions.sql'))]);
  auth={resolveSession:async credential=>{if(typeof credential!=='string')return null;const s=await store.getSession(textHash(credential));return s?{userId:s.userId}:null;}};
  facts=new PublicFactsService({auth,publicFacts:new PgPublicFactsStore(pool)});
  claims=new PublicClaimReviewService({auth,claims:new PgPublicClaimStore(pool,{policy})});manual=new FactReviewService({auth,facts:new PgFactStore(pool)});
 });
 after(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}});
 async function owner(){
  const user=await store.upsertGoogleUser({googleSubject:randomUUID(),displayName:'0'}),scopeId=(await store.listPrivateScopes(user.userId))[0].id;
  const token=randomBytes(32).toString('base64url'),sessionHash=textHash(token),sourceId=randomUUID();
  await store.putSession({tokenHash:sessionHash,userId:user.userId,createdAt:Date.now()-1000,expiresAt:Date.now()+60000,revokedAt:null});
  await store.provisionSource({actorUserId:user.userId,scopeId,expectedGraphVersion:'0',source:{id:sourceId,provider:'PUBLIC_ARTICLE',origin:'PUBLIC_SOURCE',label:'Anonymous source',importedAt:publicTime},policyVersion:'public-citation-review-v1'});
  const scope=await store.authorizePrivateScope(user.userId,scopeId);return {user,scopeId,sourceId,scope,token,sessionHash};
 }
 const graph=a=>store.readSnapshot(a.scope);
 const review=(a,b)=>facts.review(a.token,{scopeId:a.scopeId,batchId:b.batchId});
 const count=async(a,t)=>(await pool.query(`SELECT count(*) FROM ${t} WHERE owner_user_id=$1`,[a.user.userId])).rows[0].count;
 async function prepared(inputMutate=x=>x){
  const a=await owner(),input=inputMutate(directStage(a)),batch=await facts.stage(a.token,input);
  const mentions=[input.envelope.proposals[0].subject.mention,input.envelope.proposals[0].object.mention];
  for(const [index,mention] of mentions.entries()){
   const r=await review(a,batch),ep=r.endpoints.find(e=>e.endpoint.mention===mention);
   await facts.resolve(a.token,{scopeId:a.scopeId,expectedGraphVersion:r.graphVersion,idempotencyKey:randomUUID(),confirm:true,endpointId:ep.endpointId,expectedEndpointRevision:ep.endpointRevision,expectedResolutionDecisionId:ep.latestResolutionDecisionId,
    disposition:index===0?'LINK_EXISTING':'NEW_PERSON',...(index===0?{personId:a.scope.rootPersonId}:{})});
  }
  const r=await review(a,batch),binding=mention=>{const e=r.endpoints.find(e=>e.endpoint.mention===mention);return {endpointId:e.endpointId,endpointRevision:e.endpointRevision,resolutionDecisionId:e.latestResolutionDecisionId};};
  const decision={sourceId:a.sourceId,proposalId:'p1',proposalRevision:'v1',decision:'ACCEPT',includeInSearch:true,bindings:{subject:binding(mentions[0]),object:binding(mentions[1])},relativeStrength:0.5};
  const request={scopeId:a.scopeId,expectedGraphVersion:r.graphVersion,idempotencyKey:randomUUID(),confirm:true,decisions:[decision]};return {a,batch,request};
 }
 it('source-authored acceptance binds author identity citation and invalidates traversal when it changes',async()=>{
  const {a,request}=await prepared(attributedStage);
  await claims.review(a.token,request);const before=await graph(a);assert.equal(before.searchEdges.length,1);
  await pool.query("UPDATE public_fact_resources SET payload=jsonb_set(payload,'{locator,start}','1'::jsonb) WHERE scope_id=$1 AND owner_user_id=$2 AND source_id=$3 AND kind='CITATION' AND id='c0_v1'",[a.scopeId,a.user.userId,a.sourceId]);
  const after=await graph(a);assert.equal(after.searchEdges.length,0);
  assert.equal(BigInt(after.graphVersion),BigInt(before.graphVersion)+1n);
  assert.equal((await graph(a)).graphVersion,after.graphVersion);
 });
 it('accepts exact directed proof using explicit policy and original evidence; concurrent receipt commits once',async()=>{
  const {a,batch,request}=await prepared(),before=await graph(a);
  const results=await Promise.all(Array.from({length:4},()=>claims.review(a.token,request))),out=results.find(r=>!r.duplicate),g=await graph(a);
  assert.equal(results.filter(r=>!r.duplicate).length,1);assert.equal(await count(a,'public_claim_reviews'),'1');assert.equal(await count(a,'public_claim_decisions'),'1');
  assert.equal(g.graphVersion,(BigInt(before.graphVersion)+1n).toString());assert.equal(g.searchEdges.length,1);
  const edge=g.searchEdges[0],rel=g.relationships[0];assert.equal(edge.fromPersonId,g.rootPersonId);assert.equal(edge.toPersonId,rel.toPersonId);
  assert.deepEqual([edge.strength,edge.confidence,edge.recencyFactor],[0.5,0.7,0.8]);assert.equal(edge.policyVersion,policy.version);
  assert.equal(g.sources.some(s=>s.provider==='MANUAL'),false);assert.deepEqual(rel.evidenceIds,['r1_v1']);assert.equal(g.evidence.find(e=>e.id==='r1_v1').confidence,0);
  const ledger=(await pool.query('SELECT * FROM public_claim_decisions WHERE id=$1',[out.decisions[0].decisionId])).rows[0];assert.equal(ledger.basis,'PUBLIC_CITATION_REVIEW');assert.deepEqual(ledger.policy_semantics,policy.semantics);
  const r=await review(a,batch);assert.equal(r.proposals[0].reviewState,'CONFIRMED');assert.equal(r.proposals[0].includeInSearch,true);
  await rejectsCode(()=>claims.review(a.token,{...request,decisions:[{...request.decisions[0],relativeStrength:0.2}]}),'VERSION_CONFLICT');
 });
 it('missing or unassessed policy fails closed and private opt-out stores no invented factors',async()=>{
  const {a,request}=await prepared(),before=await graph(a);
  for(const p of [undefined,{...policy,assess:()=>null},{...policy,assess:()=>({strength:null,confidence:null,recencyFactor:null,warnings:[]})}]){
   const service=new PublicClaimReviewService({auth,claims:new PgPublicClaimStore(pool,{policy:p})});
   await rejectsCode(()=>service.review(a.token,request),'SOURCE_UNAVAILABLE');assert.deepEqual(await graph(a),before);
  }
  const service=new PublicClaimReviewService({auth,claims:new PgPublicClaimStore(pool)}),result=await service.review(a.token,{...request,decisions:[{...request.decisions[0],includeInSearch:false}]});
  assert.equal(result.decisions[0].relationshipId,null);assert.equal((await graph(a)).relationships.length,0);assert.equal((await graph(a)).searchEdges.length,0);
 });
 it('rejects context, unknown kind, unresolved/stale/reversed and foreign endpoint bindings without writes',async()=>{
  for(const patch of [{support:'CONTEXT_ONLY'},{support:'AMBIGUOUS'},{relationshipKind:'UNKNOWN'}]){
   const {a,request}=await prepared(x=>{Object.assign(x.envelope.proposals[0],patch);return x;});await rejectsCode(()=>claims.review(a.token,request),'INVALID_INPUT');assert.equal(await count(a,'public_claim_decisions'),'0');
  }
  const {a,request}=await prepared(),other=await prepared(),before=await graph(a);
  for(const bindings of [{...request.decisions[0].bindings,subject:{...request.decisions[0].bindings.subject,resolutionDecisionId:'unresolved'}},{subject:request.decisions[0].bindings.object,object:request.decisions[0].bindings.subject},other.request.decisions[0].bindings])
   await rejectsCode(()=>claims.review(a.token,{...request,decisions:[{...request.decisions[0],bindings}]}),'VERSION_CONFLICT');
  await rejectsCode(()=>claims.review(other.a.token,request),'FORBIDDEN');assert.deepEqual(await graph(a),before);
 });
 it('batch failure rolls back earlier valid decisions, relationship, evidence, projection and version',async()=>{
  const {a,request}=await prepared(),before=await graph(a);
  await rejectsCode(()=>claims.review(a.token,{...request,decisions:[...request.decisions,{sourceId:a.sourceId,proposalId:'missing',proposalRevision:'v1',decision:'REJECT'}]}),'FORBIDDEN');
  assert.deepEqual(await graph(a),before);assert.equal(await count(a,'public_claim_decisions'),'0');assert.equal(await count(a,'public_claim_reviews'),'0');
  await pool.query("CREATE FUNCTION reject_claim_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'anonymous rollback'; END $$");
  await pool.query('CREATE TRIGGER reject_claim_receipt BEFORE INSERT ON public_claim_reviews FOR EACH ROW EXECUTE PROCEDURE reject_claim_receipt()');
  try{await assert.rejects(()=>claims.review(a.token,request));assert.deepEqual(await graph(a),before);assert.equal(await count(a,'public_claim_decisions'),'0');}
  finally{await pool.query('DROP TRIGGER reject_claim_receipt ON public_claim_reviews');await pool.query('DROP FUNCTION reject_claim_receipt()');}
 });
 it('rejection removes traversal and superseded acceptance cannot replay; opt-out keeps no edge',async()=>{
  const {a,request}=await prepared();await claims.review(a.token,request);
  const g=await graph(a),rejected=await claims.review(a.token,{...request,expectedGraphVersion:g.graphVersion,idempotencyKey:randomUUID(),decisions:[{sourceId:a.sourceId,proposalId:'p1',proposalRevision:'v1',decision:'REJECT'}]});
  assert.equal(rejected.events[0].removedEdgeIds.length,1);assert.equal((await graph(a)).searchEdges.length,0);assert.equal((await graph(a)).relationships[0].state,'REJECTED');
  await rejectsCode(()=>claims.review(a.token,request),'VERSION_CONFLICT');
  await claims.review(a.token,{...request,expectedGraphVersion:rejected.graphVersion,idempotencyKey:randomUUID(),decisions:[{...request.decisions[0],includeInSearch:false}]});assert.equal((await graph(a)).searchEdges.length,0);
 });
 it('stale rejection cannot mutate a newer accepted revision; current rejection and exact retry still work',async()=>{
  const {a,request}=await prepared();await claims.review(a.token,request);
  const first=await graph(a),batch=await facts.stage(a.token,directStage(a,'v2',first.graphVersion));
  for(const mention of ['1','2']){
   const r=await review(a,batch),ep=r.endpoints.find(e=>e.endpoint.mention===mention);
   await facts.resolve(a.token,{scopeId:a.scopeId,expectedGraphVersion:r.graphVersion,idempotencyKey:randomUUID(),confirm:true,
    endpointId:ep.endpointId,expectedEndpointRevision:ep.endpointRevision,expectedResolutionDecisionId:ep.latestResolutionDecisionId,
    disposition:'LINK_EXISTING',personId:mention==='1'?first.rootPersonId:first.relationships[0].toPersonId});
  }
  const r=await review(a,batch),binding=mention=>{const ep=r.endpoints.find(e=>e.endpoint.mention===mention);return {endpointId:ep.endpointId,endpointRevision:ep.endpointRevision,resolutionDecisionId:ep.latestResolutionDecisionId};};
  await claims.review(a.token,{...request,expectedGraphVersion:r.graphVersion,idempotencyKey:randomUUID(),decisions:[{...request.decisions[0],proposalRevision:'v2',bindings:{subject:binding('1'),object:binding('2')}}]});
  const before=await graph(a);assert.equal(before.searchEdges.length,1);assert.equal(before.relationships[0].state,'CONFIRMED');assert.deepEqual(before.relationships[0].evidenceIds,['r1_v2']);
  const stale={...request,expectedGraphVersion:before.graphVersion,idempotencyKey:randomUUID(),decisions:[{sourceId:a.sourceId,proposalId:'p1',proposalRevision:'v1',decision:'REJECT'}]};
  await rejectsCode(()=>claims.review(a.token,stale),'VERSION_CONFLICT');assert.deepEqual(await graph(a),before);
  assert.equal(await count(a,'public_claim_decisions'),'2');assert.equal(await count(a,'public_claim_reviews'),'2');
  const current={...stale,idempotencyKey:randomUUID(),decisions:[{...stale.decisions[0],proposalRevision:'v2'}]},result=await claims.review(a.token,current);
  assert.equal(result.events[0].removedEdgeIds.length,1);const after=await graph(a);assert.equal(after.searchEdges.length,0);assert.equal(after.relationships[0].state,'REJECTED');
  assert.deepEqual(await claims.review(a.token,current),{...result,duplicate:true});assert.deepEqual(await graph(a),after);
  assert.equal(await count(a,'public_claim_decisions'),'3');assert.equal(await count(a,'public_claim_reviews'),'3');
 });
 it('a new document revision removes stale traversal atomically and invalidates old acceptance retry',async()=>{
  const {a,request}=await prepared();await claims.review(a.token,request);const before=await graph(a);
  await facts.stage(a.token,directStage(a,'v2',before.graphVersion));const g=await graph(a);assert.equal(g.searchEdges.length,0);assert.equal(g.relationships.length,1);
  await rejectsCode(()=>claims.review(a.token,request),'VERSION_CONFLICT');assert.equal(g.evidence.find(e=>e.id==='r1_v1').confidence,0);
 });
 it('withdrawn source policy and changed canonical identity mapping cannot retain projected edges',async()=>{
  for(const mutation of ['source','identity','identity_evidence']){
   const {a,request}=await prepared();await claims.review(a.token,request);
   await withFactScope(pool,{userId:a.user.userId,sessionHash:a.sessionHash},a.scopeId,async(c,row,sources)=>{
    const g=structuredClone(row.snapshot);
    if(mutation==='source'){await c.query("UPDATE private_sources SET policy_version='withdrawn' WHERE id=$1",[a.sourceId]);sources.find(s=>s.id===a.sourceId).policy_version='withdrawn';}
    else{const identity=g.identities.find(i=>i.personId!==g.rootPersonId);
     if(mutation==='identity_evidence')identity.evidenceIds=[...g.identities.find(i=>i.personId===g.rootPersonId).evidenceIds];
     else{g.people.find(p=>p.id===identity.personId).identityIds=[];identity.personId=null;identity.assignmentState='PENDING';}}
    await refreshPublicCitationProjection(c,row,g,sources);await saveFactSnapshot(c,row,sources,g);
   });
   assert.equal((await graph(a)).searchEdges.length,0);await rejectsCode(()=>claims.review(a.token,request),mutation==='source'?'FORBIDDEN':'VERSION_CONFLICT');
  }
 });
 it('manual review preserves proven public edges and rejects relabelling public relationships',async()=>{
  const {a,request}=await prepared();await claims.review(a.token,request);const g=await graph(a),edge=g.searchEdges[0];
  await rejectsCode(()=>manual.confirm(a.token,{scopeId:a.scopeId,expectedGraphVersion:g.graphVersion,idempotencyKey:randomUUID(),confirm:true,change:{type:'RELATIONSHIP',relationshipId:edge.relationshipId,decision:'ACCEPT',confirmation:{kind:'FRIEND',strength:1,statement:'Anonymous manual assertion.',includeInSearch:true}}}),'FORBIDDEN');
  // Anonymous preexisting contact observation fixture; does not run an import or assert product facts.
  g.observedLinks.push({id:'anonymous-contact',fromPersonId:g.rootPersonId,toPersonId:edge.toPersonId,kind:'CONTACT_SAVED',evidenceIds:edge.evidenceIds,confidence:0,observedAt:publicTime});
  await pool.query('UPDATE private_scopes SET snapshot=$1 WHERE id=$2',[g,a.scopeId]);
  await manual.confirm(a.token,{scopeId:a.scopeId,expectedGraphVersion:g.graphVersion,idempotencyKey:randomUUID(),confirm:true,change:{type:'RELATIONSHIP_FROM_OBSERVATION',observedLinkId:'anonymous-contact',decision:'ACCEPT',confirmation:{kind:'ACQUAINTANCE',strength:0.2,statement:'Anonymous manual assertion.',includeInSearch:false}}});
  const after=await graph(a);assert.deepEqual(after.searchEdges,[edge]);assert.deepEqual(after.relationships.find(r=>r.id===edge.relationshipId),g.relationships[0]);
  await facts.stage(a.token,directStage(a,'v2',after.graphVersion));assert.equal((await graph(a)).searchEdges.length,0);
 });
 async function staleDocumentSnapshot(a){
  const before=await graph(a);
  await facts.stage(a.token,directStage(a,'v2',before.graphVersion));
  const current=await graph(a);
  // Model a previously persisted stale projection, while keeping actual versioned resources valid.
  current.searchEdges=before.searchEdges;
  await pool.query('UPDATE private_scopes SET snapshot=$1 WHERE id=$2',[current,a.scopeId]);
  return current;
 }
 it('ordinary graph reads repair obsolete public projections once and persist the new version',async()=>{
  for(const mutation of ['policy','document','identity']){
   const {a,request}=await prepared();await claims.review(a.token,request);let before=await graph(a);
   if(mutation==='policy')await pool.query("UPDATE private_sources SET policy_version='withdrawn' WHERE id=$1",[a.sourceId]);
   else if(mutation==='document')before=await staleDocumentSnapshot(a);
   else {
    const g=structuredClone(before),identity=g.identities.find(i=>i.personId!==g.rootPersonId);
    g.people.find(p=>p.id===identity.personId).identityIds=[];identity.personId=null;identity.assignmentState='PENDING';
    await pool.query('UPDATE private_scopes SET snapshot=$1 WHERE id=$2',[g,a.scopeId]);
   }
   const after=await graph(a);assert.equal(after.searchEdges.length,0);assert.equal(after.graphVersion,(BigInt(before.graphVersion)+1n).toString());
   assert.equal(after.relationships.length,1);assert.deepEqual(await graph(a),after);
   const persisted=(await pool.query('SELECT snapshot FROM private_scopes WHERE id=$1',[a.scopeId])).rows[0].snapshot;
   assert.deepEqual(persisted,after);
  }
 });
 it('source provisioning persists current public projection without requiring a later read repair',async()=>{
  const {a,request}=await prepared();await claims.review(a.token,request);const before=await staleDocumentSnapshot(a);
  await store.provisionSource({actorUserId:a.user.userId,scopeId:a.scopeId,expectedGraphVersion:before.graphVersion,source:{id:randomUUID(),provider:'PUBLIC_ARTICLE',origin:'PUBLIC_SOURCE',label:'Another anonymous source',importedAt:publicTime},policyVersion:'public-citation-review-v1'});
  const persisted=(await pool.query('SELECT snapshot FROM private_scopes WHERE id=$1',[a.scopeId])).rows[0].snapshot;
  assert.equal(persisted.searchEdges.length,0);assert.equal(persisted.graphVersion,(BigInt(before.graphVersion)+1n).toString());
 });
 it('import approval reports withdrawn public edges in its committed delta',async()=>{
  const {a,request}=await prepared();await claims.review(a.token,request);const before=await staleDocumentSnapshot(a);
  const context={sourceId:a.sourceId,scopeId:a.scopeId,ownerUserId:a.user.userId,batchId:randomUUID(),sourcePolicyVersion:'public-citation-review-v1',sharingDecisionId:null};
  const envelope={context,batch:{schemaVersion:1,batchId:context.batchId,sourceId:a.sourceId,people:[],relationships:[],observedLinks:[],affiliations:[],evidence:[],warnings:[]},records:[],evidenceRecords:[],facts:[]};
  const job=await store.stage({actorUserId:a.user.userId,context,expectedGraphVersion:before.graphVersion,payloadDigest:textHash(canonicalJson(envelope)),envelope});
  const out=await store.approveImportObservations({actorUserId:a.user.userId,scopeId:a.scopeId,jobId:job.jobId,expectedGraphVersion:before.graphVersion,idempotencyKey:randomUUID(),personAssignments:[]});
  const delta=out.events.find(e=>e.type==='BATCH_COMMITTED');assert.deepEqual(delta.removedEdgeIds,before.searchEdges.map(e=>e.id));assert.deepEqual(delta.searchEdges,[]);
  const persisted=(await pool.query('SELECT snapshot FROM private_scopes WHERE id=$1',[a.scopeId])).rows[0].snapshot;
  assert.equal(persisted.searchEdges.length,0);assert.equal(persisted.graphVersion,out.graphVersion);
 });
 it('failed read repair rolls back instead of returning stale public edges',async()=>{
  const {a,request}=await prepared();await claims.review(a.token,request);const before=await staleDocumentSnapshot(a);
  await pool.query(`CREATE FUNCTION reject_projection_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'anonymous repair failure'; END $$`);
  await pool.query('CREATE TRIGGER reject_projection_update BEFORE UPDATE ON private_scopes FOR EACH ROW EXECUTE FUNCTION reject_projection_update()');
  try{await assert.rejects(()=>graph(a));assert.deepEqual((await pool.query('SELECT snapshot FROM private_scopes WHERE id=$1',[a.scopeId])).rows[0].snapshot,before);}
  finally{await pool.query('DROP TRIGGER reject_projection_update ON private_scopes');await pool.query('DROP FUNCTION reject_projection_update()');}
  assert.equal((await graph(a)).searchEdges.length,0);
 });
 it('expired and revoked sessions never persist acceptance',async()=>{
  for(const column of ['expires_at','revoked_at']){const {a,request}=await prepared(),before=await graph(a);await pool.query(`UPDATE app_sessions SET ${column}=$1 WHERE token_hash=$2`,[Date.now()-1,a.sessionHash]);await rejectsCode(()=>claims.review(a.token,request),'UNAUTHENTICATED');assert.deepEqual(await graph(a),before);assert.equal(await count(a,'public_claim_decisions'),'0');}
 });
});
