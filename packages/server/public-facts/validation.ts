import {createHash} from 'node:crypto';
import type {ClaimEndpoint, DateValue, PublicSourceEnvelope} from '../discovery/contracts.js';
import {publicUrl} from '../discovery/contracts.js';
import * as s from '../../../contracts/schema.js';
import {normalizeImportShape} from '../../../contracts/validation.js';
import {canonicalJson} from '../../../contracts/canonical.js';
import {factDigest} from '../facts/projection.js';
import type {StagePublicFactsRequest} from './contracts.js';

const require = (ok: unknown, rule: string) => {if (!ok) s.fail('$', rule);};
const text = (max: number): s.Check => (v, p) => {s.string(v, p); if ((v as string).length > max) s.fail(p, 'bounded text');};
const nullableText = s.nullable(text(2000));
const url: s.Check = (v, p) => {try {publicUrl(v);} catch {s.fail(p, 'public URL');}};
const dateValue: s.Check = (v, p) => {
  s.object({value: text(30), precision: s.literal('YEAR', 'MONTH', 'DAY', 'SECOND')})(v, p);
  const d = v as DateValue;
  if (d.precision === 'SECOND') {s.date(d.value, p); return;}
  const re = d.precision === 'YEAR' ? /^\d{4}$/ : d.precision === 'MONTH' ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/;
  require(re.test(d.value), 'date precision');
  const iso = d.value + (d.precision === 'YEAR' ? '-01-01' : d.precision === 'MONTH' ? '-01' : '') + 'T00:00:00.000Z';
  s.date(iso, p);
};
const endpoint = s.object({sourceIdentity: s.object({platform: text(100), externalId: text(500)}), mention: text(200),
  identityState: s.literal('OWNER_ASSERTED_ANCHOR', 'UNRESOLVED'), personId: s.literal(null),
  resolutionRevision: s.id, resolutionDecisionId: s.literal(null), identityEvidenceIds: s.array(s.id, 1, 20)});
const document = s.object({id: s.id, revision: s.id, sourceId: s.id, kind: s.literal('PUBLIC_PROFILE', 'PUBLIC_ARTICLE', 'WIKIMEDIA_PAGE', 'WIKIDATA_ENTITY'),
  sourceUrl: url, fetchedUrl: url, title: text(500), publisher: nullableText, publishedAt: s.nullable(dateValue), retrievedAt: s.date,
  contentDigest: s.id, digestBasis: s.literal('NORMALIZED_TEXT_SHA256'), privatePayloadRef: s.id, upstreamRevisionId: s.nullable(s.id),
  independenceGroup: s.id, originalSourceUrls: s.array(url, 0, 20)});
const citation = s.object({id: s.id, evidenceId: s.id, documentId: s.id, documentRevision: s.id,
  role: s.literal('IDENTITY', 'RELATIONSHIP', 'AFFILIATION'), supportingExcerpt: text(2000),
  locator: s.object({start: s.integer, end: s.integer, section: nullableText}), statementId: s.nullable(s.id)});
const proposal = s.object({id: s.id, revision: s.id, factKey: s.id, basis: s.literal('PUBLIC_SOURCE_CITATION'),
  kind: s.literal('IDENTITY', 'RELATIONSHIP', 'AFFILIATION'), subject: endpoint, object: s.nullable(endpoint), organizationRef: s.nullable(s.id),
  predicate: text(500), relationshipKind: s.nullable(s.relationshipKind), citationIds: s.array(s.id, 1, 20),
  assertedPeriod: s.nullable(s.object({start: s.nullable(dateValue), end: s.nullable(dateValue)})), current: s.nullable(s.boolean),
  support: s.literal('DIRECT_EXPLICIT', 'CORROBORATED_DIRECT', 'CONTEXT_ONLY', 'AMBIGUOUS'),
  confidence: s.object({value: s.nullable(s.score), meaning: s.literal('HEURISTIC_EVIDENCE_SUPPORT'), policyVersion: s.nullable(s.id)}),
  extractionUncertainties: s.array(text(500), 0, 20), reviewState: s.literal('PENDING'), reviewDecisionId: s.literal(null), includeInSearch: s.literal(false)});

