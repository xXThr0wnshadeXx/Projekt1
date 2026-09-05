import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createDiscoveryPlanner, canonicalPublicUrl, canonicalQuery, discoverExploratoryCandidates} from '../dist/packages/server/discovery/planning/index.js';
import {DiscoveryError} from '../dist/packages/server/discovery/contracts.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const profile = 'https://www.linkedin.com/in/u1/';
const request = {scopeId:'s0', expectedGraphVersion:'0', idempotencyKey:'k0',
  anchors:{linkedinUrl:'https://www.linkedin.com/in/u0/', instagramUrl:'https://www.instagram.com/u0/'},
  target:{organizationName:'o0'}};
const input = () => ({request:structuredClone(request), authority:{scopeId:'s0', graphVersion:'0', selectedContexts:[]}});
const hit = url => ({url, title:'public hint', snippet:'not citation evidence', provider:'TAVILY', evidenceStatus:'DISCOVERY_HINT'});
function document(url, text = `u1 identifies their profile as ${profile}`) {
  return {id:hash(url), revision:hash(text), sourceUrl:url, fetchedUrl:url, title:'source', publisher:null,
    publishedAt:null, retrievedAt:'2026-09-05T00:00:00.000Z', contentDigest:hash(text), digestBasis:'NORMALIZED_TEXT_SHA256',
    normalizedText:text, upstreamRevisionId:null, normalizationVersion:'public-source-text-v1', persistence:'NOT_PERSISTED', metadataStatus:'SOURCE_SUPPLIED_NOT_VERIFIED'};
}
function extracted(doc) {
  const citation = {id:`c-${doc.id}`, evidenceId:`e-${doc.id}`, documentId:doc.id, documentRevision:doc.revision, role:'IDENTITY',
    supportingExcerpt:doc.normalizedText, locator:{start:0,end:doc.normalizedText.length,section:null},statementId:null};
  const proposal = {id:`p-${doc.id}`,revision:doc.revision,factKey:`f-${doc.id}`,basis:'PUBLIC_SOURCE_CITATION',kind:'IDENTITY',
    subject:{sourceIdentity:{platform:'linkedin',externalId:profile},mention:'u1',identityState:'UNRESOLVED',personId:null,
      resolutionRevision:'0',resolutionDecisionId:null,identityEvidenceIds:[citation.evidenceId]},object:null,
    organizationRef:null,predicate:'IDENTIFIES_PROFILE',relationshipKind:null,citationIds:[citation.id],assertedPeriod:null,current:null,
    support:'DIRECT_EXPLICIT',confidence:{value:null,meaning:'HEURISTIC_EVIDENCE_SUPPORT',policyVersion:null},extractionUncertainties:[],
    reviewState:'PENDING',reviewDecisionId:null,includeInSearch:false};
  return {citations:[citation],proposals:[proposal]};
}
function fixture(overrides={}, budget={}) {
  const calls={search:[],document:[],extraction:[]};
  const ports={provider:{kind:'TAVILY',configured:true,search:async(q,s)=>{calls.search.push(q);return [hit('https://example.org/initial')];}},
    documents:{fetch:async(url,s)=>{calls.document.push(url);return document(url);}},
    extraction:{extract:async(doc,s)=>{calls.extraction.push(doc.id);return extracted(doc);}},...overrides};
  return {calls,planner:createDiscoveryPlanner(ports,budget)};
}

test('actually searches newly discovered unresolved public identity toward target with reserved page capacity',async()=>{
  const searches=[],pages=[];
  const f=fixture({provider:{kind:'TAVILY',configured:true,search:async q=>{searches.push(q);return [hit(q.includes(profile)?'https://example.org/expanded':'https://example.org/initial')];}},
    documents:{fetch:async url=>{pages.push(url);return document(url);}}});
  const out=await f.planner.collect(input());
  assert.equal(searches.length,4);
  assert.equal(searches[2],`"${profile}" "o0"`);
  assert.ok(pages.includes('https://example.org/expanded'));
  assert.equal(out.queries[2].frontier,'EXPANSION');
  assert.equal(out.queries[2].candidate.status,'EXPLORATORY_ONLY');
  assert.equal(out.extractions[0].output.proposals[0].subject.personId,null);
  assert.equal(out.extractions[0].output.proposals[0].includeInSearch,false);
  assert.equal(out.persistence,'NOT_PERFORMED');
  for(const key of ['paths','events','graph','people','relationships'])assert.equal(key in out,false);
});

