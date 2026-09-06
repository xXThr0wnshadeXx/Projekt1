import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validatePublicClaimReview} from '../dist/packages/server/public-facts/acceptance-contracts.js';
import {PublicClaimReviewService,PUBLIC_REVIEW_WARNINGS} from '../dist/packages/server/public-facts/acceptance.js';
import {withPublicCitationWarnings} from '../dist/packages/server/public-facts/acceptance-search.js';
const binding={endpointId:'endpoint',endpointRevision:'revision',resolutionDecisionId:'resolved'};
const decision={sourceId:'source',proposalId:'proposal',proposalRevision:'revision',decision:'ACCEPT',includeInSearch:true,bindings:{subject:binding,object:{...binding,endpointId:'other'}}};
const request={scopeId:'scope',expectedGraphVersion:'1',idempotencyKey:'key',confirm:true,decisions:[decision]};
test('claim review rejects client policy/actor overrides, missing consent, oversized or duplicate batches and invalid scores',()=>{
 assert.deepEqual(validatePublicClaimReview(request),request);
 for(const invalid of [{...request,actorUserId:'foreign'},{...request,policy:{version:'fake'}},{...request,confirm:false},{...request,decisions:[]},{...request,decisions:[decision,decision]},
  {...request,decisions:Array.from({length:11},(_,i)=>({...decision,proposalId:`p${i}`}))},{...request,decisions:[{...decision,relativeStrength:NaN}]},{...request,decisions:[{...decision,relativeStrength:1.1}]},
  {...request,decisions:[{...decision,confidence:1}]},{...request,decisions:[{...decision,bindings:{subject:binding}}]},
  {...request,decisions:[{sourceId:'source',proposalId:'proposal',proposalRevision:'revision',decision:'REJECT',includeInSearch:false}]}])assert.throws(()=>validatePublicClaimReview(invalid));
});
test('claim facade derives the actor and session hash from opaque credential',async()=>{
 let calls=0;const credential='s'.repeat(43);
 const service=new PublicClaimReviewService({auth:{resolveSession:async value=>value===credential?{userId:'owner'}:null},claims:{review:async(actor,value)=>{calls++;assert.equal(actor.userId,'owner');assert.match(actor.sessionHash,/^[a-f0-9]{64}$/);assert.deepEqual(value,request);return {};}}});
 await assert.rejects(()=>service.review(null,request),{code:'UNAUTHENTICATED'});
 await assert.rejects(()=>service.review(credential,{...request,ownerUserId:'foreign'}));assert.equal(calls,0);
 await service.review(credential,request);assert.equal(calls,1);
});
test('public warning composition annotates returned and streamed paths without changing ranking/factors or engine result',()=>{
 const path={id:'path',score:0.1,explanation:{evidenceIds:['public'],uncertainties:[]}};
 const original={paths:[path],events:[{type:'PATH_CANDIDATE',path}],warnings:[],trace:'unchanged'};
 const before=structuredClone(original),snapshot={sources:[{id:'source',origin:'PUBLIC_SOURCE'}],evidence:[{id:'public',sourceId:'source'}]};
 const result=withPublicCitationWarnings({findBestPaths:()=>original}).findBestPaths(snapshot,{},[],{});
 assert.deepEqual(original,before);assert.equal(result.paths[0].score,0.1);assert.equal(result.trace,'unchanged');
 assert.deepEqual(result.paths[0].explanation.uncertainties,PUBLIC_REVIEW_WARNINGS);assert.deepEqual(result.events[0].path.explanation.uncertainties,PUBLIC_REVIEW_WARNINGS);
 assert.deepEqual(result.warnings,PUBLIC_REVIEW_WARNINGS);
});
