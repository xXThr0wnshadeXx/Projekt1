import type { ApiError, GraphSnapshot, SearchRequest, SearchResult } from '../../contracts/index';

const apiBase = '/api';

export class GraphApiError extends Error {
  constructor(message: string, readonly code?: ApiError['error']['code'], readonly status?: number) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { credentials: 'include', ...init });
  const payload = await response.json().catch(() => null) as T | ApiError | null;
  if (!response.ok) {
    const error = payload as ApiError | null;
    throw new GraphApiError(error?.error?.message ?? `Request failed (${response.status}).`, error?.error?.code, response.status);
  }
  if (payload === null) throw new GraphApiError('The server returned a non-JSON response.', undefined, response.status);
  return payload as T;
}

/** Server-owned session cookies are included, but no credential is exposed to the UI. */
export function loadGraph(scopeId: string) {
  return request<GraphSnapshot>(`/graph?scopeId=${encodeURIComponent(scopeId)}`);
}

/** The service owns goal resolution, ranking and all search-event creation. */
export function searchGraph(input: SearchRequest) {
  return request<SearchResult>('/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });
}

export type DiscoveryCapabilities = {
  wikimedia: 'AVAILABLE' | 'UNAVAILABLE';
  generalWeb: 'AVAILABLE' | 'NOT_CONFIGURED' | 'UNAVAILABLE';
  coverage: 'WIKIMEDIA_ONLY' | 'GENERAL_PUBLIC_WEB';
};

export type DiscoveryRequest = {
  scopeId: string;
  expectedGraphVersion: string;
  idempotencyKey: string;
  anchors: { linkedinUrl: string; instagramUrl: string };
  target: { personName?: string; organizationName?: string; profileUrl?: string };
  selectedContextPersonIds?: string[];
  selectedPublicUrls?: string[];
};

export type DiscoveryReceipt = {
  discoveryId: string;
  scopeId: string;
  baseGraphVersion: string;
  status: 'REVIEW_REQUIRED' | 'INSUFFICIENT_PUBLIC_EVIDENCE' | 'SOURCE_UNAVAILABLE';
  capabilities: DiscoveryCapabilities;
  proposalRefs: Array<{ id: string; revision: string }>;
  unresolvedIdentityCount: number;
  warnings: string[];
  budget: { queriesUsed: number; pagesRead: number; exhausted: boolean };
};

/** Returns only display-safe discovery coverage; provider credentials remain server-side. */
export function loadDiscoveryCapabilities(signal?: AbortSignal) {
  return request<DiscoveryCapabilities>('/discovery/capabilities', { signal });
}

/** The request is idempotent only for the supplied key and otherwise has no browser persistence. */
export function startDiscovery(input: DiscoveryRequest, signal?: AbortSignal) {
  return request<DiscoveryReceipt>('/discovery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal
  });
}
