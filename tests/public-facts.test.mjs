import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validatePublicStage,endpointId,endpointRevision} from '../dist/packages/server/public-facts/validation.js';
import {validatePublicResolution} from '../dist/packages/server/public-facts/contracts.js';
import {publicStage} from './public-facts-fixture.mjs';

test('public stage binds exact text, quote offsets, source records and identity evidence without scoring defaults',()=>{
 const input=publicStage(),validated=validatePublicStage(input);
 assert.deepEqual(validated,input);assert.equal(validated.envelope.proposals[0].confidence.value,null);assert.equal(validated.envelope.proposals[0].current,null);
 assert.equal(validated.envelope.proposals[0].relationshipKind,null);assert.equal(validated.envelope.proposals[0].includeInSearch,false);
 const ep=input.envelope.proposals[0].subject;
 assert.notEqual(endpointId('s1','src1',ep),endpointId('s2','src1',ep));
 assert.notEqual(endpointRevision(input.envelope,ep),endpointRevision(publicStage({revision:'v2'}).envelope,ep));
});
test('invalid excerpts/digests/provenance, fabricated mappings, date precision and inferred support reject',()=>{
 const changes=[
  x=>x.texts[0].normalizedText+='changed',x=>x.envelope.citations[0].supportingExcerpt='invented',
  x=>x.envelope.citations[0].locator.end=100,x=>x.envelope.citations[0].documentRevision='other',
  x=>x.envelope.normalized.evidenceRecords[0].sourceRecordId='foreign',
  x=>x.envelope.normalized.records[0].privatePayloadRef='missing',
  x=>x.envelope.documents[0].sourceId='foreign',
  x=>x.envelope.proposals[0].subject.identityState='EXPLICITLY_CONFIRMED',
  x=>x.envelope.proposals[0].subject.personId='root',
  x=>x.envelope.proposals[0].subject.mention='invented name',
  x=>x.envelope.proposals[0].subject.identityEvidenceIds=['r1_v1'],
  x=>x.envelope.proposals[0].reviewState='CONFIRMED',x=>x.envelope.proposals[0].includeInSearch=true,
  x=>x.envelope.proposals[0].support='CORROBORATED_DIRECT',
  x=>x.envelope.documents[0].publishedAt={value:'2026-02-30',precision:'DAY'},
  x=>x.envelope.proposals[0].confidence.value=0.9,
  x=>x.envelope.normalized.context.sharingDecisionId='unapproved',
 ];
 for(const change of changes){const input=publicStage();change(input);assert.throws(()=>validatePublicStage(input));}
});
test('identity resolution accepts explicit dispositions only with immutable selection and no actor override',()=>{
 const input={scopeId:'s1',expectedGraphVersion:'2',idempotencyKey:'k1',confirm:true,endpointId:'ep1',expectedEndpointRevision:'rev1',expectedResolutionDecisionId:null,disposition:'NEW_PERSON'};
 assert.deepEqual(validatePublicResolution(input),input);
 for(const patch of [{confirm:false},{actorUserId:'u1'},{personId:'p1'},{disposition:'AUTO_MERGE'},{disposition:'LINK_EXISTING'}])assert.throws(()=>validatePublicResolution({...input,...patch}));
 assert.equal(validatePublicResolution({...input,disposition:'LINK_EXISTING',personId:'p1'}).personId,'p1');
});
