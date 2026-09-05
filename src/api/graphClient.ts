import type { ApiError, GraphSnapshot, SearchRequest, SearchResult } from '../../contracts/index';

const apiBase = '/api';

export class GraphApiError extends Error {
  constructor(message: string, readonly code?: ApiError['error']['code']) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, { credentials: 'include', ...init });
  const payload = await response.json().catch(() => null) as T | ApiError | null;
  if (!response.ok) {
    const error = payload as ApiError | null;
    throw new GraphApiError(error?.error?.message ?? `Request failed (${response.status}).`, error?.error?.code);
  }
  if (payload === null) throw new GraphApiError('The server returned an empty response.');
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
