import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {extractPublicDocument, extractPublicClaimFragments, createPublicExtractionProducer} from '../dist/packages/server/discovery/extraction/index.js';
import {selectDocumentExcerpt, normalizePublicContent} from '../dist/packages/server/discovery/document-fetch.js';
import {normalizeImportShape} from '../dist/contracts/validation.js';

const digest = value => createHash('sha256').update(value).digest('hex');
function document(text, overrides = {}) {
  const sourceUrl = 'https://example.org/article';
  return {id: `doc_${digest(sourceUrl)}`, revision: digest(text), sourceUrl, fetchedUrl: sourceUrl,
    title: 'Anonymous test article', publisher: null, publishedAt: null, retrievedAt: '2026-09-05T00:00:00.000Z',
    contentDigest: digest(text), digestBasis: 'NORMALIZED_TEXT_SHA256', normalizedText: text,
    upstreamRevisionId: null, normalizationVersion: 'public-source-text-v1', persistence: 'NOT_PERSISTED',
    metadataStatus: 'SOURCE_SUPPLIED_NOT_VERIFIED', ...overrides};
}
const request = {scopeId: 'scope0', expectedGraphVersion: '0', idempotencyKey: 'operation0'};
function authority(docs) {
  return {context: {sourceId: 'source0', ownerUserId: 'owner0', scopeId: 'scope0', batchId: 'batch0', sourcePolicyVersion: 'public-citation-review-v1', sharingDecisionId: null},
    graphVersion: '0', source: {enabled: true, origin: 'PUBLIC_SOURCE', provider: 'PUBLIC_ARTICLE'},
    documents: docs.map((d, i) => ({documentId: d.id, documentRevision: d.revision, privatePayloadRef: `payload${i}`, kind: 'PUBLIC_ARTICLE', independenceGroup: 'publisher0'}))};
}
const producer = overrides => createPublicExtractionProducer({authorize: async (_credential, _request, docs) => authority(docs), ...overrides});
const produce = text => producer().produce('opaque-session', request, [document(text)]);

test('offline complete assertions discover distinct people and exact UTF-16 citations', () => {
  const doc = document('😀 Intro. Person Alpha is a friend of Person Beta. Person Gamma is the parent of Person Delta.');
  const result = extractPublicDocument(doc);
  assert.equal(result.assertions.length, 2); assert.equal(result.mentions.length, 4);
  assert.deepEqual(result.assertions.map(a => a.relationshipKind), ['FRIEND', 'PARENT_OF']);
  for (const item of [...result.mentions, ...result.assertions]) {
    assert.equal(doc.normalizedText.slice(item.excerpt.locator.start, item.excerpt.locator.end), item.excerpt.supportingExcerpt);
    assert.equal(item.excerpt.documentRevision, doc.revision); assert.equal(item.excerpt.contentDigest, doc.contentDigest);
  }
  assert.equal(result.mentions[0].name, 'Person Alpha'); assert.equal(result.mentions[1].name, 'Person Beta');
  assert.equal(result.assertions[1].subjectMentionId, result.mentions[2].id);
  assert.equal(result.assertions[1].objectMentionId, result.mentions[3].id);
});

test('negation, qualifications, speculation, quotes and fictional context abstain', () => {
  for (const text of [
    'Person Alpha is not a friend of Person Beta.', 'Person Alpha might be a friend of Person Beta.',
    'Person Alpha is a friend of Person Beta, allegedly.', 'If Person Alpha is a friend of Person Beta.',
    'Person Alpha denied this. Person Alpha is a friend of Person Beta.',
    'A fictional account. Person Alpha is a friend of Person Beta.',
    '“Person Alpha is a friend of Person Beta.”', 'Someone said "Person Alpha is a friend of Person Beta."',
    'The claim was false. Person Alpha is a friend of Person Beta.',
    'Is this statement true? Person Alpha is a friend of Person Beta.',
  ]) assert.equal(extractPublicDocument(document(text)).assertions.length, 0, text);
});

