import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {before,after,describe,it} from 'node:test';
import {Pool} from 'pg';
import {PgStore} from '../dist/packages/server/storage/postgres.js';
import {migratePrivateStorage} from '../dist/packages/server/storage/migrate.js';
import {migrateFactsStorage} from '../dist/packages/server/facts/migrate.js';
import {PgFactStore} from '../dist/packages/server/facts/postgres.js';
import {FactReviewService} from '../dist/packages/server/facts/service.js';
import {withFactWarnings} from '../dist/packages/server/facts/search.js';
import {factDigest,affiliationKey,projectConfirmedRelationships} from '../dist/packages/server/facts/projection.js';
import {BackendService} from '../dist/packages/server/service.js';
import {BoundedRouteSearch,EvidenceBackedGoalResolver,resolveEvidenceBackedTargets} from '../dist/packages/graph/src/index.js';
import {validateGraphBuildEvent} from '../dist/contracts/validation.js';

const url=process.env.STORAGE_TEST_DATABASE_URL;
// This bounded task may run database fixtures ONLY against the designated anonymous scratch cluster.
if(url){const parsed=new URL(url);assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.port,'55439');assert.equal(parsed.pathname,'/postgres');assert.equal(parsed.username,'projekt1_test');}
const hash=value=>createHash('sha256').update(value).digest('hex');
const migration=name=>fileURLToPath(new URL(`../migrations/${name}`,import.meta.url));
const now='2026-09-05T00:00:00.000Z';
const rejectsCode=(fn,code)=>assert.rejects(fn,error=>error.code===code);