test('name-only, ambiguous, unattributed, wrong revision, wrong offset and altered digest cannot expand',()=>{
  const doc=document('https://example.org/a');
  const mutations=[
    x=>x.proposals[0].subject.sourceIdentity.externalId='u1',
    x=>x.proposals[0].support='AMBIGUOUS',
    x=>x.proposals[0].support='CONTEXT_ONLY',
    x=>x.proposals[0].kind='AFFILIATION',
    x=>x.proposals[0].kind='RELATIONSHIP',
    x=>x.proposals[0].extractionUncertainties=['unattributed'],
    x=>x.proposals[0].subject.identityEvidenceIds=[],
    x=>x.citations[0].documentRevision='other',
    x=>x.citations[0].locator.start=1,
    x=>x.citations[0].supportingExcerpt='u1',
    x=>x.citations[0].role='RELATIONSHIP',
    x=>x.proposals[0].includeInSearch=true,
  ];
  for(const mutate of mutations){const output=extracted(doc);mutate(output);assert.deepEqual(discoverExploratoryCandidates(doc,output),[]);}
  assert.deepEqual(discoverExploratoryCandidates({...doc,contentDigest:'bad'},extracted(doc)),[]);
  const bare=document('https://example.org/a','u1 works at o0');
  assert.deepEqual(discoverExploratoryCandidates(bare,extracted(bare)),[]);
});

test('ambiguous extraction and search snippets never produce next-person queries',async()=>{
  const f=fixture({extraction:{extract:async doc=>{const x=extracted(doc);x.proposals[0].support='AMBIGUOUS';return x;}}});
  const out=await f.planner.collect(input());
  assert.equal(out.candidates.length,0);assert.ok(f.calls.search.every(q=>!q.includes(profile)));
  assert.ok(out.limitations.some(s=>s.includes('names alone')));
});

test('explicit selected public terms only; unselected/private context rejected before any operation',async()=>{
  const f=fixture();
  for(const authority of [{scopeId:'foreign',graphVersion:'0',selectedContexts:[]},
    {scopeId:'s0',graphVersion:'0',selectedContexts:[{personId:'private',publicTerms:['private-contact-name']}]}]){
    await assert.rejects(f.planner.collect({...input(),authority}),e=>e.code==='FORBIDDEN');
  }
  await assert.rejects(f.planner.collect({...input(),authority:{scopeId:'s0',graphVersion:'1',selectedContexts:[]}}),e=>e.code==='VERSION_CONFLICT');
  assert.deepEqual(f.calls,{search:[],document:[],extraction:[]});
  const selected=input();selected.request.selectedContextPersonIds=['p0'];
  selected.authority.selectedContexts=[{personId:'p0',publicTerms:['explicit-public-term']}];
  const out=await f.planner.collect(selected);
  assert.ok(f.calls.search.some(q=>q.includes('explicit-public-term')));
  assert.ok(!JSON.stringify(out).includes('private-contact-name'));
});

test('global limits include failures, reserve retained hits and prioritize expansion documents',async()=>{
  let count=0;const urls=[];
  const f=fixture({provider:{kind:'TAVILY',configured:true,search:async()=>Array.from({length:5},(_,i)=>hit(`https://example.org/q${++count}-${i}`))},
    documents:{fetch:async url=>{urls.push(url);return document(url);}}});
  const out=await f.planner.collect(input());
  assert.equal(out.budget.searchesAttempted,4);assert.equal(out.budget.documentAttempts,5);
  assert.equal(out.budget.retainedHits,8);assert.equal(out.budget.extractionAttempts,5);
  assert.ok(out.budget.exhausted);assert.equal(out.hits.length,8);
  assert.deepEqual(urls.slice(0,3),out.hits.slice(0,3).map(h=>h.url));
  assert.deepEqual(urls.slice(3),out.hits.slice(4,6).map(h=>h.url));
});

