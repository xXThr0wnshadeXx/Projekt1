/** Projekt1 contracts v1. Planning handoff: types only; runtime validators are Ben's first task.
 * No personal records or fictional demo graph are included. JSON wire format only.
 * All IDs are opaque. ISO times are UTC. Scores must be finite and in [0,1].
 */
export type Id = string;
export type ISODateTime = string;
export type UnitScore = number;
export type Version = string;
export type Origin = 'USER_PROVIDED' | 'AUTHORIZED_API' | 'PUBLIC_SOURCE';
export type ReviewState = 'PENDING' | 'CONFIRMED' | 'REJECTED';
export interface SnapshotKey { scopeId: Id; graphVersion: Version }
/** scopeId is authorized server-side for the authenticated actor. It is not an authorization token. */
export interface SourceSummary {
  id: Id; provider: 'GOOGLE_CONTACTS' | 'LINKEDIN_EXPORT' | 'INSTAGRAM_EXPORT' | 'MANUAL' | 'PUBLIC_PROFILE';
  label: string; origin: Origin; importedAt: ISODateTime;
}
/** Display-safe evidence only. Raw imports, email addresses and tokens are not part of graph responses. */
export interface Evidence {
  id: Id; sourceId: Id; summary: string; observedAt: ISODateTime;
  confidence: UnitScore; publicUrl?: string; claimKind: 'IDENTITY' | 'RELATIONSHIP' | 'AFFILIATION';
}
export interface SupportedValue<T> { value: T; confidence: UnitScore; evidenceIds: Id[]; state: ReviewState }
export interface Organization { id: Id; name: string; industry?: string }
export interface Affiliation { organizationId: Id; role?: string; current: boolean | null; support: SupportedValue<boolean> }
export interface Person {
  id: Id; displayName: string; aliases: string[]; identityIds: Id[];
  affiliations: Affiliation[]; location?: SupportedValue<string>;
  /** Projection-only confidence in accepted identity assignments; not confidence in all attributes. */
  identityConfidence: UnitScore; updatedAt: ISODateTime;
}
export interface Identity {
  id: Id; sourceId: Id; platform: string; externalId: string; displayName?: string;
  profileUrl?: string; personId: Id | null; assignmentState: ReviewState;
  evidenceIds: Id[]; updatedAt: ISODateTime;
}
/** An observable platform fact is not a friendship or an introduction promise. */
export interface ObservedLink {
  id: Id; fromPersonId: Id; toPersonId: Id;
  kind: 'CONTACT_SAVED' | 'FOLLOWS' | 'CONNECTED_ON_PLATFORM' | 'CO_PARTICIPANT';
  evidenceIds: Id[]; confidence: UnitScore; observedAt: ISODateTime;
}
export type RelationshipKind = 'FAMILY' | 'PARENT_OF' | 'CLOSE_FRIEND' | 'FRIEND' | 'PROFESSOR_STUDENT' | 'COWORKER' | 'FORMER_COWORKER' | 'CLASSMATE' | 'ACQUAINTANCE' | 'UNKNOWN';
export interface Relationship {
  id: Id; fromPersonId: Id; toPersonId: Id; kind: RelationshipKind;
  strength: UnitScore; confidence: UnitScore; recencyFactor: UnitScore;
  state: ReviewState; evidenceIds: Id[]; observedLinkIds: Id[]; updatedAt: ISODateTime;
}
/** Search projection built from authorized, accepted claims, never from UI layout adjacency. */
export interface SearchEdge {
  id: Id; relationshipId: Id | null; fromPersonId: Id; toPersonId: Id;
  strength: UnitScore; confidence: UnitScore; recencyFactor: UnitScore;
  evidenceIds: Id[]; basis: 'CONFIRMED_RELATIONSHIP' | 'OBSERVED_CONNECTION_PRIOR';
  policyVersion: string;
}
export interface GraphSnapshot extends SnapshotKey {
  schemaVersion: 1; rootPersonId: Id; people: Person[]; identities: Identity[];
  organizations: Organization[]; observedLinks: ObservedLink[]; relationships: Relationship[];
  searchEdges: SearchEdge[]; evidence: Evidence[]; sources: SourceSummary[];
  coverage: { completeForAuthorizedSources: boolean; omittedNodeCount: number; warnings: string[] };
}
export interface Goal {
  id: Id; text: string; organizationIds: Id[]; roles: string[]; locations: string[];
  industries: string[]; unsupportedConstraints: string[];
}
export interface Target {
  personId: Id; organizationId?: Id; relevance: UnitScore; evidenceIds: Id[];
  reasons: string[]; criteria: Array<{ name: string; status: 'MATCHED' | 'UNKNOWN' | 'NOT_MATCHED' }>;
}
export interface EdgeScoreFactor { edgeId: Id; strength: UnitScore; confidence: UnitScore; recencyFactor: UnitScore; value: UnitScore }
export interface IdentityScoreFactor { personId: Id; value: UnitScore }
export interface PathScore {
  value: UnitScore; relationshipQuality: UnitScore; identityQuality: UnitScore;
  targetRelevance: UnitScore; hopPenalty: UnitScore;
  edges: EdgeScoreFactor[]; identities: IdentityScoreFactor[]; policyVersion: 'route-v1';
}
export interface OpportunityPath {
  id: Id; personIds: Id[]; edgeIds: Id[]; target: Target; score: PathScore;
  explanation: { summary: string; evidenceIds: Id[]; uncertainties: string[]; suggestedFirstContactId: Id };
}
export interface SearchRequest {
  scopeId: Id; expectedGraphVersion: Version; goalText: string;
  k?: number; maxHops?: number;
}
export type SearchStop = 'TOP_K_PROVEN' | 'EXHAUSTED_WITHIN_HOP_LIMIT' | 'BUDGET_REACHED' | 'NO_TARGETS';
export interface SearchStats {
  expansions: number; elapsedMs: number; stop: SearchStop;
  optimalWithinHopLimit: boolean; traceTruncated: boolean; omittedTraceEvents: number;
}
export interface SearchResult extends SnapshotKey {
  schemaVersion: 1; searchId: Id; goal: Goal; targets: Target[]; paths: OpportunityPath[];
  events: SearchEvent[]; stats: SearchStats; warnings: string[];
}
export interface EventEnvelope extends SnapshotKey { schemaVersion: 1; searchId: Id; seq: number }
export type SearchEvent = EventEnvelope & (
  | { type: 'SEARCH_STARTED'; rootPersonId: Id }
  | { type: 'NODE_VISITED'; personId: Id; prefixPersonIds: Id[] }
  | { type: 'EDGE_EXPLORED'; edgeId: Id; fromPersonId: Id; toPersonId: Id }
  | { type: 'PATH_PRUNED'; prefixPersonIds: Id[]; reason: 'CYCLE' | 'HOP_LIMIT' | 'ZERO_QUALITY' }
  | { type: 'TARGET_FOUND'; personId: Id }
  | { type: 'PATH_CANDIDATE'; path: OpportunityPath }
  | { type: 'PATH_SELECTED'; pathId: Id }
  | { type: 'SEARCH_COMPLETED'; pathIds: Id[]; stats: SearchStats }
  | { type: 'SEARCH_FAILED'; code: string; message: string }
);
export interface PersonCandidate {
  tempId: Id; displayName: string; existingPersonId?: Id;
  identities: Array<{ platform: string; externalId: string; profileUrl?: string }>;
  evidenceIds: Id[];
}
export interface RelationshipCandidate {
  tempId: Id; fromRef: Id; toRef: Id; kind: RelationshipKind;
  strengthEstimate: UnitScore; confidence: UnitScore; evidenceIds: Id[];
}
/** Private normalized records. Candidate refs must resolve to this batch or authorized existing people. */
export interface CandidateBatch {
  schemaVersion: 1; batchId: Id; sourceId: Id;
  people: PersonCandidate[]; relationships: RelationshipCandidate[];
  observedLinks: Array<{ fromRef: Id; toRef: Id; kind: ObservedLink['kind']; evidenceIds: Id[] }>;
  affiliations: Array<{ personRef: Id; organizationName: string; role?: string; evidenceIds: Id[] }>;
  evidence: Evidence[]; warnings: string[];
}
export interface InferenceResult<T> {
  payload: T; confidence: UnitScore; evidenceIds: Id[];
  inferenceType: 'EXTRACTION' | 'IDENTITY' | 'EXPLANATION';
  confirmationState: 'PENDING'; producer: string; model?: string; promptVersion: string;
}
export interface IdentityProposal {
  id: Id; identityIds: [Id, Id]; candidatePersonIds: Id[];
  score: UnitScore; scoreMeaning: 'HEURISTIC_NOT_CALIBRATED';
  signals: Array<{ label: string; supportsMatch: boolean; evidenceIds: Id[] }>;
  recommendation: 'KEEP_SEPARATE' | 'USER_CONFIRMATION'; priority: 'NORMAL' | 'HIGH';
}
export interface ReviewDecision {
  scopeId: Id; expectedGraphVersion: Version; candidateIds: Id[];
  decision: 'ACCEPT' | 'REJECT'; idempotencyKey: string;
}
export interface IdentityLinkDecision {
  id: Id; identityId: Id; previousPersonId: Id | null; nextPersonId: Id;
  actorUserId: Id; decidedAt: ISODateTime; graphVersion: Version; revertedByDecisionId?: Id;
}
/** Persisted batches, sanitized to actor visibility, drive construction animation. */
export type GraphBuildEvent = {
  schemaVersion: 1; jobId: Id; scopeId: Id; seq: number;
} & (
  | { type: 'IMPORT_STARTED'; sourceId: Id }
  | { type: 'BATCH_COMMITTED'; operationKind: 'IMPORT' | 'REVIEW' | 'IDENTITY_LINK' | 'REVERT'; baseGraphVersion: Version; graphVersion: Version;
      people: Person[]; observedLinks: ObservedLink[]; relationships: Relationship[];
      identities: Identity[]; organizations: Organization[]; sources: SourceSummary[]; evidence: Evidence[];
      searchEdges: SearchEdge[]; removedPersonIds: Id[]; removedEdgeIds: Id[] }
  | { type: 'REVIEW_REQUIRED'; candidateIds: Id[]; proposalIds: Id[] }
  | { type: 'IMPORT_COMPLETED'; graphVersion: Version; peopleAdded: number; linksAdded: number; warnings: string[] }
  | { type: 'IMPORT_FAILED'; code: string; message: string; retryable: boolean }
);
export interface ApiError { error: { code: 'INVALID_INPUT' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'VERSION_CONFLICT' | 'SOURCE_UNAVAILABLE' | 'RATE_LIMITED' | 'INTERNAL'; message: string; requestId: Id } }
export interface SearchOptions { k: number; maxHops: number; maxExpansions: number; maxFrontier: number; maxTraceEvents: number; deadlineMs: number }
export interface SearchEngine { findBestPaths(snapshot: GraphSnapshot, goal: Goal, targets: Target[], options: SearchOptions): SearchResult }
export interface IngestionAdapter<Input> { normalize(input: Input, context: { sourceId: Id; batchId: Id }): Promise<CandidateBatch> }
export interface AIEngine {
  extract(text: string, evidence: Evidence[]): Promise<InferenceResult<CandidateBatch>>;
  resolve(a: Identity, b: Identity, evidence: Evidence[]): Promise<InferenceResult<IdentityProposal>>;
  explain(path: OpportunityPath, goal: Goal): Promise<InferenceResult<OpportunityPath['explanation']>>;
}

/** Server-internal storage envelopes; these are not public graph payloads. */
export interface SourceContext {
  sourceId: Id; ownerUserId: Id; scopeId: Id; batchId: Id;
  sourcePolicyVersion: string; sharingDecisionId: Id | null;
}
export interface SourceRecord {
  id: Id; sourceId: Id; ownerUserId: Id; externalRecordId: string;
  retrievedAt: ISODateTime; contentDigest: string; privatePayloadRef: string;
}
export interface StoredEvidence {
  evidence: Evidence; sourceRecordId: Id; ownerUserId: Id; scopeId: Id;
  sharingDecisionId: Id | null;
}
