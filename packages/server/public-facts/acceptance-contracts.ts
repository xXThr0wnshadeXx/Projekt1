import type {PublicCitation, PublicClaimProposal, PublicDocument} from '../discovery/contracts.js';
import type {GraphBuildEvent} from '../../../contracts/index.js';
import * as s from '../../../contracts/schema.js';

export interface PublicEndpointBinding {endpointId: string; endpointRevision: string; resolutionDecisionId: string}
export interface PublicRelationshipBindings {subject: PublicEndpointBinding; object: PublicEndpointBinding}
export type PublicClaimDecision = {sourceId: string; proposalId: string; proposalRevision: string} & (
  {decision: 'ACCEPT'; includeInSearch: boolean; bindings: PublicRelationshipBindings; relativeStrength?: number}
  | {decision: 'REJECT'}
);
export interface PublicClaimReviewRequest {
  scopeId: string; expectedGraphVersion: string; idempotencyKey: string; confirm: true; decisions: PublicClaimDecision[];
}
export interface PublicClaimReviewResponse {
  scopeId: string; baseGraphVersion: string; graphVersion: string; reviewId: string; duplicate: boolean;
  decisions: Array<{decisionId: string; sourceId: string; proposalId: string; proposalRevision: string;
    state: 'CONFIRMED' | 'REJECTED'; relationshipId: string | null; searchable: boolean}>;
  events: GraphBuildEvent[]; warnings: string[];
}
export interface PublicCitationAssessment {
  strength: number | null; confidence: number | null; recencyFactor: number | null; warnings: string[];
}
/** Trusted synchronous server policy; no default implementation or configured production weights. */
export interface PublicCitationPolicy {
  version: string;
  semantics: {strength: string; confidence: string; recency: string};
  assess(input: {proposal: PublicClaimProposal; citations: PublicCitation[]; documents: PublicDocument[];
    relativeStrength: number | null}): PublicCitationAssessment | null;
}
const binding = s.object({endpointId: s.id, endpointRevision: s.id, resolutionDecisionId: s.id});
const decision: s.Check = (v, p) => {
  const accept = (v as {decision?: unknown} | null)?.decision === 'ACCEPT';
  s.object({sourceId: s.id, proposalId: s.id, proposalRevision: s.id, decision: s.literal('ACCEPT', 'REJECT'),
    ...(accept ? {includeInSearch: s.boolean, bindings: s.object({subject: binding, object: binding}), relativeStrength: s.optional(s.score)} : {})})(v, p);
};
export function validatePublicClaimReview(value: unknown): PublicClaimReviewRequest {
  s.object({scopeId: s.id, expectedGraphVersion: s.id, idempotencyKey: s.id, confirm: s.literal(true), decisions: s.array(decision, 1, 10)})(value, '$');
  const request = structuredClone(value as PublicClaimReviewRequest);
  if (new Set(request.decisions.map(d => JSON.stringify([d.sourceId, d.proposalId]))).size !== request.decisions.length) s.fail('$', 'one decision per proposal');
  return request;
}
