import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID,randomBytes,createHash} from 'node:crypto';import {once} from 'node:events';import {Pool} from 'pg';
import {createApplication,openPostgresStorage} from '../dist/packages/server/application.js';import {publicStage,publicTime} from './public-facts-fixture.mjs';
const url=process.env.STORAGE_TEST_DATABASE_URL;if(url){const u=new URL(url);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'55439');assert.equal(u.username,'projekt1_test');assert.equal(u.pathname,'/postgres');}
test('combined public source provisioning, private stage and authenticated HTTP identity review/resolve',{skip:!url},async()=>{
 const schema='public_app_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url});let app,db;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);const connection=new URL(url);connection.searchParams.set('options',`-c search_path=${schema}`);
  app=await createApplication({env:{DATABASE_URL:connection.href,APP_ORIGIN:'https://app.example',GOOGLE_CLIENT_ID:'unit.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'unit-only'},openStorage:async u=>{db=await openPostgresStorage(u);return db;}});
  const user=await db.store.upsertGoogleUser({googleSubject:randomUUID(),displayName:'Unit Owner'}),scopeId=(await db.store.listPrivateScopes(user.userId))[0].id;
  const token=randomBytes(32).toString('base64url'),actor={userId:user.userId,sessionHash:createHash('sha256').update(token).digest('hex')};
  await db.store.putSession({tokenHash:actor.sessionHash,userId:user.userId,createdAt:Date.now()-1000,expiresAt:Date.now()+60000,revokedAt:null});
  const source=await app.publicSources.provision(actor,{scopeId,expectedGraphVersion:'0',document:{url:'https://example.org/article',kind:'PUBLIC_ARTICLE',title:'Public unit article',retrievedAt:publicTime}});
  const input=publicStage({userId:user.userId,scopeId,sourceId:source.sourceId,expectedGraphVersion:source.graphVersion});const staged=await app.publicFacts.stage(token,input);assert.equal(staged.graphVersion,'2');
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://127.0.0.1:${app.server.address().port}`,headers={cookie:`projekt1_session=${token}`};
  const post=(path,body,h={})=>fetch(base+path,{method:'POST',headers:{...headers,origin:'https://app.example','content-type':'application/json',...h},body:JSON.stringify(body)});
  const r=await fetch(base+`/api/public-facts/review?scopeId=${scopeId}&batchId=${staged.batchId}`,{headers});assert.equal(r.status,200);const review=await r.json();assert.equal(review.endpoints.length,2);assert.ok(!JSON.stringify(review).includes('privatePayloadRef'));assert.ok(!JSON.stringify(review).includes('normalizedText'));assert.ok(!JSON.stringify(review).includes(actor.sessionHash));
  const endpoint=review.endpoints[0],decision={scopeId,expectedGraphVersion:review.graphVersion,idempotencyKey:'resolve1',confirm:true,endpointId:endpoint.endpointId,expectedEndpointRevision:endpoint.endpointRevision,expectedResolutionDecisionId:endpoint.latestResolutionDecisionId,disposition:'NEW_PERSON'};
  assert.equal((await post('/api/public-facts/resolve',decision,{cookie:''})).status,401);assert.equal((await post('/api/public-facts/resolve',decision,{origin:'https://other.example'})).status,403);
  assert.equal((await post('/api/public-facts/resolve',{...decision,personId:'forged'})).status,400);assert.equal((await post('/api/public-facts/resolve',{...decision,confirm:false})).status,400);
  let resolved=await post('/api/public-facts/resolve',decision);assert.equal(resolved.status,200);const receipt=await resolved.json();assert.equal(receipt.events[0].type,'BATCH_COMMITTED');
  resolved=await post('/api/public-facts/resolve',decision);assert.equal(resolved.status,200);assert.equal((await resolved.json()).duplicate,true);
  assert.equal((await post('/api/public-facts/resolve',{...decision,idempotencyKey:'stale'})).status,409);
  assert.equal((await post('/api/public-facts/stage',input)).status,404);
  const graph=await db.store.readSnapshot(await db.store.authorizePrivateScope(user.userId,scopeId));assert.equal(graph.people.length,2);assert.deepEqual(graph.relationships,[]);assert.deepEqual(graph.searchEdges,[]);
  const updated=await app.publicFacts.review(token,{scopeId,batchId:staged.batchId});assert.ok(updated.proposals.every(p=>p.reviewState==='PENDING'&&!p.includeInSearch));
 }finally{await app?.close();if(!app)await db?.close();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
