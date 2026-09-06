import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validatePublicStage} from '../dist/packages/server/public-facts/validation.js';
import {attributedStage} from './public-attribution-fixture.mjs';

test('stage retains source-declared author provenance and keeps authored assertions pending',()=>{
 const input=attributedStage(),r=validatePublicStage(input);
 assert.deepEqual(r,input);assert.equal(r.envelope.proposals[0].includeInSearch,false);
 assert.equal(r.envelope.proposals[0].subject.identityState,'UNRESOLVED');
 assert.equal(r.envelope.normalized.batch.relationships.length,0);
});
test('authored stage rejects incomplete metadata, substituted author and out-of-article evidence',()=>{
 const mutations=[
  x=>delete x.envelope.documents[0].attribution,
  x=>delete x.envelope.documents[0].metadataStatus,
  x=>x.envelope.documents[0].normalizationVersion='public-source-text-v1',
  x=>x.envelope.documents[0].attribution.author.locator.start=1,
  x=>x.envelope.documents[0].attribution.author.declarationKinds.reverse(),
  x=>x.envelope.documents[0].attribution.author.declarationKinds=['HTML_META_NAME_AUTHOR','HTML_META_NAME_AUTHOR'],
  x=>x.envelope.documents[0].attribution.article.locator.end-=1,
  x=>x.envelope.documents[0].attribution.article.proseRanges=[],
  x=>x.envelope.documents[0].attribution.article.proseRanges[0].start+=1,
  x=>x.envelope.proposals[0].subject=x.envelope.proposals[0].object,
  x=>x.envelope.proposals[0].relationshipKind='CLOSE_FRIEND',
 ];
 for(const mutate of mutations){const input=attributedStage();mutate(input);assert.throws(()=>validatePublicStage(input));}
});