export function endpointId(scopeId: string, sourceId: string, value: ClaimEndpoint): string {
  return factDigest([scopeId, sourceId, value.sourceIdentity]);
}
export function endpointRevision(envelope: PublicSourceEnvelope, value: ClaimEndpoint): string {
  const citations = envelope.citations.filter(c => value.identityEvidenceIds.includes(c.evidenceId)).sort((a, b) => a.id < b.id ? -1 : 1);
  return factDigest({value, citations, documents: envelope.documents.filter(d => citations.some(c => c.documentId === d.id)).sort((a, b) => a.id < b.id ? -1 : 1)});
}
/** Bounded sidecar-only staging. No numeric defaults or unreviewed normalized graph candidates. */
export function validatePublicStage(value: unknown): StagePublicFactsRequest {
  s.object({expectedGraphVersion: s.id, idempotencyKey: s.id,
    envelope: s.object({schemaVersion: s.literal(1), normalized: s.normalizedImport,
      documents: s.array(document, 1, 5), citations: s.array(citation, 1, 100), proposals: s.array(proposal, 1, 50)}),
    texts: s.array(s.object({documentId: s.id, documentRevision: s.id, normalizedText: text(1024 * 1024)}), 1, 5)})(value, '$');
  const request = structuredClone(value as StagePublicFactsRequest), e = request.envelope;
  e.normalized = normalizeImportShape(e.normalized);
  const n = e.normalized, b = n.batch;
  require(n.context.sharingDecisionId === null, 'private-only stage');
  require([b.people, b.relationships, b.observedLinks, b.affiliations, n.facts].every(a => a.length === 0), 'sidecar-only public proposals');
  const unique = (ids: string[]) => require(new Set(ids).size === ids.length, 'unique scoped identifiers');
  for (const records of [e.documents, e.citations, e.proposals, b.evidence, n.records]) unique(records.map(x => x.id));
  unique(e.proposals.map(p => p.factKey)); unique(request.texts.map(t => t.documentId)); unique(n.records.map(r => r.privatePayloadRef));
  require(request.texts.length === e.documents.length && n.records.length === e.documents.length, 'complete document storage');
  require(request.texts.reduce((sum, t) => sum + Buffer.byteLength(t.normalizedText), 0) <= 5 * 1024 * 1024, 'total text size');
  for (const d of e.documents) {
    require(d.sourceId === n.context.sourceId, 'document source');
    const t = request.texts.find(t => t.documentId === d.id && t.documentRevision === d.revision);
    require(t && Buffer.byteLength(t.normalizedText) <= 1024 * 1024, 'exact document revision text');
    require(createHash('sha256').update(t!.normalizedText, 'utf8').digest('hex') === d.contentDigest, 'document text digest');
    const record = n.records.find(r => r.privatePayloadRef === d.privatePayloadRef);
    require(record && record.contentDigest === d.contentDigest && record.sourceId === d.sourceId && record.retrievedAt === d.retrievedAt, 'document source-record binding');
  }
  unique(e.citations.map(c => c.evidenceId));
  require(b.evidence.length === e.citations.length, 'complete citation evidence');
  for (const c of e.citations) {
    const d = e.documents.find(d => d.id === c.documentId && d.revision === c.documentRevision), t = request.texts.find(t => t.documentId === c.documentId);
    require(d && t, 'citation document revision');
    require(c.locator.start < c.locator.end && t!.normalizedText.slice(c.locator.start, c.locator.end) === c.supportingExcerpt, 'exact citation quote');
    require(c.locator.end <= t!.normalizedText.length, 'citation range');
    const evidence = b.evidence.find(item => item.id === c.evidenceId);
    require(evidence && evidence.sourceId === d!.sourceId && evidence.claimKind === c.role, 'citation evidence role/source');
    const record = n.records.find(r => r.privatePayloadRef === d!.privatePayloadRef)!;
    require(n.evidenceRecords.some(er => er.evidenceId === c.evidenceId && er.sourceRecordId === record.id), 'citation record provenance');
  }
  const endpoints = new Map<string, string>();
  for (const p of e.proposals) {
    unique(p.citationIds);
    require(p.citationIds.every(id => e.citations.some(c => c.id === id && c.role === p.kind)), 'claim citations have claim role');
    require(p.kind === 'RELATIONSHIP' ? p.object !== null && p.organizationRef === null : p.object === null, 'claim endpoint shape');
    if (p.kind === 'RELATIONSHIP') require(canonicalJson(p.subject.sourceIdentity) !== canonicalJson(p.object!.sourceIdentity), 'distinct source endpoints');
    if (p.kind === 'AFFILIATION') require(p.organizationRef !== null && p.relationshipKind === null, 'affiliation organization');
    if (p.kind === 'IDENTITY') require(p.organizationRef === null && p.relationshipKind === null, 'identity fields');
    require(p.confidence.value === null || p.confidence.policyVersion !== null, 'assessed confidence policy');
    if (p.support === 'CORROBORATED_DIRECT') {
      const groups = new Set(p.citationIds.map(id => e.documents.find(d => d.id === e.citations.find(c => c.id === id)!.documentId)!.independenceGroup));
      require(groups.size >= 2, 'independent corroboration');
    }
    for (const ep of [p.subject, ...(p.object ? [p.object] : [])]) {
      unique(ep.identityEvidenceIds);
      require(ep.identityEvidenceIds.every(id => e.citations.some(c => c.evidenceId === id && c.role === 'IDENTITY')), 'endpoint identity citations');
      require(e.citations.some(c => ep.identityEvidenceIds.includes(c.evidenceId) && c.supportingExcerpt.includes(ep.mention)), 'source-quoted identity mention');
      const key = endpointId(n.context.scopeId, n.context.sourceId, ep), content = canonicalJson(ep);
      require(!endpoints.has(key) || endpoints.get(key) === content, 'consistent endpoint mention'); endpoints.set(key, content);
    }
  }
  return request;
}