test('co-mentions, follows, shared employment, pronouns, slugs and unsupported direction do not become relationships', () => {
  for (const text of [
    'Person Alpha and Person Beta attended Event Alpha.', 'Person Alpha follows Person Beta.',
    'Person Alpha and Person Beta work at Organization Alpha.', 'Person Alpha knows Person Beta.',
    'Person Alpha met Person Beta.', 'She is a friend of Person Beta.',
    'https://www.linkedin.com/in/person-alpha/ https://www.instagram.com/person-beta/',
    'Person Alpha is willing to introduce Person Beta.', 'Person Alpha is a friend of Person Beta and Person Gamma.',
    'The biography says Person Alpha is a friend of Person Beta.',
  ]) assert.equal(extractPublicDocument(document(text)).assertions.length, 0, text);
});

test('affiliations remain context and unknown dates are not replaced with publication or fetch time', async () => {
  const out = await produce('Person Alpha works at Organization Alpha. Person Beta worked at Organization Alpha.');
  const e = out.stageRequest.envelope;
  assert.equal(e.proposals.filter(p => p.kind === 'RELATIONSHIP').length, 0);
  const affiliations = e.proposals.filter(p => p.kind === 'AFFILIATION'); assert.equal(affiliations.length, 2);
  assert.deepEqual(affiliations.map(p => p.current), [true, null]);
  for (const p of affiliations) {assert.deepEqual(p.assertedPeriod, {start: null, end: null}); assert.equal(p.object, null); assert.equal(p.relationshipKind, null);}
  assert.equal(out.extractions[0].assertions[0].organization.name, 'Organization Alpha');
  assert.equal(out.organizationMentions[0].organizationRef, affiliations[0].organizationRef);
  assert.equal(out.organizationMentions[0].name, 'Organization Alpha');
  const dated = extractPublicDocument(document('Person Alpha is a friend of Person Beta.', {publishedAt: {value: '2019', precision: 'YEAR'}}));
  assert.deepEqual(dated.assertions[0].assertedPeriod, {start: null, end: null});
  assert.equal(extractPublicDocument(document('Person Alpha worked at Organization Alpha from 2019 to 2020.')).assertions.length, 0);
});

test('identical names never silently unify endpoints or documents', async () => {
  const out = await produce('Person Alpha is a friend of Person Beta. Person Alpha is a close friend of Person Gamma.');
  const ps = out.stageRequest.envelope.proposals.filter(p => p.kind === 'RELATIONSHIP');
  assert.equal(ps[0].subject.mention, ps[1].subject.mention);
  assert.notDeepEqual(ps[0].subject.sourceIdentity, ps[1].subject.sourceIdentity);
  assert.equal(ps[0].subject.personId, null); assert.equal(ps[1].subject.personId, null);
  const repeated = extractPublicDocument(document('Person Alpha is a friend of Person Alpha.'));
  assert.equal(repeated.assertions.length, 0); assert.deepEqual(repeated.issues, ['REPEATED_ENDPOINT_NAME']);
});

test('producer is compatible with normalized import schema but produces no graph entities', async () => {
  const out = await produce('Person Alpha worked directly with Person Beta.');
  assert.equal(out.status, 'READY_TO_STAGE'); assert.equal(out.persistence, 'NOT_PERSISTED');
  const {envelope: e, texts} = out.stageRequest;
  normalizeImportShape(e.normalized);
  for (const field of ['people','relationships','observedLinks','affiliations']) assert.deepEqual(e.normalized.batch[field], []);
  assert.deepEqual(e.normalized.facts, []);
  assert.equal(texts[0].normalizedText, 'Person Alpha worked directly with Person Beta.');
  for (const p of e.proposals) {
    assert.equal(p.reviewState, 'PENDING'); assert.equal(p.reviewDecisionId, null); assert.equal(p.includeInSearch, false);
    assert.deepEqual(p.confidence, {value: null, meaning: 'HEURISTIC_EVIDENCE_SUPPORT', policyVersion: null});
    assert.equal(p.subject.identityState, 'UNRESOLVED'); assert.equal(p.subject.resolutionDecisionId, null);
    for (const ep of [p.subject, ...(p.object ? [p.object] : [])]) {
      for (const id of ep.identityEvidenceIds) {
        const c = e.citations.find(c => c.evidenceId === id); assert.equal(c.role, 'IDENTITY'); assert.equal(c.supportingExcerpt, ep.mention);
      }
    }
    for (const id of p.citationIds) assert.equal(e.citations.find(c => c.id === id).role, p.kind);
  }
  assert.equal(e.proposals.filter(p => p.kind === 'IDENTITY').length, 2);
  assert.ok(e.proposals.filter(p => p.kind === 'IDENTITY').every(p => p.support === 'CONTEXT_ONLY'));
  assert.ok(e.normalized.batch.evidence.every(e => e.confidence === 0));
  assert.equal(new Set(e.citations.map(c => c.evidenceId)).size, 3);
});