test('no evidence means honest insufficient result and no fabricated route/candidate',async()=>{
  const f=fixture({provider:{kind:'TAVILY',configured:true,search:async()=>[]}});
  const out=await f.planner.collect(input());
  assert.equal(out.status,'INSUFFICIENT_PUBLIC_EVIDENCE');assert.deepEqual(out.candidates,[]);
  assert.deepEqual(out.extractions,[]);assert.deepEqual(out.documents,[]);
  assert.ok(out.limitations.some(s=>s.includes('insufficient evidence')));
});

test('canonical URL/query dedup and URL anchors never converted to names',async()=>{
  assert.equal(canonicalPublicUrl('https://EXAMPLE.org:443/a#one'),'https://example.org/a');
  assert.equal(canonicalPublicUrl('https://instagram.com/U0/?igsh=x'),request.anchors.instagramUrl);
  assert.notEqual(canonicalPublicUrl('https://example.org/A'),canonicalPublicUrl('https://example.org/a'));
  assert.equal(canonicalQuery('  q   r  '),'q r');
  const f=fixture({provider:{kind:'TAVILY',configured:true,search:async()=>[hit('https://example.org/a#one'),hit('https://EXAMPLE.org:443/a#two')]}});
  const out=await f.planner.collect(input());assert.equal(out.hits.length,1);assert.equal(out.budget.documentAttempts,1);
  const changed=input();changed.request.anchors.linkedinUrl='https://linkedin.com/in/arbitrary-name-321';
  const next=fixture();await next.planner.collect(changed);
  assert.ok(next.calls.search[0].includes('https://www.linkedin.com/in/arbitrary-name-321/'));
  assert.ok(next.calls.search.every(q=>!q.includes('arbitrary name')));
});

test('provider denied/quota, unavailable and sync failure each stop immediately and count attempt',async()=>{
  for(const error of [new DiscoveryError('ACCESS_DENIED'),new DiscoveryError('LIMIT_EXCEEDED'),new Error('private-provider-body')]){
    let calls=0;const f=fixture({provider:{kind:'TAVILY',configured:true,search(){calls++;throw error;}}});
    const out=await f.planner.collect(input());assert.equal(calls,1);assert.equal(out.stop,'PROVIDER_STOPPED');
    assert.equal(out.budget.searchesAttempted,1);assert.equal(out.queries[0].outcome,'FAILED');assert.equal(out.budget.documentAttempts,0);
    assert.ok(!JSON.stringify(out).includes('private-provider-body'));
  }
});

test('unconfigured provider spends no operations',async()=>{
  const f=fixture({provider:{kind:'TAVILY',configured:false,search(){throw new Error('must not run');}}});
  const out=await f.planner.collect(input());assert.equal(out.stop,'NOT_CONFIGURED');assert.equal(out.budget.searchesAttempted,0);
});

test('pre-cancellation and cancellation during stalled search return exact attempt accounting',async()=>{
  const before=new AbortController();before.abort();const f=fixture();
  const out=await f.planner.collect(input(),before.signal);assert.equal(out.stop,'CANCELLED');assert.equal(out.budget.searchesAttempted,0);
  const during=new AbortController();let portSignal;
  const stalled=fixture({provider:{kind:'TAVILY',configured:true,search(q,s){portSignal=s;during.abort();return new Promise(()=>{});}}});
  const cancelled=await stalled.planner.collect(input(),during.signal);
  assert.equal(cancelled.stop,'CANCELLED');assert.equal(cancelled.budget.searchesAttempted,1);
  assert.equal(cancelled.queries[0].outcome,'CANCELLED');assert.equal(portSignal.aborted,true);
});

test('deadline interrupts ignored abort signal and prevents subsequent operations',async()=>{
  const f=fixture({provider:{kind:'TAVILY',configured:true,search:()=>new Promise(()=>{})}},{collectionMs:15});
  const out=await f.planner.collect(input());assert.equal(out.stop,'DEADLINE');
  assert.equal(out.budget.searchesAttempted,1);assert.equal(out.queries[0].outcome,'DEADLINE');assert.equal(out.budget.documentAttempts,0);
});

