# Bounded Google Contacts retrieval

`createGoogleContactsRetriever(options?)` in `googleContactsRetriever.ts` returns a server-only async function:

```ts
const retrieveAndNormalize = createGoogleContactsRetriever();
const batch = await retrieveAndNormalize({
  accessToken, sourceId, batchId, ownerPersonId, retrievedAt,
  // signal: optional server-owned AbortSignal
});
```

Its function type is checked against `RetrieveAndNormalizeGoogleContacts` in a separate compile-only file. Runtime imports depend only on the existing parser and shared contracts/validators; there is no runtime ingestion-to-server dependency. The factory does not start any request until called. Injection into the application and service-error translation are a separate reviewed integration step.

## Provider contract

Official reference consulted September 5, 2026: [Google People connections.list](https://developers.google.com/people/api/rest/v1/people.connections/list). The API accepts only `people/me`; page size is 1–1000; `nextPageToken` supplies the next cursor, and other request parameters must remain unchanged. Omission of the next cursor terminates pagination. `contacts.readonly` is an accepted scope.

Requests use only `https://people.googleapis.com/v1/people/me/connections`, GET, `personFields=names,organizations`, `sources=READ_SOURCE_TYPE_CONTACT`, and a fixed page size. The access token goes only in the Authorization header. Cursors are encoded as query values, never interpreted as URLs. Redirects are refused. No email, phone, photo, incremental sync token, Other Contacts or profile enrichment is requested. No automatic retry or backoff occurs; an error aborts this attempt and the authorized command can be retried later.

## Bounds and completeness

Hard defaults, optionally lowered at factory creation: 1000 records/page, 20 pages, 10,000 raw records including duplicate appearances, 2 MiB decoded body/page, 8 MiB aggregate decoded bodies, 5 seconds/request including body reads, and 15 seconds/attempt. Body lengths are checked while streaming, even without Content-Length. Cancellation/deadlines bound even an injected transport that fails to honor AbortSignal. Runtime normalization is synchronous; the total deadline is checked again before returning, but cannot preempt synchronous JavaScript execution.

Repeated, malformed or oversized cursors, exhausted bounds, malformed JSON/records, incomplete bodies, provider errors, and invalid normalized batches all fail the entire attempt. No partial batch is returned or persisted. If `totalItems` is supplied it must remain consistent and match the final distinct resource count; a changing provider list may therefore require a retry. Empty protobuf JSON or an omitted connections array can represent an empty page; a non-array field or missing resource identity is rejected. Without a provider total, successful completion establishes traversal of the returned cursor chain, not a transactional snapshot or a guarantee against concurrent Google-side changes.

All pages are supplied together to Shaw's unchanged normalizer. Its exact resource-name deduplication keeps the first occurrence and produces a redacted duplicate warning. Distinct resources remain separate even if names match. Missing optional names retain opaque handles; absent current-organization status stays unknown. Saved contacts remain directional observations with source/timestamp evidence, never inferred friendships, reverse edges or accepted affiliations.

The final batch passes `validateCandidateBatch` using server-provided source/batch/owner and no preexisting evidence. This catches malformed output and identifier collisions. At injection, retain the existing `googleContactsEnvelope` validation against the actual authorized snapshot; the early parser check does not replace scope authorization, existing-evidence validation, provenance or storage checks.

## Errors and integration mapping

`GoogleContactsRetrievalError` exposes a fixed `reason` and generic message, without provider response text, request URLs, credentials or cause. Reasons are:

- HTTP 401: `AUTH_REQUIRED`; HTTP 403: `SCOPE_DENIED` (a conservative status classification, not a parsed Google reason).
- HTTP 429: `RATE_LIMITED`.
- Other HTTP failures, redirect/network rejection and unrecognized transport failures: `PROVIDER_UNAVAILABLE`.
- Malformed/inconsistent payload, repeated cursor or failed runtime validation: `INVALID_RESPONSE`.
- Page/record/body cap: `LIMIT_EXCEEDED`; deadline: `TIMEOUT`; caller cancellation: `ABORTED`.
- Invalid server-supplied IDs/timestamp/token header shape: `INVALID_CONTEXT`, before contacting Google.

The application wrapper should map `RATE_LIMITED` to `ServiceError('RATE_LIMITED', 429)`, `INVALID_CONTEXT` to `ServiceError('INTERNAL', 500)`, and other retrieval errors to `ServiceError('SOURCE_UNAVAILABLE', 502)`. Provider token/scope failure is not an expired application login. Keep the detailed reason server-internal and do not serialize errors or log raw inputs. Without this wrapper the current HTTP generic-error handler will treat the independent ingestion exception as INTERNAL; this module alone does not change HTTP behavior.

## Offline verification

With root dependencies installed, run `npm --prefix packages/ingestion run check` and `npm --prefix packages/ingestion run check:retrieval`. The latter compiles with strict server NodeNext settings into ignored `dist/retrieval`, verifies assignability to the server function type, and runs 19 injected-transport tests. Tests cover multipage/deduplication, missing optional fields, source/root semantics, status and network failures, incomplete data, cursor cycles, every main bound, streaming cancellation, stalled transport/body, aggregate deadline and caller abort. Fixtures are anonymous and never inserted into an application database. No live Google request or credential was used to validate this module.
