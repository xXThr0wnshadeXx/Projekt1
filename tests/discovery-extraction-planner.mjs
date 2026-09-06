// Actual cross-owner seam regression. Pass the built immutable planner index.js path as argv[2].
// No network/database: provider/document ports use anonymous injected fixtures.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {extractPublicClaimFragments} from '../dist/packages/server/discovery/extraction/index.js';
if (!process.argv[2]) throw new Error('Pass the immutable built discovery/planning/index.js path');
const {createDiscoveryPlanner} = await import(pathToFileURL(process.argv[2]).href);
const hash = value => createHash('sha256').update(value).digest('hex');
const document = (url, text) => ({id: hash(url), revision: hash(text), sourceUrl: url, fetchedUrl: url, title: 'Anonymous article',
  publisher: null, publishedAt: null, retrievedAt: '2026-09-05T00:00:00.000Z', contentDigest: hash(text),
  digestBasis: 'NORMALIZED_TEXT_SHA256', normalizedText: text, upstreamRevisionId: null, normalizationVersion: 'public-source-text-v1',
  persistence: 'NOT_PERSISTED', metadataStatus: 'SOURCE_SUPPLIED_NOT_VERIFIED'});
const input = {request: {scopeId: 'scope0', expectedGraphVersion: '0', idempotencyKey: 'operation0',
  anchors: {linkedinUrl: 'https://www.linkedin.com/in/anonymous/', instagramUrl: 'https://www.instagram.com/anonymous/'},
  target: {organizationName: 'Organization Alpha'}}, authority: {scopeId: 'scope0', graphVersion: '0', selectedContexts: []}};
async function collect(text) {
  const queries = [];
  const planner = createDiscoveryPlanner({provider: {kind: 'TAVILY', configured: true, search: async query => {
    queries.push(query);
    return [{url: queries.length <= 2 ? 'https://example.org/initial' : 'https://example.org/expanded', title: 'Anonymous',
      snippet: 'Discovery hint', provider: 'TAVILY', evidenceStatus: 'DISCOVERY_HINT'}];
  }}, documents: {fetch: async url => document(url, text)}, extraction: {extract: async doc => extractPublicClaimFragments(doc)}});
  return planner.collect(input);
}
const denied = [
  "Person Alpha is a friend of Person Beta. This isn't true.",
  "Person Alpha is a friend of Person Beta. They aren't friends.",
  'Person Alpha is a friend of Person Beta. They aren’t friends.',
  "Person Alpha works at Organization Alpha. This isn't true.",
  'Person Alpha is a friend of Person Beta. This is not true.',
  'Person Alpha is not a friend of Person Beta.',
];
for (const text of denied) {
  const fragments = extractPublicClaimFragments(document('https://example.org/denial', text));
  assert.equal(fragments.proposals.filter(p => p.support === 'DIRECT_EXPLICIT').length, 0, text);
  const out = await collect(text);
  assert.equal(out.queries.filter(query => query.frontier === 'EXPANSION').length, 0, text);
  assert.equal(out.candidates.length, 0, text);
  assert.ok(out.extractions.every(item => item.output.proposals.length === 0), text);
  assert.equal(out.status, 'INSUFFICIENT_PUBLIC_EVIDENCE', text);
  for (const doc of out.documents) {assert.equal(doc.normalizedText, text); assert.equal(doc.contentDigest, hash(text));}
}
const positive = await collect('Person Alpha is a friend of Person Beta.');
assert.equal(positive.queries.filter(query => query.frontier === 'EXPANSION').length, 2);
assert.equal(positive.candidates.length, 4);
for (const result of positive.extractions) for (const proposal of result.output.proposals) {
  assert.equal(proposal.subject.identityState, 'UNRESOLVED'); assert.equal(proposal.subject.personId, null);
  assert.equal(proposal.reviewState, 'PENDING'); assert.equal(proposal.includeInSearch, false); assert.equal(proposal.confidence.value, null);
}
for (const doc of positive.documents) for (const cite of positive.extractions.find(item => item.documentId === doc.id).output.citations)
  assert.equal(doc.normalizedText.slice(cite.locator.start, cite.locator.end), cite.supportingExcerpt);
console.log('PASS: actual planner seam rejects four contracted denials and two uncontracted controls; positive control retains two expansions with exact citations and unresolved claims.');