test('document/extraction cancellation counts attempted operation but retains no late output',async()=>{
  for(const stage of ['documents','extraction']){
    const controller=new AbortController();const stalled=stage==='documents'?{fetch(){controller.abort();return new Promise(()=>{});}}:
      {extract(){controller.abort();return new Promise(()=>{});}};
    const out=await fixture({[stage]:stalled}).planner.collect(input(),controller.signal);
    assert.equal(out.stop,'CANCELLED');assert.equal(out.budget.documentAttempts,1);
    assert.equal(out.budget.extractionAttempts,stage==='extraction'?1:0);assert.equal(out.extractions.length,0);
  }
});

test('limits can decrease but cannot increase defaults; failed pages count and do not fabricate output',async()=>{
  const f=fixture({documents:{fetch(){throw new DiscoveryError('ACCESS_DENIED');}}},{maxSearches:1,maxRetainedHits:2,maxDocumentAttempts:1,collectionMs:999999});
  const out=await f.planner.collect(input());assert.equal(out.budget.collectionMs,30000);
  assert.equal(out.budget.searchesAttempted,1);assert.equal(out.budget.documentAttempts,1);assert.equal(out.documents.length,0);
  assert.equal(out.budget.extractionAttempts,0);assert.equal(out.status,'INSUFFICIENT_PUBLIC_EVIDENCE');
  assert.throws(()=>fixture({}, {maxSearches:-1}));assert.throws(()=>fixture({}, {maxDocumentAttempts:NaN}));
});

test('second frontier cannot recursively trigger third frontier',async()=>{
  let count=0;
  const f=fixture({provider:{kind:'TAVILY',configured:true,search:async()=>[hit(`https://example.org/${++count}`)]},
    documents:{fetch:async url=>document(url,url.endsWith('/3')?`u1 identifies their profile as https://www.linkedin.com/in/u2/`:undefined)},
    extraction:{extract:async doc=>{const x=extracted(doc);if(doc.sourceUrl.endsWith('/3'))x.proposals[0].subject.sourceIdentity.externalId='https://www.linkedin.com/in/u2/';return x;}}});
  const out=await f.planner.collect(input());assert.ok(out.candidates.some(c=>c.profileUrl.endsWith('/u2/')));
  assert.ok(out.queries.every(q=>!q.query.includes('/u2/')));
});

// Anonymous explicit source mentions, using the extraction producer's exact contract conventions.
function occurrenceExtraction(doc) {
  const names=['Person Alpha','Person Beta'];
  const endpoints=names.map((mention,i)=>({sourceIdentity:{platform:'PUBLIC_DOCUMENT_MENTION',externalId:`mention_${doc.id}_${i}`},
    mention,identityState:'UNRESOLVED',personId:null,resolutionRevision:'r0',resolutionDecisionId:null,identityEvidenceIds:[`e${i}`]}));
  const citations=names.map((mention,i)=>({id:`c${i}`,evidenceId:`e${i}`,documentId:doc.id,documentRevision:doc.revision,role:'IDENTITY',
    supportingExcerpt:mention,locator:{start:doc.normalizedText.indexOf(mention),end:doc.normalizedText.indexOf(mention)+mention.length,section:null},statementId:null}));
  citations.push({id:'cr',evidenceId:'er',documentId:doc.id,documentRevision:doc.revision,role:'RELATIONSHIP',supportingExcerpt:doc.normalizedText,
    locator:{start:0,end:doc.normalizedText.length,section:null},statementId:null});
  const template=extracted(doc).proposals[0];
  const proposals=endpoints.map((subject,i)=>({...template,id:`p${i}`,kind:'IDENTITY',subject,predicate:'SOURCE_PERSON_MENTION',citationIds:[`c${i}`],support:'CONTEXT_ONLY'}));
  proposals.push({...template,id:'pr',kind:'RELATIONSHIP',subject:endpoints[0],object:endpoints[1],predicate:'FRIEND_OF',relationshipKind:'FRIEND',citationIds:['cr'],
    extractionUncertainties:['Person mentions are unresolved; names do not establish identity.','Source assertion is not independently verified; dates are unknown unless explicitly supplied.']});
  return {citations,proposals};
}

