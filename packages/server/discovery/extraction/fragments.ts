import type {ClaimEndpoint, PublicCitation, PublicClaimProposal} from '../contracts.js';
import type {RetrievedPublicDocument} from '../document-fetch.js';
import {EXTRACTION_VERSION, extractPublicDocument, hash, type DocumentExtraction} from './extractor.js';

export interface PublicClaimFragments {
  citations: PublicCitation[]; proposals: PublicClaimProposal[]; extraction: DocumentExtraction;
  /** Not part of PublicSourceEnvelope and not durably resolved organizations. */
  organizationMentions: Array<{organizationRef: string; name: string; documentId: string; documentRevision: string; citationId: string}>;
}
/** Internal common builder: source-scoped in producer, document-local in the pure planner port. */
export function buildPublicClaimFragments(doc: RetrievedPublicDocument, extracted: DocumentExtraction,
  scoped: (prefix: string, value: unknown) => string): PublicClaimFragments {
  const citations: PublicCitation[] = [], proposals: PublicClaimProposal[] = [];
  const organizationMentions: PublicClaimFragments['organizationMentions'] = [];
  const citation = (role: PublicCitation['role'], excerpt: DocumentExtraction['mentions'][number]['excerpt']): PublicCitation => {
    const key = [doc.id, doc.revision, doc.contentDigest, role, excerpt.locator, excerpt.supportingExcerpt];
    const result: PublicCitation = {id: scoped('citation', key), evidenceId: scoped('evidence', key), documentId: doc.id,
      documentRevision: doc.revision, role, supportingExcerpt: excerpt.supportingExcerpt, locator: excerpt.locator, statementId: null};
    citations.push(result);
    return result;
  };
  const proposal = (key: string, fields: Pick<PublicClaimProposal,'kind'|'subject'|'object'|'organizationRef'|'predicate'|'relationshipKind'|'citationIds'|'assertedPeriod'|'current'|'support'>) => {
    const factKey = scoped('fact', key);
    const item: PublicClaimProposal = {id: scoped('proposal', key), revision: hash([EXTRACTION_VERSION, doc.revision, fields]), factKey,
      basis: 'PUBLIC_SOURCE_CITATION', ...fields, confidence: {value: null, meaning: 'HEURISTIC_EVIDENCE_SUPPORT', policyVersion: null},
      extractionUncertainties: ['Person mentions are unresolved; names do not establish identity.', 'Source assertion is not independently verified; dates are unknown unless explicitly supplied.'],
      reviewState: 'PENDING', reviewDecisionId: null, includeInSearch: false};
    proposals.push(item);
  };
  const endpoints = new Map<string, ClaimEndpoint>();
  for (const mention of extracted.mentions) {
    const cite = citation('IDENTITY', mention.excerpt);
    const endpoint: ClaimEndpoint = {sourceIdentity: {platform: 'PUBLIC_DOCUMENT_MENTION', externalId: scoped('mention', mention.id)},
      mention: mention.name, identityState: 'UNRESOLVED', personId: null, resolutionRevision: scoped('resolution', mention),
      resolutionDecisionId: null, identityEvidenceIds: [cite.evidenceId]};
    endpoints.set(mention.id, endpoint);
    proposal(mention.id, {kind: 'IDENTITY', subject: endpoint, object: null, organizationRef: null, predicate: 'SOURCE_PERSON_MENTION',
      relationshipKind: null, citationIds: [cite.id], assertedPeriod: null, current: null, support: 'CONTEXT_ONLY'});
  }
  for (const assertion of extracted.assertions) {
    const cite = citation(assertion.kind, assertion.excerpt);
    if (assertion.organization) organizationMentions.push({organizationRef: scoped('organization', assertion.organization.id),
      name: assertion.organization.name, documentId: doc.id, documentRevision: doc.revision, citationId: cite.id});
    proposal(assertion.id, {kind: assertion.kind, subject: endpoints.get(assertion.subjectMentionId)!,
      object: assertion.objectMentionId ? endpoints.get(assertion.objectMentionId)! : null,
      organizationRef: assertion.organization ? scoped('organization', assertion.organization.id) : null,
      predicate: assertion.predicate, relationshipKind: assertion.relationshipKind, citationIds: [cite.id],
      assertedPeriod: assertion.assertedPeriod, current: assertion.current, support: 'DIRECT_EXPLICIT'});
  }
  return {citations, proposals, extraction: extracted, organizationMentions};
}
/** Pure query-hint port. Its proposals are unverified, unresolved and never graph edges.
 * The private producer reruns the same builder under source authority before staging. */
export function extractPublicClaimFragments(document: RetrievedPublicDocument, maxAssertions = 10): PublicClaimFragments {
  return buildPublicClaimFragments(document, extractPublicDocument(document, maxAssertions),
    (prefix, value) => `${prefix}_${hash([document.id, value])}`);
}
