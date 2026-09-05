import {DiscoveryError, normalizeProfileUrl, publicUrl, validateDiscoveryRequest, type PublicClaimProposal} from '../contracts.js';
import {selectDocumentExcerpt, type RetrievedPublicDocument} from '../document-fetch.js';
import type {ExploratoryCandidate, PlannedQuery, PlanningExtraction, PlanningInput} from './types.js';

/** Remove fragments/default ports and normalize supported social identifiers. Never drop
 * arbitrary query parameters or lowercase case-sensitive paths (distinct source URLs). */
export function canonicalPublicUrl(value: string): string {
  const url = publicUrl(value);
  if (/(^|\.)linkedin\.com$/.test(url.hostname)) return normalizeProfileUrl(value, 'linkedin');
  if (/(^|\.)instagram\.com$/.test(url.hostname)) return normalizeProfileUrl(value, 'instagram');
  return url.href;
}
export function canonicalQuery(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/g, ' ');
}
function literal(value: string): string {
  // Public text is a quoted search literal, not a way to inject search operators.
  return JSON.stringify(canonicalQuery(value).replace(/["\\]/g, ' '));
}
export function validatePlanningInput(input: PlanningInput): PlanningInput {
  const request = validateDiscoveryRequest(input.request), authority = structuredClone(input.authority);
  if (authority.scopeId !== request.scopeId) throw new DiscoveryError('FORBIDDEN');
  if (authority.graphVersion !== request.expectedGraphVersion) throw new DiscoveryError('VERSION_CONFLICT');
  const selected = new Set(request.selectedContextPersonIds ?? []);
  if (!Array.isArray(authority.selectedContexts) || authority.selectedContexts.length !== selected.size ||
    new Set(authority.selectedContexts.map(c => c.personId)).size !== selected.size ||
    authority.selectedContexts.some(c => !selected.has(c.personId) || !Array.isArray(c.publicTerms) || c.publicTerms.length > 2 ||
      c.publicTerms.some(t => typeof t !== 'string' || !t.trim() || t.length > 200 || /[\u0000-\u001f\u007f]/.test(t)))) {
    throw new DiscoveryError('FORBIDDEN');
  }
  return {request, authority};
}
export function targetTerms(input: PlanningInput): string {
  return [input.request.target.personName, input.request.target.organizationName, input.request.target.profileUrl]
    .filter((s): s is string => Boolean(s)).map(literal).join(' ');
}
export function initialQueries(input: PlanningInput): PlannedQuery[] {
  const target = targetTerms(input);
  return [input.request.anchors.linkedinUrl, input.request.anchors.instagramUrl].map(url => {
    const combined = `${literal(url)} ${target}`;
    return {query: combined.length <= 600 ? combined : literal(url), frontier: 'INITIAL', candidate: null};
  });
}
export function expansionQueries(input: PlanningInput, candidates: ExploratoryCandidate[]): PlannedQuery[] {
  return candidates.map(candidate => ({query: `${literal(candidate.profileUrl ?? candidate.mention)} ${targetTerms(input)}${candidate.publicContext ? ` ${literal(candidate.publicContext)}` : ''}`,
    frontier: 'EXPANSION', candidate}));
}
export function fallbackQueries(input: PlanningInput): PlannedQuery[] {
  const target = targetTerms(input);
  // Only explicitly selected, server-authorized PUBLIC terms. Never inspect a graph/Contacts record.
  return [...input.authority.selectedContexts.map(c => `${c.publicTerms.map(literal).join(' ')} ${target}`), target]
    .map(query => ({query, frontier: 'FALLBACK', candidate: null}));
}

/** Candidates are query hints only. A cited identity never creates or joins graph people.
 * Bare names/shared employers cannot seed expansion; source occurrences need an
 * attributed direct interpersonal assertion and exact separate identity citations. */
export function discoverExploratoryCandidates(document: RetrievedPublicDocument, extraction: PlanningExtraction): ExploratoryCandidate[] {
  const candidates: ExploratoryCandidate[] = [];
  for (const proposal of extraction.proposals) {
    if (!eligible(proposal)) continue;
    const subject = proposal.subject;
    let profileUrl: string;
    try {
      // Match the exact platform identifier; never reconstruct a name or a URL from a slug.
      profileUrl = normalizeProfileUrl(subject.sourceIdentity.externalId,
        subject.sourceIdentity.platform === 'linkedin' ? 'linkedin' : 'instagram');
    } catch {continue;}
    const supporting = extraction.citations.filter(c => proposal.citationIds.includes(c.id) &&
      c.role === 'IDENTITY' && subject.identityEvidenceIds.includes(c.evidenceId) &&
      c.documentId === document.id && c.documentRevision === document.revision);
    if (!supporting.length || new Set(extraction.citations.map(c => c.id)).size !== extraction.citations.length) continue;
    const grounded = supporting.filter(c => {
      try {
        const excerpt = selectDocumentExcerpt(document, c.locator.start, c.locator.end).supportingExcerpt;
        // Both the name and exact identifier must occur in the identity citation. Semantics
        // remain the extractor's responsibility; matching strings alone is not identity review.
        return excerpt === c.supportingExcerpt && excerpt.includes(subject.mention) &&
          excerpt.includes(subject.sourceIdentity.externalId);
      } catch {return false;}
    });
    if (!grounded.length) continue;
    candidates.push({profileUrl, mention: subject.mention, proposalId: proposal.id,
      sourceIdentity: {...subject.sourceIdentity}, publicContext:null, identityState:'UNRESOLVED',
      citationIds: grounded.map(c => c.id), documentId: document.id, documentRevision: document.revision,
      status: 'EXPLORATORY_ONLY'});
  }
  return [...candidates, ...assertionCandidates(document, extraction)];
}

// These describe ordinary review limitations, not ambiguous attribution. Unknown
// uncertainty text fails closed. Keep in sync with the exact extraction producer.
const reviewLimitations = new Set([
  'Person mentions are unresolved; names do not establish identity.',
  'Source assertion is not independently verified; dates are unknown unless explicitly supplied.',
]);
function assertionCandidates(document: RetrievedPublicDocument, extraction: PlanningExtraction): ExploratoryCandidate[] {
  const candidates: ExploratoryCandidate[] = [];
  const citations = extraction.citations.filter(c => {
    try {
      return c.documentId === document.id && c.documentRevision === document.revision &&
        selectDocumentExcerpt(document, c.locator.start, c.locator.end).supportingExcerpt === c.supportingExcerpt;
    } catch {return false;}
  });
  if (new Set(extraction.citations.map(c => c.id)).size !== extraction.citations.length) return [];
  for (const proposal of extraction.proposals) {
    if (proposal.kind !== 'RELATIONSHIP' || proposal.basis !== 'PUBLIC_SOURCE_CITATION' ||
      proposal.support !== 'DIRECT_EXPLICIT' || proposal.reviewState !== 'PENDING' ||
      proposal.reviewDecisionId !== null || proposal.includeInSearch !== false || !proposal.object ||
      proposal.extractionUncertainties.some(u => !reviewLimitations.has(u))) continue;
    const endpoints = [proposal.subject, proposal.object];
    if (endpoints.some(e => e.identityState !== 'UNRESOLVED' || e.personId !== null || e.resolutionDecisionId !== null ||
      e.sourceIdentity.platform !== 'PUBLIC_DOCUMENT_MENTION' || !e.sourceIdentity.externalId ||
      typeof e.mention !== 'string' || !e.mention.trim() || e.mention.length > 200 || /[\u0000-\u001f\u007f]/.test(e.mention)) ||
      proposal.subject.mention === proposal.object.mention ||
      proposal.subject.sourceIdentity.externalId === proposal.object.sourceIdentity.externalId) continue;
    const relationshipCite = citations.find(c => c.role === 'RELATIONSHIP' && proposal.citationIds.includes(c.id) &&
      endpoints.every(e => c.supportingExcerpt.includes(e.mention)));
    if (!relationshipCite) continue;
    const identityCites = endpoints.map(e => citations.find(c => c.role === 'IDENTITY' &&
      e.identityEvidenceIds.includes(c.evidenceId) && c.supportingExcerpt === e.mention &&
      c.locator.start >= relationshipCite.locator.start && c.locator.end <= relationshipCite.locator.end));
    if (identityCites.some(c => !c)) continue;
    for (const [index, endpoint] of endpoints.entries()) candidates.push({
      profileUrl:null, mention:endpoint.mention, sourceIdentity:{...endpoint.sourceIdentity},
      publicContext:relationshipCite.supportingExcerpt, identityState:'UNRESOLVED',
      proposalId:proposal.id, citationIds:[identityCites[index]!.id, relationshipCite.id],
      documentId:document.id, documentRevision:document.revision, status:'EXPLORATORY_ONLY',
    });
  }
  return candidates;
}
function eligible(p: PublicClaimProposal): boolean {
  return p.kind === 'IDENTITY' && p.basis === 'PUBLIC_SOURCE_CITATION' &&
    (p.support === 'DIRECT_EXPLICIT' || p.support === 'CORROBORATED_DIRECT') &&
    p.reviewState === 'PENDING' && p.reviewDecisionId === null && p.includeInSearch === false &&
    p.extractionUncertainties.length === 0 && p.object === null &&
    p.subject.identityState === 'UNRESOLVED' && p.subject.personId === null &&
    ['linkedin', 'instagram'].includes(p.subject.sourceIdentity.platform) &&
    typeof p.subject.mention === 'string' && p.subject.mention.trim().length > 0;
}
