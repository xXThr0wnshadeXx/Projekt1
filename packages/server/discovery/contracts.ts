import type {NormalizedImportEnvelope, RelationshipKind} from '../../../contracts/index.js';
import * as s from '../../../contracts/schema.js';

export interface DiscoveryRequest {
  scopeId: string; expectedGraphVersion: string; idempotencyKey: string;
  anchors: {linkedinUrl: string; instagramUrl: string};
  target: {personName?: string; organizationName?: string; profileUrl?: string};
  selectedContextPersonIds?: string[]; selectedPublicUrls?: string[];
}
export interface DiscoveryCapabilities {
  wikimedia: 'AVAILABLE'|'UNAVAILABLE'; generalWeb: 'AVAILABLE'|'NOT_CONFIGURED'|'UNAVAILABLE';
  coverage: 'WIKIMEDIA_ONLY'|'GENERAL_PUBLIC_WEB';
}
export interface DiscoveryResult {
  discoveryId: string; scopeId: string; baseGraphVersion: string;
  status: 'REVIEW_REQUIRED'|'INSUFFICIENT_PUBLIC_EVIDENCE'|'SOURCE_UNAVAILABLE';
  capabilities: DiscoveryCapabilities; proposalRefs: Array<{id: string; revision: string}>;
  unresolvedIdentityCount: number; warnings: string[];
  budget: {queriesUsed: number; pagesRead: number; exhausted: boolean};
}
export type DiscoveryFailure = 'INVALID_INPUT'|'FORBIDDEN'|'VERSION_CONFLICT'|'NOT_CONFIGURED'|'SOURCE_UNAVAILABLE'|'ACCESS_DENIED'|'UNSUPPORTED_CONTENT'|'LIMIT_EXCEEDED'|'CANCELLED';
/** Generic errors: never attach URLs, queries, headers, driver errors or response bodies. */
export class DiscoveryError extends Error {
  constructor(readonly code: DiscoveryFailure) {super(`Public discovery: ${code}`); this.name = 'DiscoveryError';}
}
export type DateValue = {value: string; precision: 'YEAR'|'MONTH'|'DAY'|'SECOND'};
export interface ClaimEndpoint {
  sourceIdentity: {platform: string; externalId: string}; mention: string;
  identityState: 'OWNER_ASSERTED_ANCHOR'|'UNRESOLVED'|'EXPLICITLY_CONFIRMED';
  personId: string|null; resolutionRevision: string; resolutionDecisionId: string|null; identityEvidenceIds: string[];
}
export interface PublicDocument {
  id: string; revision: string; sourceId: string;
  kind: 'PUBLIC_PROFILE'|'PUBLIC_ARTICLE'|'WIKIMEDIA_PAGE'|'WIKIDATA_ENTITY';
  sourceUrl: string; fetchedUrl: string; title: string; publisher: string|null;
  publishedAt: DateValue|null; retrievedAt: string; contentDigest: string; digestBasis: 'NORMALIZED_TEXT_SHA256';
  privatePayloadRef: string; upstreamRevisionId: string|null; independenceGroup: string; originalSourceUrls: string[];
}
export interface PublicCitation {
  id: string; evidenceId: string; documentId: string; documentRevision: string;
  role: 'IDENTITY'|'RELATIONSHIP'|'AFFILIATION'; supportingExcerpt: string;
  /** UTF-16 offsets in the exact normalizedText used to calculate contentDigest. */
  locator: {start: number; end: number; section: string|null}; statementId: string|null;
}
export interface PublicClaimProposal {
  id: string; revision: string; factKey: string; basis: 'PUBLIC_SOURCE_CITATION';
  kind: 'IDENTITY'|'RELATIONSHIP'|'AFFILIATION'; subject: ClaimEndpoint; object: ClaimEndpoint|null;
  organizationRef: string|null; predicate: string; relationshipKind: RelationshipKind|null; citationIds: string[];
  assertedPeriod: {start: DateValue|null; end: DateValue|null}|null; current: boolean|null;
  support: 'DIRECT_EXPLICIT'|'CORROBORATED_DIRECT'|'CONTEXT_ONLY'|'AMBIGUOUS';
  confidence: {value: number|null; meaning: 'HEURISTIC_EVIDENCE_SUPPORT'; policyVersion: string|null};
  extractionUncertainties: string[]; reviewState: 'PENDING'|'CONFIRMED'|'REJECTED'; reviewDecisionId: string|null; includeInSearch: boolean;
}
/** Future staging boundary; not accepted as unvalidated HTTP input by this source-only module. */
export interface PublicSourceEnvelope {
  schemaVersion: 1; normalized: NormalizedImportEnvelope;
  documents: PublicDocument[]; citations: PublicCitation[]; proposals: PublicClaimProposal[];
}
export interface SearchHit {
  url: string; title: string; snippet: string; provider: 'WIKIMEDIA'|'BRAVE'|'TAVILY';
  /** Always a hint. Search snippets are never verified claim/citation text. */
  evidenceStatus: 'DISCOVERY_HINT';
}
export interface SearchProvider {
  readonly kind: SearchHit['provider']; readonly configured: boolean;
  search(query: string, signal: AbortSignal): Promise<SearchHit[]>;
}