test('source-local unresolved occurrences trigger literal mention + target + cited context queries without identity review',async()=>{
  const text='Person Alpha is a friend of Person Beta.';
  const f=fixture({documents:{fetch:async url=>document(url,text)},extraction:{extract:async doc=>occurrenceExtraction(doc)}});
  const out=await f.planner.collect(input());
  assert.equal(out.queries[2].query,`"Person Alpha" "o0" "${text}"`);
  assert.equal(out.queries[3].query,`"Person Beta" "o0" "${text}"`);
  assert.ok(out.candidates.every(c=>c.identityState==='UNRESOLVED'&&c.profileUrl===null&&c.status==='EXPLORATORY_ONLY'));
  assert.equal(out.queries[2].candidate.sourceIdentity.platform,'PUBLIC_DOCUMENT_MENTION');
  assert.deepEqual(out.queries[2].candidate.citationIds,['c0','cr']);
  assert.ok(out.extractions[0].output.proposals.every(p=>p.subject.personId===null&&p.includeInSearch===false&&p.reviewState==='PENDING'));
  for(const key of ['paths','events','graph','people','relationships'])assert.equal(key in out,false);
});

test('contextual expansion rejects ambiguity, unattached identity quotes, common-name-only and shared employer assertions',()=>{
  const doc=document('https://example.org/a','Person Alpha is a friend of Person Beta.');
  for(const mutate of [
    x=>x.proposals[2].support='AMBIGUOUS',
    x=>x.proposals[2].extractionUncertainties.push('ambiguous attribution'),
    x=>x.proposals[2].kind='AFFILIATION',
    x=>x.proposals[2].kind='IDENTITY',
    x=>x.proposals[2].object=null,
    x=>x.proposals[2].object.mention='Person Alpha',
    x=>x.proposals[2].object.identityEvidenceIds=[],
    x=>x.citations[2].documentRevision='other',
    x=>x.citations[0].locator.start=1,
    x=>x.proposals[2].subject.personId='canonical-person',
    x=>x.proposals[2].subject.sourceIdentity.platform='GOOGLE_CONTACTS',
  ]){const output=occurrenceExtraction(doc);mutate(output);assert.deepEqual(discoverExploratoryCandidates(doc,output),[]);}
});

test('same-name occurrences on different sources stay distinct, even when query strings deduplicate',async()=>{
  let count=0;const f=fixture({provider:{kind:'TAVILY',configured:true,search:async()=>[hit(`https://example.org/${++count}`)]},
    documents:{fetch:async url=>document(url,'Person Alpha is a friend of Person Beta.')},extraction:{extract:async doc=>occurrenceExtraction(doc)}});
  const out=await f.planner.collect(input());
  const sameName=out.candidates.filter(c=>c.mention==='Person Alpha');assert.ok(sameName.length>1);
  assert.equal(new Set(sameName.map(c=>c.sourceIdentity.externalId)).size,sameName.length);
  assert.equal(new Set(out.queries.map(q=>q.query)).size,out.queries.length);
  assert.ok(out.extractions.every(e=>e.output.proposals.every(p=>p.subject.personId===null)));
});

test('redirect aliases do not trigger a second page attempt; malformed extraction remains a limitation',async()=>{
  const f=fixture({provider:{kind:'TAVILY',configured:true,search:async()=>[hit('https://example.org/a'),hit('https://example.org/b')]},
    documents:{fetch:async url=>({...document(url),fetchedUrl:'https://example.org/b'})},extraction:{extract:async()=>({proposals:[{}],citations:[]})}});
  const out=await f.planner.collect(input());assert.equal(out.budget.documentAttempts,1);assert.equal(out.candidates.length,0);
  assert.ok(out.issues.some(i=>i.stage==='EXTRACTION'));assert.equal(out.status,'INSUFFICIENT_PUBLIC_EVIDENCE');
});

test('oversized public query discriminators are omitted explicitly rather than truncated',async()=>{
  const i=input();i.request.target.profileUrl=`https://example.org/${'a'.repeat(1000)}`;
  const out=await fixture().planner.collect(i);
  assert.ok(out.queries.every(q=>q.query.length<=600));
  assert.ok(out.issues.some(issue=>issue.code==='QUERY_TOO_LONG_OR_INVALID'));
  assert.ok(out.queries[0].query.includes(request.anchors.linkedinUrl));
});
