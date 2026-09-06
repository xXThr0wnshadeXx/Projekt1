import test from 'node:test';
import assert from 'node:assert/strict';
import {handleAPI} from '../server/api.js';
const base='https://orbit-shreev2703-graph-test.shreev2703.chatgpt.site';
test('private library APIs reject anonymous reads and cross-origin writes',async()=>{
  assert.equal((await handleAPI(new Request(base+'/api/library/stats'),{DB:{}})).status,401);
  assert.equal((await handleAPI(new Request(base+'/api/library/stats'),{DB:{},SHARED_OWNER:'shared'})).status,401);
  const r=await handleAPI(new Request(base+'/api/library/ingest',{method:'POST',headers:{'oai-authenticated-user-id':'owner',Origin:'https://other.example','Content-Type':'application/json'},body:'{"nodes":[],"edges":[]}'}),{DB:{}});assert.equal(r.status,403);
});
test('API rejects oversized bodies before parsing or writing',async()=>{
  const r=await handleAPI(new Request(base+'/api/library/ingest',{method:'POST',headers:{'oai-authenticated-user-id':'owner',Origin:base,'Content-Type':'application/json'},body:'x'.repeat(500001)}),{DB:{}});assert.equal(r.status,413);
});

test('session uses trusted identity, works without a database, and is never cached',async()=>{
  const anonymous=await handleAPI(new Request(base+'/api/session'),{});
  assert.deepEqual(await anonymous.json(),{authenticated:false});
  assert.equal(anonymous.headers.get('Cache-Control'),'no-store');
  const signedIn=await handleAPI(new Request(base+'/api/session',{headers:{'oai-authenticated-user-id':'alice','oai-authenticated-user-email':'alice@example.com'}}),{});
  assert.deepEqual(await signedIn.json(),{authenticated:true,id:'alice',email:'alice@example.com'});
});