describe('atomic private fact review with anonymous PostgreSQL', {skip:!url},()=>{
 let admin,pool,store,facts,api;
 const schema=`facts_test_${randomUUID().replaceAll('-','')}`;
 before(async()=>{
  admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA ${schema}`);
  pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,application_name:schema,max:16});store=new PgStore(pool);facts=new PgFactStore(pool);
  await migratePrivateStorage(pool,migration('001_private_storage.sql'));
  await Promise.all([migrateFactsStorage(pool,migration('003_fact_reviews.sql')),migrateFactsStorage(pool,migration('003_fact_reviews.sql'))]);
  api=new FactReviewService({auth:{resolveSession:async token=>{if(typeof token!=='string')return null;const session=await store.getSession(hash(token));return session?{userId:session.userId}:null;}},facts});
 });
 after(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}});
 async function owner({relationships=false}={}){
  const user=await store.upsertGoogleUser({googleSubject:randomUUID(),displayName:'1'});
  const scopeId=(await store.listPrivateScopes(user.userId))[0].id,sourceId=randomUUID();
  const token=randomBytes(32).toString('base64url'),sessionHash=hash(token);
  await store.putSession({tokenHash:sessionHash,userId:user.userId,createdAt:Date.now()-1000,expiresAt:Date.now()+60000,revokedAt:null});
  await store.provisionSource({actorUserId:user.userId,scopeId,expectedGraphVersion:'0',source:{id:sourceId,provider:'GOOGLE_CONTACTS',label:'1',origin:'AUTHORIZED_API',importedAt:now},policyVersion:'private-v1',verifiedOwnerIdentity:{platform:'google',externalId:'1'}});
  const scope=await store.authorizePrivateScope(user.userId,scopeId),g=await store.readSnapshot(scope);
  const context={sourceId,ownerUserId:user.userId,scopeId,batchId:randomUUID(),sourcePolicyVersion:'private-v1',sharingDecisionId:null};
  const evidence=['IDENTITY','RELATIONSHIP','AFFILIATION'].map((claimKind,i)=>({id:`e${i}`,sourceId,summary:String(i),observedAt:now,confidence:0.8,claimKind}));
  const envelope={context,batch:{schemaVersion:1,sourceId,batchId:context.batchId,
   people:[{tempId:'t1',displayName:'2',identities:[{platform:'google',externalId:'2'}],evidenceIds:['e0']}],
   relationships:relationships?[{tempId:'r1',fromRef:g.rootPersonId,toRef:'t1',kind:'FRIEND',strengthEstimate:0.8,confidence:0.8,evidenceIds:['e1']}]:[],
   observedLinks:[{fromRef:g.rootPersonId,toRef:'t1',kind:'CONTACT_SAVED',evidenceIds:['e1']}],
   affiliations:[{personRef:'t1',organizationName:'3',current:null,evidenceIds:['e2']}],evidence,warnings:[]},
   records:[{id:'record1',sourceId,ownerUserId:user.userId,externalRecordId:'2',retrievedAt:now,contentDigest:hash('2'),privatePayloadRef:'private1'}],
   evidenceRecords:evidence.map(e=>({evidenceId:e.id,sourceRecordId:'record1'})),
   facts:[{factKey:'o1',sourceRecordId:'record1',kind:'OBSERVED_LINK',candidateIndex:0,fromIdentity:{platform:'google',externalId:'1'},toIdentity:{platform:'google',externalId:'2'}},
    {factKey:'a1',sourceRecordId:'record1',kind:'AFFILIATION',candidateIndex:0,personIdentity:{platform:'google',externalId:'2'}},
    ...(relationships?[{factKey:'r1',sourceRecordId:'record1',kind:'RELATIONSHIP',candidateIndex:0,fromIdentity:{platform:'google',externalId:'1'},toIdentity:{platform:'google',externalId:'2'}}]:[])]};
  const job=await store.stage({actorUserId:user.userId,context,expectedGraphVersion:'1',payloadDigest:factDigest(envelope),envelope});
  await store.approveImportObservations({actorUserId:user.userId,scopeId,jobId:job.jobId,expectedGraphVersion:'1',idempotencyKey:'approve',personAssignments:[{tempId:'t1',personId:null}]});
  return {user,token,sessionHash,scopeId,sourceId,scope,context,envelope};
 }
 const graph=a=>store.readSnapshot(a.scope);
 const request=(a,change,version='2',key=randomUUID())=>({scopeId:a.scopeId,expectedGraphVersion:version,idempotencyKey:key,confirm:true,change});
 const confirmation={kind:'FRIEND',strength:0.6,statement:'2',includeInSearch:true};
 const relation=(g,overrides={})=>({type:'RELATIONSHIP_FROM_OBSERVATION',observedLinkId:g.observedLinks[0].id,decision:'ACCEPT',confirmation:{...confirmation,...overrides}});
 const affiliation=(g,current=true)=>{const p=g.people.find(p=>p.id!==g.rootPersonId);return {type:'AFFILIATION',personId:p.id,affiliationKey:affiliationKey(p.id,p.affiliations[0]),decision:'ACCEPT',current,statement:'3'};};
 const targetGoal=g=>({id:'goal',text:'3',organizationIds:[g.organizations[0].id],roles:['internship'],industries:[],locations:[],unsupportedConstraints:[]});
 const count=async a=>(await pool.query('SELECT count(*) FROM fact_decisions WHERE owner_user_id=$1',[a.user.userId])).rows[0].count;
 async function waitForLock(queryPart){
  for(let i=0;i<150;i++){
   const rows=(await admin.query("SELECT query FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",[schema])).rows;
   if(rows.some(r=>r.query.includes(queryPart)))return;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('expected database lock wait');
 }
 it('migrates once under concurrent startup and leaves Contacts observations unsearchable',async()=>{
  assert.equal((await pool.query("SELECT count(*) FROM app_migrations WHERE id='003_fact_reviews'")).rows[0].count,'1');
  const a=await owner(),g=await graph(a);assert.equal(g.relationships.length,0);assert.equal(g.searchEdges.length,0);
  assert.equal(g.people[1].affiliations[0].support.state,'PENDING');assert.deepEqual(resolveEvidenceBackedTargets(g,targetGoal(g)),[]);
  const review=await api.review(a.token,{scopeId:a.scopeId});assert.equal(review.affiliations.length,1);assert.equal(review.affiliations[0].claim.current,null);
  assert.equal(JSON.stringify(review).includes('private1'),false);assert.equal(JSON.stringify(review).includes(a.sessionHash),false);
 });
 it('explicit relationship and current-affiliation decisions produce one directed route and honest uncertainty',async()=>{
  const a=await owner(),before=await graph(a),r=request(a,relation(before));
  const result=await api.confirm(a.token,r),middle=await graph(a);
  assert.equal(result.graphVersion,'3');assert.equal(middle.searchEdges.length,1);assert.deepEqual(resolveEvidenceBackedTargets(middle,targetGoal(middle)),[]);
  await api.confirm(a.token,request(a,affiliation(middle),'3'));const g=await graph(a);
  assert.equal(g.people.length,2);assert.deepEqual(g.identities,before.identities);assert.deepEqual(g.observedLinks,before.observedLinks);
  assert.equal(g.searchEdges[0].fromPersonId,g.rootPersonId);assert.equal(g.searchEdges[0].toPersonId,g.people[1].id);
  assert.equal(g.sources.at(-1).provider,'MANUAL');assert.ok(g.evidence.at(-1).summary.startsWith('Owner self-attestation'));
  for(const event of result.events)validateGraphBuildEvent(event,{jobId:result.decisionId,scopeId:a.scopeId,afterSeq:-1,before,after:middle,candidateIds:new Set(),proposalIds:new Set()});
  const auth={resolveSession:async()=>({userId:a.user.userId})};
  const backend=new BackendService({auth,reads:store,goals:new EvidenceBackedGoalResolver(),engine:withFactWarnings(new BoundedRouteSearch())});
  const found=await backend.search(a.token,{scopeId:a.scopeId,expectedGraphVersion:g.graphVersion,goalText:'3'});
  assert.equal(found.paths.length,1);assert.deepEqual(found.paths[0].personIds,[g.rootPersonId,g.people[1].id]);assert.equal(found.paths[0].score.value,0.6);
  assert.ok(found.paths[0].explanation.uncertainties.some(s=>s.includes('not been independently verified')));
  assert.ok(found.warnings.some(s=>s.includes('Willingness')));
  const target=resolveEvidenceBackedTargets(g,targetGoal(g))[0];assert.equal(target.criteria.find(c=>c.name==='role:internship').status,'UNKNOWN');
  const retry=await api.confirm(a.token,r);assert.equal(retry.duplicate,true);assert.equal(retry.decisionId,result.decisionId);assert.equal(retry.graphVersion,'3');assert.equal((await graph(a)).graphVersion,'4');
  await rejectsCode(()=>api.confirm(a.token,{...r,change:relation(before,{strength:0.9})}),'VERSION_CONFLICT');
  assert.equal(await count(a),'2');
 });
 it('confirmation without search inclusion, UNKNOWN relationships, zero strength and unknown/former employment remain unsearchable',async()=>{
  for(const patch of [{includeInSearch:false},{kind:'UNKNOWN'},{strength:0}]){
   const a=await owner(),g=await graph(a);await api.confirm(a.token,request(a,relation(g,patch)));assert.equal((await graph(a)).searchEdges.length,0);
  }
  for(const current of [null,false]){
   const a=await owner(),g=await graph(a);await api.confirm(a.token,request(a,affiliation(g,current)));const after=await graph(a);
   assert.equal(after.people[1].affiliations[0].support.state,'CONFIRMED');assert.equal(after.people[1].affiliations[0].current,current);assert.deepEqual(resolveEvidenceBackedTargets(after,targetGoal(after)),[]);assert.equal(after.relationships.length,0);
  }
 });
 it('reviews existing relationships; rejection removes edges and employment correction removes targets without erasing provenance',async()=>{
  const a=await owner({relationships:true}),g=await graph(a),relationshipId=g.relationships[0].id;
  await api.confirm(a.token,request(a,{type:'RELATIONSHIP',relationshipId,decision:'ACCEPT',confirmation}));
  const middle=await graph(a);await api.confirm(a.token,request(a,affiliation(middle),'3'));
  const complete=await graph(a);assert.equal(resolveEvidenceBackedTargets(complete,targetGoal(complete)).length,1);
  const reject=await api.confirm(a.token,request(a,{type:'RELATIONSHIP',relationshipId,decision:'REJECT'},'4'));
  assert.deepEqual(reject.events[0].removedEdgeIds,[complete.searchEdges[0].id]);const rejected=await graph(a);assert.equal(rejected.relationships[0].state,'REJECTED');assert.equal(rejected.searchEdges.length,0);
  await api.confirm(a.token,request(a,affiliation(rejected,false),'5'));const final=await graph(a);
  assert.deepEqual(resolveEvidenceBackedTargets(final,targetGoal(final)),[]);assert.deepEqual(final.observedLinks,g.observedLinks);
  assert.ok(g.evidence.every(e=>final.evidence.some(f=>f.id===e.id)));
  const ledger=(await pool.query('SELECT before_claim,after_claim,request FROM fact_decisions WHERE owner_user_id=$1 ORDER BY graph_version',[a.user.userId])).rows;
  assert.equal(ledger[0].before_claim.state,'PENDING');assert.equal(ledger[0].after_claim.state,'CONFIRMED');assert.equal(ledger[2].after_claim.state,'REJECTED');
 });
 it('strict validation, foreign scope/claim/person and stale selectors fail without mutation',async()=>{
  const a=await owner(),b=await owner(),g=await graph(a),foreign=await graph(b),r=request(a,relation(g));
  for(const changed of [{...r,confirm:false},{...r,actorUserId:b.user.userId},{...r,change:{...r.change,fromPersonId:foreign.rootPersonId}},{...r,change:relation(g,{confidence:1})},{...r,change:relation(g,{strength:NaN})},{...r,change:relation(g,{statement:''})}])await assert.rejects(()=>api.confirm(a.token,changed));
  await rejectsCode(()=>api.confirm(null,r),'UNAUTHENTICATED');
  await rejectsCode(()=>api.confirm(b.token,r),'FORBIDDEN');
  await rejectsCode(()=>api.confirm(a.token,request(a,relation(foreign))),'FORBIDDEN');
  await rejectsCode(()=>api.confirm(a.token,request(a,{...affiliation(g),personId:foreign.people[1].id})),'FORBIDDEN');
  await rejectsCode(()=>api.confirm(a.token,request(a,{...affiliation(g),affiliationKey:'missing'})),'VERSION_CONFLICT');
  await rejectsCode(()=>api.confirm(a.token,{...r,expectedGraphVersion:'1'}),'VERSION_CONFLICT');
  assert.deepEqual(await graph(a),g);assert.equal(await count(a),'0');
 });
 it('source ownership/evidence kind checks and retry source-policy checks fail closed',async()=>{
  const a=await owner(),g=await graph(a),r=request(a,relation(g));await api.confirm(a.token,r);
  await pool.query('UPDATE private_sources SET policy_version=$1 WHERE id=$2',['changed',a.sourceId]);
  await rejectsCode(()=>api.confirm(a.token,r),'FORBIDDEN');
  await pool.query('UPDATE private_sources SET enabled=false WHERE id=$1',[a.sourceId]);
  await rejectsCode(()=>api.review(a.token,{scopeId:a.scopeId}),'FORBIDDEN');
  const b=await owner(),bg=await graph(b);bg.evidence.find(e=>e.id==='e2').claimKind='IDENTITY';
  await pool.query('UPDATE private_scopes SET snapshot=$1 WHERE id=$2',[bg,b.scopeId]);
  await rejectsCode(()=>api.confirm(b.token,request(b,affiliation(bg))),'FORBIDDEN');assert.equal(await count(b),'0');
 });
 it('concurrent exact retries commit once; conflicting new decisions cannot overwrite a version',async()=>{
  const a=await owner(),g=await graph(a),r=request(a,relation(g));const results=await Promise.all(Array.from({length:6},()=>api.confirm(a.token,r)));
  assert.equal(new Set(results.map(r=>r.decisionId)).size,1);assert.equal(results.filter(r=>!r.duplicate).length,1);assert.equal(await count(a),'1');
  const b=await owner(),bg=await graph(b);
  const outcomes=await Promise.allSettled([api.confirm(b.token,request(b,relation(bg))),api.confirm(b.token,request(b,affiliation(bg)))]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.find(r=>r.status==='rejected').reason.code,'VERSION_CONFLICT');assert.equal(await count(b),'1');
 });
 it('ledger failure rolls back snapshot, manual source, evidence and receipt atomically',async()=>{
  const a=await owner(),g=await graph(a);
  await pool.query("CREATE FUNCTION reject_fact_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.idempotency_key='rollback-test' THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$");
  await pool.query('CREATE TRIGGER reject_fact_test BEFORE INSERT ON fact_decisions FOR EACH ROW EXECUTE PROCEDURE reject_fact_test()');
  try{await assert.rejects(()=>api.confirm(a.token,request(a,relation(g),'2','rollback-test')));assert.deepEqual(await graph(a),g);assert.equal(await count(a),'0');assert.equal((await pool.query('SELECT count(*) FROM private_sources WHERE owner_user_id=$1',[a.user.userId])).rows[0].count,'1');}
  finally{await pool.query('DROP TRIGGER reject_fact_test ON fact_decisions');await pool.query('DROP FUNCTION reject_fact_test()');}
 });
 it('logout committed first rejects an in-flight confirmation; session mismatch and expiry reject too',async()=>{
  const a=await owner(),g=await graph(a),blocker=await pool.connect();
  try{
   await blocker.query('BEGIN');await blocker.query('UPDATE app_sessions SET revoked_at=$1 WHERE token_hash=$2',[Date.now(),a.sessionHash]);
   const pending=api.confirm(a.token,request(a,relation(g)));const rejection=rejectsCode(()=>pending,'UNAUTHENTICATED');await waitForLock('SELECT token_hash FROM app_sessions');await blocker.query('COMMIT');await rejection;
  }finally{blocker.release();}
  assert.deepEqual(await graph(a),g);assert.equal(await count(a),'0');
  const b=await owner(),bg=await graph(b);
  await rejectsCode(()=>facts.confirm({userId:a.user.userId,sessionHash:b.sessionHash},request(a,relation(g))),'UNAUTHENTICATED');
  await pool.query('UPDATE app_sessions SET expires_at=$1 WHERE token_hash=$2',[Date.now()-1,b.sessionHash]);
  await rejectsCode(()=>api.confirm(b.token,request(b,relation(bg))),'UNAUTHENTICATED');assert.deepEqual(await graph(b),bg);
 });
 it('fact confirmation locks session before scope, so later logout waits for commit',async()=>{
  const a=await owner(),g=await graph(a),blocker=await pool.connect();
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM private_scopes WHERE id=$1 FOR UPDATE',[a.scopeId]);
   const pending=api.confirm(a.token,request(a,relation(g)));await waitForLock('SELECT * FROM private_scopes');
   const logout=store.revokeSession(a.sessionHash,Date.now());await waitForLock('UPDATE app_sessions SET revoked_at');
   await blocker.query('COMMIT');assert.equal((await pending).graphVersion,'3');await logout;
  }finally{blocker.release();}
  assert.equal(await count(a),'1');assert.equal((await graph(a)).searchEdges.length,1);
 });
 it('session expiry while waiting for the scope rolls back all fact writes',async()=>{
  const a=await owner(),g=await graph(a),blocker=await pool.connect();
  await pool.query('UPDATE app_sessions SET expires_at=$1 WHERE token_hash=$2',[Date.now()+350,a.sessionHash]);
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM private_scopes WHERE id=$1 FOR UPDATE',[a.scopeId]);
   const pending=api.confirm(a.token,request(a,relation(g)));const rejection=rejectsCode(()=>pending,'UNAUTHENTICATED');await waitForLock('SELECT * FROM private_scopes');
   await new Promise(resolve=>setTimeout(resolve,400));await blocker.query('COMMIT');await rejection;
  }finally{blocker.release();}
  assert.deepEqual(await graph(a),g);assert.equal(await count(a),'0');
 });
 it('projection loses edges when supporting source or observation disappears, and reimports retain reviewed decisions',async()=>{
  const a=await owner(),g=await graph(a);await api.confirm(a.token,request(a,relation(g)));const middle=await graph(a);await api.confirm(a.token,request(a,affiliation(middle,false),'3'));const reviewed=await graph(a);
  const included=new Set(reviewed.relationships.map(r=>r.id));
  assert.deepEqual(projectConfirmedRelationships({...reviewed,sources:reviewed.sources.filter(s=>s.id!==a.sourceId)},included),[]);
  assert.deepEqual(projectConfirmedRelationships({...reviewed,observedLinks:[]},included),[]);
  const envelope=structuredClone(a.envelope);envelope.context.batchId=randomUUID();envelope.batch.batchId=envelope.context.batchId;
  envelope.batch.people[0].existingPersonId=reviewed.people[1].id;
  const remap=new Map(envelope.batch.evidence.map(e=>[e.id,randomUUID()]));
  envelope.batch.evidence.forEach(e=>{e.id=remap.get(e.id);});envelope.batch.people[0].evidenceIds=envelope.batch.people[0].evidenceIds.map(id=>remap.get(id));
  envelope.batch.observedLinks[0].evidenceIds=envelope.batch.observedLinks[0].evidenceIds.map(id=>remap.get(id));envelope.batch.affiliations[0].evidenceIds=envelope.batch.affiliations[0].evidenceIds.map(id=>remap.get(id));envelope.evidenceRecords.forEach(e=>{e.evidenceId=remap.get(e.evidenceId);});
  const job=await store.stage({actorUserId:a.user.userId,context:envelope.context,expectedGraphVersion:'4',payloadDigest:factDigest(envelope),envelope});
  await store.approveImportObservations({actorUserId:a.user.userId,scopeId:a.scopeId,jobId:job.jobId,expectedGraphVersion:'4',idempotencyKey:'reimport',personAssignments:[{tempId:'t1',personId:reviewed.people[1].id}]});
  const after=await graph(a);assert.deepEqual(after.relationships,reviewed.relationships);assert.deepEqual(after.searchEdges,reviewed.searchEdges);
  assert.ok(after.people[1].affiliations.some(a=>a.current===false&&a.support.state==='CONFIRMED'));assert.deepEqual(resolveEvidenceBackedTargets(after,targetGoal(after)),[]);
 });
});