test('unchanged retrieval is stable; changed content and metadata get fresh immutable citation/proposal revisions', async () => {
  const doc = document('Person Alpha is a friend of Person Beta.');
  const a = await producer().produce('session', request, [doc]);
  const b = await producer().produce('session', request, [structuredClone(doc)]);
  assert.deepEqual(a, b);
  const c = await producer().produce('session', request, [document('Person Alpha is a close friend of Person Beta.')]);
  assert.notEqual(a.stageRequest.envelope.citations[0].id, c.stageRequest.envelope.citations[0].id);
  const d = await producer().produce('session', request, [{...doc, revision: 'metadata-revision', publishedAt: {value: '2020', precision: 'YEAR'}}]);
  assert.notEqual(a.stageRequest.envelope.citations[0].id, d.stageRequest.envelope.citations[0].id);
  assert.notEqual(a.stageRequest.envelope.proposals[0].revision, d.stageRequest.envelope.proposals[0].revision);
});

test('invalid digest, excerpt ranges and calendar values fail closed', async () => {
  const doc = document('Person Alpha is a friend of Person Beta.');
  for (const broken of [{...doc, normalizedText: 'Different'}, {...doc, digestBasis: 'RAW_HTML'}, {...doc, revision: ''}, {...doc, publishedAt: {value: '2020-02-31', precision: 'DAY'}}]) {
    assert.throws(() => extractPublicDocument(broken), e => e.code === 'INVALID_INPUT');
    await assert.rejects(producer().produce('session', request, [broken]), e => e.code === 'INVALID_INPUT');
  }
  for (const [start, end] of [[-1, 3], [0, 1000], [4, 4], [0.5, 4]]) assert.throws(() => selectDocumentExcerpt(doc, start, end));
});

test('unsupported pages produce explicit non-stageable results, never fake success', async () => {
  const out = await produce('People discussed an organization.');
  assert.equal(out.status, 'NO_SUPPORTED_ASSERTIONS'); assert.equal(out.stageRequest, null);
  assert.deepEqual(out.extractions[0].assertions, []); assert.deepEqual(out.extractions[0].issues, ['UNSUPPORTED_TEXT']);
});

test('bounded documents, assertions and sidecar sizes', async () => {
  const text = Array(40).fill('Person Alpha is a friend of Person Beta.').join(' ');
  const result = extractPublicDocument(document(text), 2);
  assert.equal(result.assertions.length, 2); assert.ok(result.issues.includes('ASSERTION_LIMIT'));
  const docs = Array.from({length: 5}, (_, i) => document(text, {id: `doc${i}`}));
  const out = await producer().produce('session', request, docs), e = out.stageRequest.envelope;
  assert.ok(e.proposals.length <= 50); assert.ok(e.citations.length <= 100); assert.equal(e.documents.length, 5);
  assert.ok(out.extractions.some(e => e.issues.includes('ASSERTION_LIMIT')));
  for (const docs of [[], Array(6).fill(document(text)), [document(text), document(text)], [document('a'.repeat(1024 * 1024 + 1))]])
    await assert.rejects(producer().produce('session', request, docs), e => e.code === 'INVALID_INPUT');
});

