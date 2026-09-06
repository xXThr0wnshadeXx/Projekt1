import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {createApplication} from '../dist/packages/server/application.js';

const origin='http://127.0.0.1',token='a'.repeat(43),request={scopeId:'scope',expectedGraphVersion:'0',idempotencyKey:'key',confirm:true,decisions:[{sourceId:'source',proposalId:'proposal',proposalRevision:'revision',decision:'REJECT'}]};
function policy(){return{version:'test-policy-v1',semantics:{strength:'test',confidence:'test',recency:'test'},assess:()=>({strength:1,confidence:1,recencyFactor:1,warnings:['test policy']})};}
function storage(calls){return{store:{getSession:async()=>({userId:'user',createdAt:0,expiresAt:Date.now()+60000,revokedAt:null}),getUser:async()=>({userId:'user',displayName:'Test'}),listPrivateScopes:async()=>[],putOAuthTransaction:async()=>{},consumeOAuthTransaction:async()=>null,upsertGoogleUser:async()=>({userId:'user'}),putSession:async()=>{},revokeSession:async()=>{}},publicClaims:{review:async(credential,input)=>{calls.push({credential,input});return{scopeId:input.scopeId,reviewId:'review',graphVersion:'1',decisions:[],events:[],warnings:[]};}},migrate:async()=>{},probe:async()=>true,close:async()=>{}};}
test('application mounts authenticated public claim confirmation with server-injected policy',async t=>{
 const calls=[],injected=policy(),app=await createApplication({env:{APP_ORIGIN:origin,GOOGLE_CLIENT_ID:'test.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'test-only',DATABASE_URL:'unused'},publicCitationPolicy:injected,openStorage:async(_url,options)=>{assert.equal(options.publicCitationPolicy,injected);return storage(calls);}});t.after(()=>app.close());
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const base=`http://127.0.0.1:${app.server.address().port}`;
 const headers={cookie:`projekt1_session=${token}`,origin,'content-type':'application/json'};
 assert.equal((await fetch(base+'/api/public-facts/confirm',{method:'POST',headers,body:JSON.stringify(request)})).status,200);assert.equal(calls.length,1);assert.deepEqual(calls[0].input,request);
 assert.equal((await fetch(base+'/api/public-facts/confirm',{method:'POST',headers:{...headers,origin:'https://other.example'},body:JSON.stringify(request)})).status,403);
 assert.equal((await fetch(base+'/api/public-facts/confirm',{method:'POST',headers,body:JSON.stringify({...request,decisions:[]})})).status,400);
 assert.equal((await fetch(base+'/api/public-facts/confirm',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(request)})).status,401);assert.equal(calls.length,1);
});
