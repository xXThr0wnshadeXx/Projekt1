import test from 'node:test';
import assert from 'node:assert/strict';
import {handleAPI} from '../server/api.js';
const base='https://orbit-network-mapper.doublejav.chatgpt.site';
test('private library APIs reject anonymous reads and cross-origin writes',async()=>{
  assert.equal((await handleAPI(new Request(base+'/api/library/stats'),{DB:{}})).status,401);
  const r=await handleAPI(new Request(base+'/api/library/ingest',{method:'POST',headers:{'oai-authenticated-user-id':'owner',Origin:'https://other.example','Content-Type':'application/json'},body:'{"nodes":[],"edges":[]}'}),{DB:{}});assert.equal(r.status,403);
});
test('API rejects oversized bodies before parsing or writing',async()=>{
  const r=await handleAPI(new Request(base+'/api/library/ingest',{method:'POST',headers:{'oai-authenticated-user-id':'owner',Origin:base,'Content-Type':'application/json'},body:'x'.repeat(500001)}),{DB:{}});assert.equal(r.status,413);
});
