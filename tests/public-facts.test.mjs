import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validatePublicStage,endpointId,endpointRevision} from '../dist/packages/server/public-facts/validation.js';
import {validatePublicResolution} from '../dist/packages/server/public-facts/contracts.js';
import {publicStage,textHash} from './public-facts-fixture.mjs';

function withDocumentText(value) {
 const input=publicStage();input.texts[0].normalizedText=value;
 if(typeof value==='string'){
  input.envelope.documents[0].contentDigest=textHash(value);
  input.envelope.normalized.records[0].contentDigest=textHash(value);
 }
 return input;
}

test('normalized documents accept ASCII beyond metadata cap through the exact 1MiB byte boundary',()=>{
 const prefix=publicStage().texts[0].normalizedText;
 for(const bytes of [8193,64*1024,1024*1024]){
  const text=prefix.padEnd(bytes,'x');assert.equal(Buffer.byteLength(text),bytes);
  assert.equal(validatePublicStage(withDocumentText(text)).texts[0].normalizedText,text);
 }
 assert.throws(()=>validatePublicStage(withDocumentText(prefix.padEnd(1024*1024+1,'x'))),{path:'$.texts[0].normalizedText'});
});
test('normalized document limit counts multibyte UTF8 rather than UTF16 characters',()=>{
 const prefix=publicStage().texts[0].normalizedText,remaining=1024*1024-Buffer.byteLength(prefix);
 const exact=prefix+'😀'.repeat(Math.floor(remaining/4))+'x'.repeat(remaining%4);
 assert.equal(Buffer.byteLength(exact),1024*1024);assert.ok(exact.length<1024*1024);
 assert.equal(validatePublicStage(withDocumentText(exact)).texts[0].normalizedText,exact);
 for(const suffix of ['x','😀'])assert.throws(()=>validatePublicStage(withDocumentText(exact+suffix)),{path:'$.texts[0].normalizedText'});
});
test('document validator retains string/nonblank/control checks and does not widen metadata or quote limits',()=>{
 const prefix=publicStage().texts[0].normalizedText;
 for(const value of [null,1,[],{},'', ' \t\r\n',...['\u0000','\u0008','\u000b','\u000c','\u001f'].map(c=>prefix+c)]){
  assert.throws(()=>validatePublicStage(withDocumentText(value)),{path:'$.texts[0].normalizedText'});
 }
 assert.doesNotThrow(()=>validatePublicStage(withDocumentText(prefix+'\t\r\n')));
 const metadata=withDocumentText(prefix.padEnd(64*1024,'x'));metadata.envelope.documents[0].title='x'.repeat(501);
 assert.throws(()=>validatePublicStage(metadata),{path:'$.envelope.documents[0].title'});
 const quote=withDocumentText(prefix.padEnd(64*1024,'x'));quote.envelope.citations[0].supportingExcerpt='x'.repeat(2001);
 assert.throws(()=>validatePublicStage(quote),{path:'$.envelope.citations[0].supportingExcerpt'});
});

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
