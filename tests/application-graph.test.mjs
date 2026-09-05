import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {Pool} from 'pg';
import {createApplication,openPostgresStorage} from '../dist/packages/server/application.js';
import {EvidenceBackedGoalResolver,BoundedRouteSearch} from '../dist/packages/graph/src/index.js';

test('real PostgreSQL session flows through HTTP to actual goal resolver and graph engine', {skip:!process.env.STORAGE_TEST_DATABASE_URL},async()=>{
 const schema='graph_composition_'+randomUUID().replaceAll('-','');
 const admin=new Pool({connectionString:process.env.STORAGE_TEST_DATABASE_URL});let app,db;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url=new URL(process.env.STORAGE_TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);
  app=await createApplication({env:{DATABASE_URL:url.href,APP_ORIGIN:'https://app.example',GOOGLE_CLIENT_ID:'test.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'test-only'},openStorage:async connection=>{db=await openPostgresStorage(connection);return db;},search:{goals:new EvidenceBackedGoalResolver(),engine:new BoundedRouteSearch()}});
  // Structural test account/session in a disposable schema; never a product login fallback.
  const user=await db.store.upsertGoogleUser({googleSubject:randomUUID(),displayName:'u0'});
  const scope=(await db.store.listPrivateScopes(user.userId))[0];
  const token='a'.repeat(43),now=Date.now();
  await db.store.putSession({tokenHash:createHash('sha256').update(token).digest('hex'),userId:user.userId,createdAt:now,expiresAt:now+60000,revokedAt:null});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://127.0.0.1:${app.server.address().port}`,headers={cookie:`projekt1_session=${token}`};
  const graphResponse=await fetch(`${base}/api/graph?scopeId=${scope.id}`,{headers});assert.equal(graphResponse.status,200);const graph=await graphResponse.json();assert.equal(graph.people.length,1);
  const response=await fetch(base+'/api/search',{method:'POST',headers:{...headers,origin:'https://app.example','content-type':'application/json'},body:JSON.stringify({scopeId:scope.id,expectedGraphVersion:graph.graphVersion,goalText:'unknown0'})});
  assert.equal(response.status,200);const result=await response.json();assert.deepEqual(result.paths,[]);assert.deepEqual(result.targets,[]);assert.equal(result.stats.stop,'NO_TARGETS');assert.equal(result.events[0].seq,0);assert.equal(result.events.at(-1).type,'SEARCH_COMPLETED');
  const sourcesResponse=await fetch(`${base}/api/sources?scopeId=${scope.id}`,{headers});assert.equal(sourcesResponse.status,200);assert.deepEqual((await sourcesResponse.json()).sources,[]);
  assert.equal(app.configured.retrieval,false);
  const importResponse=await fetch(base+'/api/imports/google',{method:'POST',headers:{...headers,origin:'https://app.example','content-type':'application/json'},body:JSON.stringify({scopeId:scope.id,sourceId:'unavailable0',expectedGraphVersion:graph.graphVersion,idempotencyKey:'k0'})});assert.equal(importResponse.status,502);
  assert.equal(app.configured.search,true);assert.equal(await app.readiness(new AbortController().signal),true);
  const unauth=await fetch(base+'/api/search',{method:'POST',headers:{origin:'https://app.example','content-type':'application/json'},body:JSON.stringify({scopeId:scope.id,expectedGraphVersion:graph.graphVersion,goalText:'unknown0'})});assert.equal(unauth.status,401);
 }finally{await app?.close();if(!app)await db?.close();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
