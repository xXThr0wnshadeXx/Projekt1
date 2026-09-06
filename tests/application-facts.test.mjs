import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID,randomBytes,createHash} from 'node:crypto';import {once} from 'node:events';import {Pool} from 'pg';
import {createApplication,openPostgresStorage} from '../dist/packages/server/application.js';
import {BoundedRouteSearch,EvidenceBackedGoalResolver} from '../dist/packages/graph/src/index.js';
import {factDigest} from '../dist/packages/server/facts/projection.js';
const url=process.env.STORAGE_TEST_DATABASE_URL;
if(url){const u=new URL(url);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'55439');assert.equal(u.username,'projekt1_test');assert.equal(u.pathname,'/postgres');}
const hash=v=>createHash('sha256').update(v).digest('hex'),now='2026-09-05T00:00:00.000Z';
test('combined application migrates, confirms facts over HTTP and returns qualified search paths',{skip:!url},async()=>{
 const schema='facts_app_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url});let app,db,store;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);const connection=new URL(url);connection.searchParams.set('options',`-c search_path=${schema}`);
  app=await createApplication({env:{DATABASE_URL:connection.href,APP_ORIGIN:'https://app.example',GOOGLE_CLIENT_ID:'unit.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'unit'},openStorage:async u=>{db=await openPostgresStorage(u);store=db.store;return db;},search:{goals:new EvidenceBackedGoalResolver(),engine:new BoundedRouteSearch()}});
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

  const a=await owner();app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://127.0.0.1:${app.server.address().port}`,headers={cookie:`projekt1_session=${a.token}`};
  const get=async path=>{const r=await fetch(base+path,{headers});assert.equal(r.status,200);return r.json();};
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{...headers,origin:'https://app.example','content-type':'application/json'},body:JSON.stringify(body)});
  let g=await get('/api/graph?scopeId='+a.scopeId);assert.equal(g.searchEdges.length,0);
  const request={scopeId:a.scopeId,expectedGraphVersion:g.graphVersion,idempotencyKey:'relation',confirm:true,change:{type:'RELATIONSHIP_FROM_OBSERVATION',observedLinkId:g.observedLinks[0].id,decision:'ACCEPT',confirmation:{kind:'FRIEND',strength:0.6,statement:'Anonymous unit assertion',includeInSearch:true}}};
  let r=await post('/api/facts/confirm',request);assert.equal(r.status,200);const receipt=await r.json();assert.equal(receipt.events[0].type,'BATCH_COMMITTED');
  r=await post('/api/facts/confirm',request);assert.equal(r.status,200);assert.equal((await r.json()).duplicate,true);
  r=await post('/api/facts/confirm',{...request,idempotencyKey:'stale'});assert.equal(r.status,409);
  const review=await get('/api/facts/review?scopeId='+a.scopeId);const selected=review.affiliations[0];
  r=await post('/api/facts/confirm',{scopeId:a.scopeId,expectedGraphVersion:review.graphVersion,idempotencyKey:'affiliation',confirm:true,change:{type:'AFFILIATION',personId:selected.personId,affiliationKey:selected.affiliationKey,decision:'ACCEPT',current:true,statement:'Anonymous unit currentness'}});assert.equal(r.status,200);
  g=await get('/api/graph?scopeId='+a.scopeId);r=await post('/api/search',{scopeId:a.scopeId,expectedGraphVersion:g.graphVersion,goalText:'3'});assert.equal(r.status,200);const result=await r.json();assert.equal(result.paths.length,1);assert.ok(result.paths[0].explanation.uncertainties.some(s=>s.includes('not been independently verified')));assert.ok(result.warnings.some(s=>s.includes('Willingness')));
  assert.equal((await fetch(base+'/api/facts/review?scopeId='+a.scopeId)).status,401);
  assert.equal((await fetch(base+'/api/facts/review?scopeId=foreign',{headers})).status,403);
  const ledger=await admin.query(`SELECT id FROM ${schema}.app_migrations ORDER BY id`);assert.deepEqual(ledger.rows.map(r=>r.id),['001_private_storage','002_contacts_grants','003_fact_reviews','004_public_fact_staging','005_discovery_receipts','006_public_claim_decisions','007_discovery_staging']);
 }finally{await app?.close();if(!app)await db?.close();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
