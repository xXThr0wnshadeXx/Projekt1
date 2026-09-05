import test from 'node:test';
import assert from 'node:assert/strict';
import {validateGraphSnapshot,validateCandidateBatch,validateSearchRequest,validateSearchResult,validateOpportunityPath,validateInference,validateGraphBuildEvent,ContractError} from '../dist/contracts/validation.js';
import {graph,path,result,batch,authority,batchAuthority} from './fixtures.mjs';

test('valid structural contracts and pending inference round-trip',()=>{
 assert.equal(validateGraphSnapshot(graph(),authority).people.length,2);
 assert.equal(validateCandidateBatch(batch(),batchAuthority).people.length,1);
 validateSearchResult(result(),graph());
 validateInference({payload:batch(),confidence:1,evidenceIds:['e1'],inferenceType:'EXTRACTION',confirmationState:'PENDING',producer:'p0',promptVersion:'v1'},'EXTRACTION',x=>validateCandidateBatch(x,batchAuthority),new Set(['e1']));
});
for(const [name,mutate] of Object.entries({
 'unknown private field':g=>{g.evidence[0].rawImport='opaque';},
 'missing root':g=>{g.rootPersonId='p9';},
 'wrong scope':g=>{g.scopeId='s9';},
 'unapproved source':g=>{g.sources[0].id='s9';},
 'dangling evidence source':g=>{g.evidence[0].sourceId='s9';},
 'dangling edge person':g=>{g.searchEdges[0].toPersonId='p9';},
 'missing evidence':g=>{g.searchEdges[0].evidenceIds=[];},
 'hidden evidence':g=>{g.searchEdges[0].evidenceIds=['e9'];},
 'duplicate people':g=>{g.people.push(g.people[0]);},
 'NaN score':g=>{g.searchEdges[0].strength=NaN;},
 'infinite score':g=>{g.searchEdges[0].confidence=Infinity;},
 'negative score':g=>{g.searchEdges[0].recencyFactor=-1;},
 'score above one':g=>{g.people[0].identityConfidence=1.1;},
 'invalid calendar date':g=>{g.people[0].updatedAt='2026-02-30T00:00:00.000Z';},
 'non UTC date':g=>{g.people[0].updatedAt='2026-09-05T00:00:00+00:00';},
 'unsafe URL':g=>{g.evidence[0].publicUrl='https://example.org/?token=opaque';},
 'unsupported follow prior':g=>{g.observedLinks[0].kind='FOLLOWS';},
 'reversed prior':g=>{g.observedLinks[0].fromPersonId='p1';g.observedLinks[0].toPersonId='p0';},
 'pending identity assignment':g=>{g.people[1].identityIds=['i0'];g.identities=[{id:'i0',sourceId:'s1',platform:'m0',externalId:'a0',personId:'p1',assignmentState:'PENDING',evidenceIds:['e0'],updatedAt:g.people[0].updatedAt}];},
 'unsupported confirmed relationship':g=>{g.searchEdges[0].basis='CONFIRMED_RELATIONSHIP';g.searchEdges[0].relationshipId='r9';}
}))test(`graph rejects ${name}`,()=>{const g=graph();mutate(g);assert.throws(()=>validateGraphSnapshot(g,authority),ContractError);});
for(const [name,mutate] of Object.entries({
 'other source':b=>{b.sourceId='s9';},'other batch':b=>{b.batchId='b9';},'cross-scope person':b=>{b.observedLinks[0].fromRef='p9';},'unknown evidence':b=>{b.people[0].evidenceIds=['e9'];},'evidence overwrite':b=>{b.evidence[0].id='e0';},'ambiguous temp ID':b=>{b.people[0].tempId='p0';},'duplicate provider identity':b=>{b.people[0].identities.push(b.people[0].identities[0]);},'hidden existing person':b=>{b.people[0].existingPersonId='p9';},'automatic acceptance field':b=>{b.people[0].state='CONFIRMED';}
}))test(`batch rejects ${name}`,()=>{const b=batch();mutate(b);assert.throws(()=>validateCandidateBatch(b,batchAuthority),ContractError);});
for(const [name,mutate] of Object.entries({
 'cycle':p=>{p.personIds=['p0','p0'];},'reverse':p=>{p.personIds=['p1','p0'];},'missing edge':p=>{p.edgeIds=['x9'];},'inflated factor':p=>{p.score.value=0.9;},'extra root factor':p=>{p.score.identities.push({personId:'p0',value:1});},'wrong contact':p=>{p.explanation.suggestedFirstContactId='p0';},'hidden explanation':p=>{p.explanation.evidenceIds=['e9'];}
}))test(`path rejects ${name}`,()=>{const p=path();mutate(p);assert.throws(()=>validateOpportunityPath(p,graph()),ContractError);});
for(const [name,mutate] of Object.entries({
 'event scope':r=>{r.events[1].scopeId='s9';},'event version':r=>{r.events[1].graphVersion='v9';},'event search ID':r=>{r.events[1].searchId='q9';},'duplicate sequence':r=>{r.events[1].seq=0;},'hidden event edge':r=>{r.events[1].edgeId='x9';},'selected unknown path':r=>{r.events[2].pathId='path9';},'missing completion':r=>{r.events.pop();},'false exhaustiveness':r=>{r.stats.stop='BUDGET_REACHED';},'false trace status':r=>{r.stats.omittedTraceEvents=1;}
}))test(`search rejects ${name}`,()=>{const r=result();mutate(r);assert.throws(()=>validateSearchResult(r,graph()),ContractError);});
test('search request rejects client actor/root and nonintegers',()=>{for(const extra of [{actorUserId:'u9'},{rootPersonId:'p9'},{k:0},{k:1.5},{maxHops:-1}])assert.throws(()=>validateSearchRequest({scopeId:'s0',expectedGraphVersion:'v1',goalText:'g0',...extra}),ContractError);});
test('inference cannot confirm itself or cite hidden evidence',()=>{const base={payload:batch(),confidence:1,evidenceIds:['e1'],inferenceType:'EXTRACTION',confirmationState:'PENDING',producer:'p0',promptVersion:'v1'};for(const extra of [{confirmationState:'CONFIRMED'},{evidenceIds:['e9']},{inferenceType:'IDENTITY'}])assert.throws(()=>validateInference({...base,...extra},'EXTRACTION',x=>validateCandidateBatch(x,batchAuthority),new Set(['e1'])),ContractError);});
test('build delta must agree with committed authorized snapshot',()=>{const before=graph(),after=graph();after.graphVersion='v2';const context={jobId:'j0',scopeId:'s0',afterSeq:0,before,after,candidateIds:new Set(),proposalIds:new Set()};const e={schemaVersion:1,jobId:'j0',scopeId:'s0',seq:1,type:'BATCH_COMMITTED',operationKind:'IMPORT',baseGraphVersion:'v1',graphVersion:'v2',...Object.fromEntries(['people','identities','organizations','observedLinks','relationships','searchEdges','evidence','sources'].map(k=>[k,after[k]])),removedPersonIds:[],removedEdgeIds:[]};validateGraphBuildEvent(e,context);assert.throws(()=>validateGraphBuildEvent({...e,graphVersion:'v9'},context),ContractError);assert.throws(()=>validateGraphBuildEvent({...e,removedPersonIds:['p0']},context),ContractError);const altered=structuredClone(e);altered.people[0].displayName='p9';assert.throws(()=>validateGraphBuildEvent(altered,context),ContractError);});
test('serialized property order does not affect authoritative target equality',()=>{const r=result();r.paths[0].target=Object.fromEntries(Object.entries(r.targets[0]).reverse());validateSearchResult(r,graph());});
test('sparse arrays and missing selected events are rejected',()=>{const g=graph();g.people=new Array(2);assert.throws(()=>validateGraphSnapshot(g,authority),ContractError);const r=result();r.events.splice(2,1);r.events[2].seq=2;assert.throws(()=>validateSearchResult(r,graph()),ContractError);});
test('zero-contact graph contains actual root only',()=>{const g=graph();g.people=g.people.slice(0,1);for(const k of ['sources','evidence','observedLinks','searchEdges'])g[k]=[];validateGraphSnapshot(g,authority);g.people=[];assert.throws(()=>validateGraphSnapshot(g,authority),ContractError);});