/** Public URL syntax only; DNS/public-address checks happen immediately before each connection. */
export function publicUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) throw new DiscoveryError('INVALID_INPUT');
  let url: URL; try {url = new URL(value);} catch {throw new DiscoveryError('INVALID_INPUT');}
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !url.hostname || url.hostname.endsWith('.')) throw new DiscoveryError('INVALID_INPUT');
  for (const key of url.searchParams.keys()) if (/^(?:access_token|id_token|refresh_token|password|api_key|client_secret|authorization|session|signature|x-amz-signature)$/i.test(key)) throw new DiscoveryError('INVALID_INPUT');
  url.hash = ''; return url;
}
export function normalizeProfileUrl(value: unknown, platform: 'linkedin'|'instagram'): string {
  const url = publicUrl(value), host = url.hostname.toLowerCase();
  if (platform === 'linkedin') {
    if (!/^(?:(?:www|m|[a-z]{2})\.)?linkedin\.com$/.test(host) || !/^\/in\/[A-Za-z0-9_%~-]{1,150}\/?$/.test(url.pathname)) throw new DiscoveryError('INVALID_INPUT');
    let slug: string; try {slug = decodeURIComponent(url.pathname.split('/')[2]!);} catch {throw new DiscoveryError('INVALID_INPUT');}
    if (!/^[\p{L}\p{N}_~-]{1,100}$/u.test(slug)) throw new DiscoveryError('INVALID_INPUT');
    url.hostname = 'www.linkedin.com'; url.pathname = `/in/${encodeURIComponent(slug)}/`;
  } else {
    if (!['instagram.com', 'www.instagram.com', 'm.instagram.com'].includes(host) || !/^\/[A-Za-z0-9._]{1,30}\/?$/.test(url.pathname)) throw new DiscoveryError('INVALID_INPUT');
    const handle = url.pathname.split('/')[1]!.toLowerCase();
    if (['accounts','explore','direct','p','reel','reels','stories','about','developer','legal','web','api'].includes(handle) || handle.startsWith('.') || handle.endsWith('.') || handle.includes('..')) throw new DiscoveryError('INVALID_INPUT');
    url.hostname = 'www.instagram.com'; url.pathname = `/${handle}/`;
  }
  url.search = ''; return url.href;
}
const boundedName: s.Check = (value, path) => {s.string(value, path); if ((value as string).length > 200 || /[\r\n\t\u007f]/.test(value as string)) s.fail(path, 'bounded public context');};
const urlCheck: s.Check = (value, path) => {try {publicUrl(value);} catch {s.fail(path, 'public HTTPS URL');}};
export function validateDiscoveryRequest(value: unknown): DiscoveryRequest {
  try {
    s.object({scopeId:s.id,expectedGraphVersion:s.id,idempotencyKey:s.id,
      anchors:s.object({linkedinUrl:urlCheck,instagramUrl:urlCheck}),
      target:s.object({personName:s.optional(boundedName),organizationName:s.optional(boundedName),profileUrl:s.optional(urlCheck)}),
      selectedContextPersonIds:s.optional(s.array(s.id,0,4)),selectedPublicUrls:s.optional(s.array(urlCheck,0,5))})(value,'$');
    const input = structuredClone(value as DiscoveryRequest);
    if (!input.target.personName && !input.target.organizationName && !input.target.profileUrl) throw new Error();
    input.anchors.linkedinUrl = normalizeProfileUrl(input.anchors.linkedinUrl, 'linkedin');
    input.anchors.instagramUrl = normalizeProfileUrl(input.anchors.instagramUrl, 'instagram');
    if (input.target.profileUrl) input.target.profileUrl = publicUrl(input.target.profileUrl).href;
    if (input.selectedContextPersonIds && new Set(input.selectedContextPersonIds).size !== input.selectedContextPersonIds.length) throw new Error();
    if (input.selectedPublicUrls) input.selectedPublicUrls = [...new Set(input.selectedPublicUrls.map(url => publicUrl(url).href))];
    return input;
  } catch {throw new DiscoveryError('INVALID_INPUT');}
}