test('source authority is server-derived, private and provider-compatible', async () => {
  const docs = [document('Person Alpha is a friend of Person Beta.')];
  for (const alter of [a => a.context.scopeId = 'foreign', a => a.context.sharingDecisionId = 'sharing',
    a => a.context.sourcePolicyVersion = 'other-policy', a => a.source.enabled = false, a => a.source.provider = 'PUBLIC_PROFILE',
    a => a.documents[0].documentRevision = 'foreign', a => a.documents[0].privatePayloadRef = 'https://example.org/private']) {
    const p = producer({authorize: async () => {const a = authority(docs); alter(a); return a;}});
    await assert.rejects(p.produce('session', request, docs), e => e.code === 'FORBIDDEN');
  }
  await assert.rejects(producer().produce('session', {...request, ownerUserId: 'attacker'}, docs), e => e.code === 'INVALID_INPUT');
  const p = producer({authorize: async () => {throw new Error('sensitive port error');}});
  await assert.rejects(p.produce('session', request, docs), e => e.code === 'FORBIDDEN' && !e.message.includes('sensitive'));
});

test('scope revocation, changed authorization/version, cancellation and caller mutations are checked', async () => {
  const docs = [document('Person Alpha is a friend of Person Beta.')];
  for (const change of [a => a.graphVersion = '1', a => a.context.ownerUserId = 'another', a => a.documents[0].privatePayloadRef = 'changed']) {
    let calls = 0;
    const p = producer({authorize: async () => {const a = authority(docs); if (++calls > 1) change(a); return a;}});
    await assert.rejects(p.produce('session', request, docs), e => e.code === 'VERSION_CONFLICT');
  }
  const c = new AbortController();
  const pending = producer({authorize: async () => new Promise(() => {})}).produce('session', request, docs, c.signal);
  c.abort(); await assert.rejects(pending, e => e.code === 'CANCELLED');
  const p = producer({authorize: async (_credential, req, received) => {
    const a = authority(received); req.scopeId = 'tampered'; received[0].normalizedText = 'tampered'; return a;
  }});
  assert.equal((await p.produce('session', request, docs)).stageRequest.texts[0].normalizedText, docs[0].normalizedText);
});

test('normalizer removed scripts/JSON-LD are never treated as available structured evidence', () => {
  const normalized = normalizePublicContent('<script type="application/ld+json">{"name":"Person Alpha","knows":"Person Beta"}</script><p>Public article.</p>', true);
  assert.equal(normalized.text, 'Public article.'); assert.equal(extractPublicDocument(document(normalized.text)).assertions.length, 0);
});

test('pure planner fragment port exposes the same unresolved claims with exact distinct citation roles', () => {
  const doc = document('Person Alpha worked directly with Person Beta.');
  const fragments = extractPublicClaimFragments(doc);
  assert.equal(fragments.proposals.length, 3); assert.equal(fragments.citations.length, 3);
  const p = fragments.proposals.find(p => p.kind === 'RELATIONSHIP');
  assert.equal(p.relationshipKind, 'UNKNOWN'); assert.equal(p.predicate, 'WORKED_DIRECTLY_WITH');
  assert.equal(p.subject.identityState, 'UNRESOLVED'); assert.equal(p.object.identityState, 'UNRESOLVED');
  assert.equal(p.support, 'DIRECT_EXPLICIT'); assert.equal(p.includeInSearch, false);
  const c = fragments.citations.find(c => c.id === p.citationIds[0]); assert.equal(c.role, 'RELATIONSHIP');
  assert.equal(c.supportingExcerpt, doc.normalizedText);
  assert.deepEqual(extractPublicClaimFragments(doc), fragments);
  for (const [phrase, kind] of [['is a coworker of','COWORKER'], ['is a former coworker of','FORMER_COWORKER']]) {
    const result = extractPublicClaimFragments(document(`Person Alpha ${phrase} Person Beta.`));
    const claims = result.proposals.filter(p => p.kind === 'RELATIONSHIP');
    assert.equal(claims.length, 1); assert.equal(claims[0].relationshipKind, kind);
    assert.equal(claims[0].subject.mention, 'Person Alpha'); assert.equal(claims[0].object.mention, 'Person Beta');
  }
});
