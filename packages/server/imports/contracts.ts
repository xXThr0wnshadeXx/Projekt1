import type { CandidateBatch, GraphBuildEvent } from '../../../contracts/index.js';

/** Accepted HTTP bodies: never accept actor IDs, root IDs, source context or an access token. */
export interface StartGoogleImportRequest {scopeId: string; sourceId: string; expectedGraphVersion: string; idempotencyKey: string}
export interface ReviewImportRequest {scopeId: string; jobId: string}
export interface ApproveGoogleImportRequest extends ReviewImportRequest {expectedGraphVersion: string; idempotencyKey: string; confirm: true}
export interface ImportStartResponse {jobId: string; scopeId: string; sourceId: string; status: 'PENDING_REVIEW' | 'OBSERVATIONS_APPROVED'; duplicate: boolean}
export interface ImportReviewResponse {
  jobId: string; scopeId: string; sourceId: string; graphVersion: string;
  status: 'PENDING_REVIEW' | 'OBSERVATIONS_APPROVED'; canApprove: boolean;
  people: Array<{candidateId: string; displayName: string; disposition: 'NEW_PERSON' | 'EXISTING_SOURCE_IDENTITY'; existingPersonId: string | null}>;
  observations: Array<{fromPersonId: string; toCandidateId: string; kind: 'CONTACT_SAVED'}>;
  affiliations: Array<{candidateId: string; organizationName: string; role?: string; current: boolean | null; state: 'PENDING'}>;
  counts: {people: number; newPeople: number; existingPeople: number; savedContactObservations: number; pendingAffiliations: number};
  warnings: string[];
}
export interface ImportApprovalResponse {jobId: string; graphVersion: string; duplicate: boolean; events: GraphBuildEvent[]}
/** Server-only injection owned by Shaw/integration. Retrieve real authorized provider records,
 * then call Shaw's normalizer. Pass only its CandidateBatch back; do not return raw token payloads.
 */
export type RetrieveAndNormalizeGoogleContacts = (input: {
  accessToken: string; sourceId: string; batchId: string; ownerPersonId: string; retrievedAt: string;
}) => Promise<CandidateBatch>;
export interface ContactsAccessPort {
  getFreshAccessToken(credential: unknown, sourceId: string): Promise<{accessToken: string; expiresAt: number; scopeId: string; sourceId: string}>;
}
