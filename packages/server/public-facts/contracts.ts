import type {ClaimEndpoint, PublicClaimProposal, PublicDocument, PublicSourceEnvelope} from '../discovery/contracts.js';
import type {GraphBuildEvent} from '../../../contracts/index.js';
import type {FactActor} from '../facts/contracts.js';
import * as s from '../../../contracts/schema.js';

/** Server-only input from the authorized source/extraction composition, never an HTTP body. */
export interface StagePublicFactsRequest {
  expectedGraphVersion: string; idempotencyKey: string; envelope: PublicSourceEnvelope;
  texts: Array<{documentId: string; documentRevision: string; normalizedText: string}>;
}
export interface StagePublicFactsResponse {batchId: string; scopeId: string; graphVersion: string; duplicate: boolean; status: 'PENDING_REVIEW'}
export interface ReviewPublicFactsRequest {scopeId: string; batchId: string}
export interface EndpointView {
  endpointId: string; endpointRevision: string; endpoint: ClaimEndpoint;
  latestResolutionDecisionId: string | null;
  resolution: {decisionId: string; personId: string} | null;
  current: boolean;
}
export interface ReviewPublicFactsResponse {
  scopeId: string; graphVersion: string; batchId: string;
  documents: Array<Omit<PublicDocument, 'privatePayloadRef'>>;
  citations: PublicSourceEnvelope['citations']; proposals: PublicClaimProposal[];
  endpoints: EndpointView[]; warnings: string[];
}
export type ResolvePublicIdentityRequest = {
  scopeId: string; expectedGraphVersion: string; idempotencyKey: string; confirm: true;
  endpointId: string; expectedEndpointRevision: string; expectedResolutionDecisionId: string | null;
} & ({disposition: 'NEW_PERSON'} | {disposition: 'LINK_EXISTING'; personId: string});
export interface ResolvePublicIdentityResponse {
  scopeId: string; baseGraphVersion: string; graphVersion: string; decisionId: string;
  endpointId: string; endpointRevision: string; personId: string; identityId: string;
  duplicate: boolean; events: GraphBuildEvent[];
}
export interface PublicFactsStore {
  stage(actor: FactActor, request: StagePublicFactsRequest): Promise<StagePublicFactsResponse>;
  review(actor: FactActor, request: ReviewPublicFactsRequest): Promise<ReviewPublicFactsResponse>;
  resolve(actor: FactActor, request: ResolvePublicIdentityRequest): Promise<ResolvePublicIdentityResponse>;
}
export function validatePublicReview(value: unknown): ReviewPublicFactsRequest {
  s.object({scopeId: s.id, batchId: s.id})(value, '$'); return structuredClone(value as ReviewPublicFactsRequest);
}
export function validatePublicResolution(value: unknown): ResolvePublicIdentityRequest {
  const disposition = (value as {disposition?: unknown} | null)?.disposition;
  s.object({scopeId: s.id, expectedGraphVersion: s.id, idempotencyKey: s.id, confirm: s.literal(true),
    endpointId: s.id, expectedEndpointRevision: s.id, expectedResolutionDecisionId: s.nullable(s.id),
    disposition: s.literal('NEW_PERSON', 'LINK_EXISTING'), ...(disposition === 'LINK_EXISTING' ? {personId: s.id} : {})})(value, '$');
  return structuredClone(value as ResolvePublicIdentityRequest);
}
