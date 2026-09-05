import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeGoogleContacts} from '../dist/packages/ingestion/googleContactsNormalizer.js';
import {validateCandidateBatch} from '../dist/contracts/validation.js';
const context={sourceId:'s1',batchId:'b1'};
const authority={...context,existingPersonIds:new Set(['owner']),existingEvidenceIds:new Set()};
test('compiled Shaw normalizer passes runtime authority and preserves observed-only semantics',()=>{
 const batch=normalizeGoogleContacts({ownerPersonId:'owner',retrievedAt:'2026-09-05T12:00:00.000Z',connections:[{resourceName:'people/unit',organizations:[{name:'Unit Organization',current:true},{name:'Prior Organization',current:false}]}]},context);
 assert.equal(validateCandidateBatch(batch,authority),batch);
 assert.equal(batch.observedLinks[0].fromRef,'owner');assert.deepEqual(batch.relationships,[]);
 assert.deepEqual(batch.affiliations.map(a=>a.current),[true,false]);
 assert.throws(()=>validateCandidateBatch(batch,{...authority,existingPersonIds:new Set()}));
 assert.throws(()=>validateCandidateBatch(batch,{...authority,sourceId:'other'}));
});
test('empty and malformed optional provider fields yield runtime-valid batches',()=>{
 for(const connections of [[],[{resourceName:'people/unit',names:{},organizations:{}}]]) {
  const batch=normalizeGoogleContacts({ownerPersonId:'owner',retrievedAt:'2026-09-05T12:00:00.000Z',connections},context);
  assert.doesNotThrow(()=>validateCandidateBatch(batch,authority));
 }
});
