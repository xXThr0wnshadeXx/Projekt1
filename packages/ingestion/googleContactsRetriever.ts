import type { CandidateBatch } from '../../contracts/index.js';
import { validateCandidateBatch } from '../../contracts/validation.js';
import { id, date } from '../../contracts/schema.js';
import { normalizeGoogleContacts } from './googleContactsNormalizer.js';

export interface GoogleContactsRetrievalInput {
  accessToken: string; sourceId: string; batchId: string; ownerPersonId: string; retrievedAt: string;
  /** Optional server-owned cancellation; never a browser request field. */
  signal?: AbortSignal;
}
export type GoogleContactsRetrieval = (input: GoogleContactsRetrievalInput) => Promise<CandidateBatch>;
export type RetrievalFailure = 'AUTH_REQUIRED' | 'SCOPE_DENIED' | 'RATE_LIMITED' | 'PROVIDER_UNAVAILABLE'
  | 'INVALID_RESPONSE' | 'LIMIT_EXCEEDED' | 'TIMEOUT' | 'ABORTED' | 'INVALID_CONTEXT';
/** Contains only fixed codes. Never attach provider bodies, URLs, tokens or error causes. */
export class GoogleContactsRetrievalError extends Error {
  constructor(readonly reason: RetrievalFailure) {
    super('Google Contacts retrieval could not complete.');
    this.name = 'GoogleContactsRetrievalError';
  }
}
export const GOOGLE_CONTACTS_LIMITS = Object.freeze({
  pageSize: 1000, maxPages: 20, maxRecords: 10000,
  maxPageBytes: 2 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024,
  requestTimeoutMs: 5000, totalTimeoutMs: 15000,
});
export interface GoogleContactsRetrieverOptions {
  fetch?: typeof globalThis.fetch;
  /** Tests/deployments may lower caps; no option can raise the hard limits. */
  limits?: Partial<{[K in keyof typeof GOOGLE_CONTACTS_LIMITS]: number}>;
}
function fail(reason: RetrievalFailure): never { throw new GoogleContactsRetrievalError(reason); }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function cancel(response: Response) { void response.body?.cancel().catch(() => {}); }
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(new GoogleContactsRetrievalError('ABORTED')); };
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Full bounded snapshot only. A failed later page never returns earlier contacts. */
export function createGoogleContactsRetriever(options: GoogleContactsRetrieverOptions = {}): GoogleContactsRetrieval {
  const fetcher = options.fetch ?? globalThis.fetch;
  const limits = {...GOOGLE_CONTACTS_LIMITS, ...options.limits};
  for (const key of Object.keys(GOOGLE_CONTACTS_LIMITS) as Array<keyof typeof limits>) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > GOOGLE_CONTACTS_LIMITS[key]) {
      throw new Error('Invalid Google Contacts retrieval limit.');
    }
  }
  return async input => {
    try {
      id(input.sourceId, '$.sourceId'); id(input.batchId, '$.batchId'); id(input.ownerPersonId, '$.ownerPersonId'); date(input.retrievedAt, '$.retrievedAt');
      if (typeof input.accessToken !== 'string' || !input.accessToken || input.accessToken.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(input.accessToken)) fail('INVALID_CONTEXT');
    } catch { return fail('INVALID_CONTEXT'); }
    if (input.signal?.aborted) return fail('ABORTED');
    const totalDeadline = Date.now() + limits.totalTimeoutMs;
    const total = new AbortController();
    const totalTimer = setTimeout(() => total.abort(), limits.totalTimeoutMs);
    let bytes = 0, cursor: string | undefined, expectedTotal: number | undefined;
    const cursors = new Set<string>();
    const connections: Array<Record<string, unknown>> = [];
    const resourceIds = new Set<string>();
    try {
      for (let pageNumber = 0; pageNumber < limits.maxPages; pageNumber++) {
        if (Date.now() >= totalDeadline) fail('TIMEOUT');
        const request = new AbortController();
        const timer = setTimeout(() => request.abort(), limits.requestTimeoutMs);
        const signal = AbortSignal.any([total.signal, request.signal, ...(input.signal ? [input.signal] : [])]);
        try {
          if (signal.aborted) fail('ABORTED');
          const url = new URL('https://people.googleapis.com/v1/people/me/connections');
          url.searchParams.set('personFields', 'names,organizations');
          url.searchParams.set('sources', 'READ_SOURCE_TYPE_CONTACT');
          url.searchParams.set('pageSize', String(limits.pageSize));
          if (cursor !== undefined) url.searchParams.set('pageToken', cursor);
          const pending = fetcher(url, {method: 'GET', headers: {Authorization: `Bearer ${input.accessToken}`, Accept: 'application/json'}, redirect: 'error', signal});
          // An injected/nonconforming transport can settle after cancellation; release its body.
          void pending.then(response => { if (signal.aborted) cancel(response); }, () => {});
          const response = await abortable(pending, signal);
          if (response.redirected || (response.url && new URL(response.url).origin !== url.origin)) { cancel(response); fail('INVALID_RESPONSE'); }
          if (response.status !== 200) {
            cancel(response);
            fail(response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'SCOPE_DENIED'
              : response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE');
          }
          const length = response.headers.get('content-length');
          if (length !== null && (!/^\d+$/.test(length) || Number(length) > limits.maxPageBytes || Number(length) + bytes > limits.maxTotalBytes)) {
            cancel(response); fail('LIMIT_EXCEEDED');
          }
          if (!response.body) fail('INVALID_RESPONSE');
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = []; let pageBytes = 0;
          try {
            for (;;) {
              const {done, value} = await abortable(reader.read(), signal);
              if (done) break;
              pageBytes += value.byteLength; bytes += value.byteLength;
              if (pageBytes > limits.maxPageBytes || bytes > limits.maxTotalBytes) fail('LIMIT_EXCEEDED');
              chunks.push(value);
            }
          } finally { void reader.cancel().catch(() => {}); }
          const buffer = new Uint8Array(pageBytes); let offset = 0;
          for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
          let page: unknown;
          try { page = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(buffer)); } catch { fail('INVALID_RESPONSE'); }
          if (!object(page) || ('connections' in page && !Array.isArray(page.connections))) fail('INVALID_RESPONSE');
          // Repeated fields may be absent for an empty protobuf JSON response.
          const rows = (page.connections ?? []) as unknown[];
          if (rows.length > limits.pageSize || connections.length + rows.length > limits.maxRecords) fail('LIMIT_EXCEEDED');
          for (const row of rows) {
            // Do not silently discard a provider record and claim a complete snapshot.
            if (!object(row) || typeof row.resourceName !== 'string' || !/^people\/[^\s/]{1,1024}$/.test(row.resourceName)) fail('INVALID_RESPONSE');
            connections.push(row); resourceIds.add(row.resourceName);
          }
          if ('totalItems' in page) {
            if (!Number.isSafeInteger(page.totalItems) || (page.totalItems as number) < 0) fail('INVALID_RESPONSE');
            if ((page.totalItems as number) > limits.maxRecords) fail('LIMIT_EXCEEDED');
            if (expectedTotal !== undefined && expectedTotal !== page.totalItems) fail('INVALID_RESPONSE');
            expectedTotal = page.totalItems as number;
          }
          if (!('nextPageToken' in page)) {
            if (expectedTotal !== undefined && expectedTotal !== resourceIds.size) fail('INVALID_RESPONSE');
            const batch = normalizeGoogleContacts({ownerPersonId: input.ownerPersonId, retrievedAt: input.retrievedAt, connections}, {sourceId: input.sourceId, batchId: input.batchId});
            try {
              validateCandidateBatch(batch, {sourceId: input.sourceId, batchId: input.batchId, existingPersonIds: new Set([input.ownerPersonId]), existingEvidenceIds: new Set()});
            } catch { fail('INVALID_RESPONSE'); }
            if (input.signal?.aborted) fail('ABORTED');
            if (total.signal.aborted || Date.now() >= totalDeadline) fail('TIMEOUT');
            return batch;
          }
          if (typeof page.nextPageToken !== 'string' || !page.nextPageToken || page.nextPageToken.length > 8192 || /[\u0000-\u001f\u007f]/.test(page.nextPageToken) || cursors.has(page.nextPageToken)) fail('INVALID_RESPONSE');
          cursor = page.nextPageToken; cursors.add(cursor);
        } catch (error) {
          if (input.signal?.aborted) fail('ABORTED');
          if (total.signal.aborted || request.signal.aborted) fail('TIMEOUT');
          throw error;
        } finally { clearTimeout(timer); }
      }
      return fail('LIMIT_EXCEEDED');
    } catch (error) {
      if (error instanceof GoogleContactsRetrievalError) throw error;
      return fail('PROVIDER_UNAVAILABLE');
    } finally { clearTimeout(totalTimer); }
  };
}
