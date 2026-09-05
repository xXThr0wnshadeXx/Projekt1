// Cross-owner acceptance check: pass the built immutable public-facts validator path as argv[2].
// Example: node tests/discovery-extraction-stage.mjs /tmp/facts/dist/packages/server/public-facts/validation.js
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createPublicExtractionProducer} from '../dist/packages/server/discovery/extraction/index.js';
if (!process.argv[2]) throw new Error('Pass the immutable built public-facts/validation.js path');
const {validatePublicStage} = await import(pathToFileURL(process.argv[2]).href);
const digest = value => createHash('sha256').update(value).digest('hex');
const text = 'Person Alpha is a friend of Person Beta. Person Beta works at Organization Alpha.';
const doc = {id: 'document0', revision: digest(text), sourceUrl: 'https://example.org/article', fetchedUrl: 'https://example.org/article',
  title: 'Anonymous fixture', publisher: null, publishedAt: null, retrievedAt: '2026-09-05T00:00:00.000Z',
  contentDigest: digest(text), digestBasis: 'NORMALIZED_TEXT_SHA256', normalizedText: text, upstreamRevisionId: null,
  normalizationVersion: 'public-source-text-v1', persistence: 'NOT_PERSISTED', metadataStatus: 'SOURCE_SUPPLIED_NOT_VERIFIED'};
const producer = createPublicExtractionProducer({authorize: async () => ({
  context: {sourceId: 'source0', ownerUserId: 'owner0', scopeId: 'scope0', batchId: 'batch0', sourcePolicyVersion: 'public-citation-review-v1', sharingDecisionId: null},
  graphVersion: '0', source: {enabled: true, origin: 'PUBLIC_SOURCE', provider: 'PUBLIC_ARTICLE'},
  documents: [{documentId: doc.id, documentRevision: doc.revision, privatePayloadRef: 'payload0', kind: 'PUBLIC_ARTICLE', independenceGroup: 'publisher0'}],
})});
const result = await producer.produce('anonymous-test-credential', {scopeId: 'scope0', expectedGraphVersion: '0', idempotencyKey: 'operation0'}, [doc]);
const request = result.stageRequest;
assert.deepEqual(validatePublicStage(request), request);
assert.equal(request.envelope.proposals.length, 5);
for (const mutate of [
  r => {r.envelope.citations[0].supportingExcerpt = 'Fabricated excerpt';},
  r => {r.envelope.citations[0].locator.start++;},
  r => {r.texts[0].normalizedText += ' Changed';},
  r => {r.envelope.proposals[0].subject.identityEvidenceIds = [r.envelope.citations.find(c => c.role === 'RELATIONSHIP').evidenceId];},
  r => {r.envelope.proposals[0].includeInSearch = true;},
  r => {r.envelope.proposals[0].reviewState = 'CONFIRMED';},
]) {
  const changed = structuredClone(request); mutate(changed); assert.throws(() => validatePublicStage(changed));
}
console.log('PASS: actual producer output accepted; six excerpt/digest/identity/search/review mutations rejected. No database used.');
