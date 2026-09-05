import type {DiscoveryRequest, PublicCitation, PublicClaimProposal, SearchHit, SearchProvider} from '../contracts.js';
import type {RetrievedPublicDocument} from '../document-fetch.js';
import type {AuthorizedDiscoveryContext} from '../providers/service.js';

/** Exact source contract objects, still unpersisted and unreviewed. */
export interface PlanningExtraction {
  citations: PublicCitation[];
  proposals: PublicClaimProposal[];
}
export interface PlanningPorts {
  provider: SearchProvider;
  documents: {fetch(url: string, signal: AbortSignal): Promise<RetrievedPublicDocument>};
  extraction: {extract(document: RetrievedPublicDocument, signal: AbortSignal): Promise<PlanningExtraction>};
}
export interface PlanningBudget {
  maxSearches: number; maxRetainedHits: number; maxDocumentAttempts: number; collectionMs: number;
}
export interface PlanningInput {
  request: DiscoveryRequest;
  /** Supplied by authenticated server composition, never directly by an HTTP caller. */
  authority: AuthorizedDiscoveryContext;
}
export interface ExploratoryCandidate {
  profileUrl: string|null; mention: string; proposalId: string; citationIds: string[];
  sourceIdentity: {platform: string; externalId: string};
  /** Exact source assertion used solely to disambiguate a literal public query. */
  publicContext: string|null;
  identityState: 'UNRESOLVED';
  documentId: string; documentRevision: string;
  status: 'EXPLORATORY_ONLY';
}
export interface PlannedQuery {
  query: string; frontier: 'INITIAL'|'EXPANSION'|'FALLBACK';
  candidate: ExploratoryCandidate|null;
}
export type PlanningStop = 'COMPLETED'|'CANCELLED'|'DEADLINE'|'PROVIDER_STOPPED'|'NOT_CONFIGURED';
export interface PlanningOutput {
  status: 'UNREVIEWED_PUBLIC_EVIDENCE'|'INSUFFICIENT_PUBLIC_EVIDENCE';
  stop: PlanningStop;
  queries: Array<PlannedQuery & {outcome: 'SUCCEEDED'|'FAILED'|'CANCELLED'|'DEADLINE'}>;
  hits: SearchHit[];
  documents: RetrievedPublicDocument[];
  extractions: Array<{documentId: string; documentRevision: string; output: PlanningExtraction}>;
  candidates: ExploratoryCandidate[];
  issues: Array<{stage: 'SEARCH'|'DOCUMENT'|'EXTRACTION'|'PLANNING'; code: string}>;
  limitations: string[];
  budget: PlanningBudget & {
    searchesAttempted: number; documentAttempts: number; extractionAttempts: number;
    retainedHits: number; elapsedMs: number; exhausted: boolean;
  };
  persistence: 'NOT_PERFORMED';
}
