import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareImport} from '../src/import.js';

const a='https://www.linkedin.com/in/example-a/',b='https://www.linkedin.com/in/example-b/';
test('rich knowledge archives become graph data while every source record is preserved',async()=>{
  const data={format:'linkedin-knowledge-graph',schemaVersion:2,counts:{profiles:2},profiles:[{id:a,name:'A'},{id:b,name:'B'}],connections:[{source:a,target:b,kind:'linkedin_connection',directed:false,evidence:[{source:'https://www.linkedin.com/mynetwork/invite-connect/connections/',firstSeen:'2026-01-01T00:00:00Z',lastSeen:'2026-01-02T00:00:00Z'}]}],profileDetails:[{person:a,key:'skill',value:'SQLite',source:a,kind:'observed'}],commentObservations:[{commentId:'comment-1',commenter:b,author:a,post:'https://www.linkedin.com/feed/update/urn:li:activity:1/',firstSeen:'2026-01-01T00:00:00Z',lastSeen:'2026-01-02T00:00:00Z'}],sources:[a]};
  const prepared=await prepareImport(data,JSON.stringify(data),'archive.json');
  assert.equal(prepared.nodes.length,2);assert.equal(prepared.edges.length,1);assert.equal(prepared.edges[0].evidence[0].url,'https://www.linkedin.com/mynetwork/invite-connect/connections/');
  assert.equal(prepared.records.length,6);assert.deepEqual(new Set(prepared.records.map(record=>record.section)),new Set(['profiles','connections','profileDetails','commentObservations','sources']));
  assert.equal(prepared.imports[0].metadata.counts.profiles,2);assert.match(prepared.imports[0].id,/^[a-f0-9]{64}$/);
});

test('common aliases are recognized and unsupported links are reported, not silently lost',async()=>{
  const data={people:[{linkedinUrl:a,fullName:'A'}],relationships:[{from:a,to:b,evidence:[]}],extraRows:[{important:true}]};
  const prepared=await prepareImport(data,JSON.stringify(data));
  assert.equal(prepared.nodes.length,2);assert.equal(prepared.edges.length,0);assert.equal(prepared.skippedConnections,1);assert.equal(prepared.records.length,3);
});

test('standalone comments and older commenter-to-author exports become searchable graph links',async()=>{
  const comment={commenter:b,author:a,post:'https://www.linkedin.com/feed/update/urn:li:activity:123/',commentId:'urn:li:comment:(activity:123,456)',lastSeen:'2026-09-06T00:00:00Z'};
  const data={commentObservations:[comment]};const prepared=await prepareImport(data,JSON.stringify(data));
  assert.equal(prepared.nodes.length,2);assert.equal(prepared.edges.length,1);assert.equal(prepared.edges[0].directed,false);
  assert.equal(prepared.edges[0].evidence[0].type,'comment_interaction');assert.equal(prepared.edges[0].evidence[0].author,a);
  const old={nodes:[{id:a,name:'A'},{id:b,name:'B'}],edges:[{source:b,target:a,kind:'commented_on_post',evidence:[{post:comment.post,comment_id:comment.commentId,last_seen:comment.lastSeen}]}]};
  assert.equal((await prepareImport(old,JSON.stringify(old))).edges[0].evidence[0].commenter,b);
});

test('connection and comment sources for the same pair merge without making co-commenter links',async()=>{
  const c='https://www.linkedin.com/in/example-c/',post='https://www.linkedin.com/feed/update/urn:li:activity:123/';
  const data={profiles:[{id:a},{id:b},{id:c}],connections:[{source:a,target:b,evidence:[{url:'https://www.linkedin.com/mynetwork/invite-connect/connections/'}]}],commentObservations:[{commenter:b,author:a,post,commentId:'urn:li:comment:(activity:123,456)'},{commenter:c,author:a,post,commentId:'urn:li:comment:(activity:123,789)'}]};
  const p=await prepareImport(data,JSON.stringify(data));assert.equal(p.edges.length,2);assert.equal(p.edges.find(e=>e.id===[a,b].sort().join('|')).evidence.length,2);assert.ok(!p.edges.some(e=>e.id===[b,c].sort().join('|')));
});
