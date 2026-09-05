import test from 'node:test';
import assert from 'node:assert/strict';
import {createGoogleContactsRetriever,GoogleContactsRetrievalError,GOOGLE_CONTACTS_LIMITS} from '../../dist/retrieval/packages/ingestion/googleContactsRetriever.js';
const input={accessToken:'anonymous-token',sourceId:'source-unit',batchId:'batch-unit',ownerPersonId:'owner-unit',retrievedAt:'2026-09-05T12:00:00.000Z'};
const row=id=>({resourceName:`people/${id}`,names:[{displayName:`Unit ${id}`}]});
const json=(body,status=200)=>new Response(JSON.stringify(body),{status});
const rejects=(promise,reason)=>assert.rejects(promise,e=>e instanceof GoogleContactsRetrievalError && e.reason===reason && !JSON.stringify(e).includes('anonymous-token') && !e.message.includes('private-provider-detail') && !('cause' in e));
function pages(responses,limits){let calls=0;return {run:createGoogleContactsRetriever({limits,fetch:async()=>responses[calls++]}),calls:()=>calls};}

test('multipage uses fixed endpoint/mask, encoded cursor, bearer header and redirect refusal',async()=>{
 const seen=[];const run=createGoogleContactsRetriever({fetch:async(url,options)=>{
  seen.push(new URL(url));assert.equal(options.headers.Authorization,'Bearer anonymous-token');assert.equal(options.redirect,'error');assert.equal(options.method,'GET');assert.ok(options.signal);
  return seen.length===1?json({connections:[{...row('a'),organizations:[{name:'Unit Org',current:true},{name:'Prior Org',current:false},{name:'Unknown Org'}]}],nextPageToken:'opaque/&=cursor',totalItems:2}):json({connections:[row('a'),row('b')],totalItems:2});
 }});
 const batch=await run(input);assert.equal(batch.people.length,2);assert.equal(batch.observedLinks.length,2);assert.deepEqual(batch.relationships,[]);assert.deepEqual(batch.affiliations.map(a=>a.current),[true,false,null]);
 assert.ok(batch.warnings.includes('GOOGLE_CONTACTS_DUPLICATE_RESOURCE_SKIPPED'));assert.ok(batch.evidence.every(e=>e.sourceId===input.sourceId&&e.observedAt===input.retrievedAt));
 assert.equal(seen[1].searchParams.get('pageToken'),'opaque/&=cursor');
 for(const url of seen){assert.equal(url.origin,'https://people.googleapis.com');assert.equal(url.pathname,'/v1/people/me/connections');assert.equal(url.searchParams.get('personFields'),'names,organizations');assert.equal(url.searchParams.get('sources'),'READ_SOURCE_TYPE_CONTACT');assert.equal(url.searchParams.get('pageSize'),'1000');assert.ok(!url.href.includes(input.accessToken));url.searchParams.delete('pageToken');}
 assert.equal(seen[0].href,seen[1].href);
});
test('empty protobuf JSON is valid; missing optional name/organization stays unknown',async()=>{
 assert.equal((await pages([json({})]).run(input)).people.length,0);
 const b=await pages([json({connections:[{resourceName:'people/a'}]})]).run(input);
 assert.equal(b.people.length,1);assert.match(b.people[0].displayName,/^source:handle-/);assert.deepEqual(b.affiliations,[]);
});
test('same resource on later pages keeps first supplied record, never fuzzy merges distinct resources',async()=>{
 const b=await pages([json({connections:[row('a')],nextPageToken:'next'}),json({connections:[{...row('a'),names:[{displayName:'Changed'}]}, {...row('b'),names:row('a').names}]})]).run(input);
 assert.equal(b.people.length,2);assert.equal(b.people[0].displayName,'Unit a');assert.notEqual(b.people[0].tempId,b.people[1].tempId);
});
for(const [status,reason] of [[401,'AUTH_REQUIRED'],[403,'SCOPE_DENIED'],[429,'RATE_LIMITED'],[500,'PROVIDER_UNAVAILABLE'],[503,'PROVIDER_UNAVAILABLE'],[302,'PROVIDER_UNAVAILABLE']]) {
 test(`HTTP ${status} is sanitized and never returns first-page data`,async()=>{
  await rejects(pages([json({connections:[row('a')],nextPageToken:'next'}),json({error:'private-provider-detail anonymous-token'},status)]).run(input),reason);
 });
}
test('network/redirect rejection is sanitized with no retry',async()=>{
 let calls=0;const run=createGoogleContactsRetriever({fetch:async()=>{calls++;throw new Error('private-provider-detail anonymous-token');}});
 await rejects(run(input),'PROVIDER_UNAVAILABLE');assert.equal(calls,1);
});
test('malformed JSON, invalid page shape or missing stable resource fails whole batch',async()=>{
 for(const response of [new Response('{'),json(null),json([]),json({connections:{}}),json({connections:[null]}),json({connections:[{}]}),json({connections:[{resourceName:'private-invalid'}]})]) await rejects(pages([response]).run(input),'INVALID_RESPONSE');
});
test('invalid cursor and repeated cursor cycles reject',async()=>{
 for(const token of ['',null,42,'x'.repeat(8193)]) await rejects(pages([json({nextPageToken:token})]).run(input),'INVALID_RESPONSE');
 const p=pages([json({nextPageToken:'a'}),json({nextPageToken:'b'}),json({nextPageToken:'a'})]);await rejects(p.run(input),'INVALID_RESPONSE');assert.equal(p.calls(),3);
});
test('page and raw-record bounds fail instead of truncating',async()=>{
 const p=pages([json({nextPageToken:'next'})],{maxPages:1});await rejects(p.run(input),'LIMIT_EXCEEDED');assert.equal(p.calls(),1);
 await rejects(pages([json({connections:[row('a'),row('a')]})],{maxRecords:1}).run(input),'LIMIT_EXCEEDED');
 await rejects(pages([json({connections:[row('a'),row('b')]})],{pageSize:1}).run(input),'LIMIT_EXCEEDED');
});
test('declared, streamed and aggregate byte limits reject; stream cancellation occurs',async()=>{
 await rejects(pages([new Response('{}',{headers:{'content-length':'999'}})],{maxPageBytes:10}).run(input),'LIMIT_EXCEEDED');
 let canceled=false;const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(30));},cancel(){canceled=true;}});
 await rejects(pages([new Response(stream)],{maxPageBytes:10}).run(input),'LIMIT_EXCEEDED');assert.ok(canceled);
 const page={nextPageToken:'next'};const n=JSON.stringify(page).length;
 await rejects(pages([json(page),json({})],{maxTotalBytes:n+1}).run(input),'LIMIT_EXCEEDED');
});
test('totalItems mismatch/change/oversize and malformed normalized output fail',async()=>{
 for(const response of [json({totalItems:1}),json({totalItems:-1}),json({totalItems:'1'}),json({connections:[row('a')],totalItems:0}),json({connections:[{...row('a'),names:[{displayName:'x'.repeat(9000)}]}]})]) await rejects(pages([response]).run(input),'INVALID_RESPONSE');
 await rejects(pages([json({totalItems:10001})]).run(input),'LIMIT_EXCEEDED');
 await rejects(pages([json({totalItems:1,nextPageToken:'next'}),json({totalItems:2})]).run(input),'INVALID_RESPONSE');
});
test('per-request timeout bounds transport that ignores AbortSignal',async()=>{
 let signal;const run=createGoogleContactsRetriever({limits:{requestTimeoutMs:10},fetch:(_u,o)=>{signal=o.signal;return new Promise(()=>{});}});
 await rejects(run(input),'TIMEOUT');assert.ok(signal.aborted);
});
test('deadline includes stalled body and aggregate pagination time',async()=>{
 await rejects(pages([new Response(new ReadableStream({start(){}}))],{requestTimeoutMs:10}).run(input),'TIMEOUT');
 let n=0;const run=createGoogleContactsRetriever({limits:{totalTimeoutMs:15,requestTimeoutMs:100},fetch:async()=>{await new Promise(r=>setTimeout(r,10));return json({nextPageToken:String(++n)});}});
 await rejects(run(input),'TIMEOUT');
});
test('caller cancellation before and during retrieval',async()=>{
 const c=new AbortController();c.abort();let calls=0;const run=createGoogleContactsRetriever({fetch:async()=>{calls++;return json({});}});
 await rejects(run({...input,signal:c.signal}),'ABORTED');assert.equal(calls,0);
 const d=new AbortController();const waiting=createGoogleContactsRetriever({fetch:async()=>{d.abort();return new Promise(()=>{});}});
 await rejects(waiting({...input,signal:d.signal}),'ABORTED');
});
test('invalid context is rejected before transport and hard limits cannot be raised',async()=>{
 let calls=0;const run=createGoogleContactsRetriever({fetch:async()=>{calls++;return json({});}});
 for(const change of [{sourceId:'bad/id'},{retrievedAt:'2026-02-30T00:00:00Z'},{accessToken:'bad\r\nheader'}]) await rejects(run({...input,...change}),'INVALID_CONTEXT');
 assert.equal(calls,0);assert.throws(()=>createGoogleContactsRetriever({limits:{maxPages:GOOGLE_CONTACTS_LIMITS.maxPages+1}}));
});
