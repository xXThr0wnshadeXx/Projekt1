import type { Affiliation, Evidence, GraphBuildEvent, Relationship, SourceSummary } from '../../../contracts/index.js';
import * as s from '../../../contracts/schema.js';

export interface RelationshipConfirmation {
  kind: Relationship['kind']; strength: number; statement: string; includeInSearch: boolean;
}
export type FactChange =
  | {type: 'RELATIONSHIP'; relationshipId: string; decision: 'ACCEPT'; confirmation: RelationshipConfirmation}
  | {type: 'RELATIONSHIP'; relationshipId: string; decision: 'REJECT'}
  | {type: 'RELATIONSHIP_FROM_OBSERVATION'; observedLinkId: string; decision: 'ACCEPT'; confirmation: RelationshipConfirmation}
  | {type: 'AFFILIATION'; personId: string; affiliationKey: string; decision: 'ACCEPT'; current: boolean | null; statement: string}
  | {type: 'AFFILIATION'; personId: string; affiliationKey: string; decision: 'REJECT'};
export interface FactReviewRequest {scopeId: string}
export interface ConfirmFactsRequest extends FactReviewRequest {
  expectedGraphVersion: string; idempotencyKey: string; confirm: true; change: FactChange;
}
export interface FactReviewResponse {
  scopeId: string; graphVersion: string;
  relationships: Relationship[];
  affiliations: Array<{personId: string; affiliationKey: string; claim: Affiliation}>;
  evidence: Evidence[]; sources: SourceSummary[]; warnings: string[];
}
export interface ConfirmFactsResponse {
  schemaVersion: 1; scopeId: string; baseGraphVersion: string; graphVersion: string; decisionId: string; duplicate: boolean; events: GraphBuildEvent[];
}
/** Server-only binding. Derive sessionHash from the opaque session credential, never an HTTP body. */
export interface FactActor {userId: string; sessionHash: string}
export interface FactStore {
  review(actor: FactActor, request: FactReviewRequest): Promise<FactReviewResponse>;
  confirm(actor: FactActor, request: ConfirmFactsRequest): Promise<ConfirmFactsResponse>;
}

const statement: s.Check = (value, path) => {s.string(value, path); if ((value as string).length > 2000) s.fail(path, 'bounded statement');};
const confirmation = s.object({kind: s.relationshipKind, strength: s.score, statement, includeInSearch: s.boolean});
const change: s.Check = (value, path) => {
  const {type, decision} = (value ?? {}) as {type?: unknown; decision?: unknown};
  const accept = decision === 'ACCEPT';
  if (type === 'RELATIONSHIP') s.object({type: s.literal(type), relationshipId: s.id, decision: s.literal('ACCEPT', 'REJECT'), ...(accept ? {confirmation} : {})})(value, path);
  else if (type === 'RELATIONSHIP_FROM_OBSERVATION') s.object({type: s.literal(type), observedLinkId: s.id, decision: s.literal('ACCEPT'), confirmation})(value, path);
  else s.object({type: s.literal('AFFILIATION'), personId: s.id, affiliationKey: s.id, decision: s.literal('ACCEPT', 'REJECT'), ...(accept ? {current: s.nullable(s.boolean), statement} : {})})(value, path);
};
export function validateFactReview(value: unknown): FactReviewRequest {
  s.object({scopeId: s.id})(value, '$'); return structuredClone(value as FactReviewRequest);
}
export function validateConfirmFacts(value: unknown): ConfirmFactsRequest {
  s.object({scopeId: s.id, expectedGraphVersion: s.id, idempotencyKey: s.id, confirm: s.literal(true), change})(value, '$');
  return structuredClone(value as ConfirmFactsRequest);
}
