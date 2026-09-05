# Google Contacts import and review bridge

Ben owns `packages/server/imports`; Shaw owns actual source HTTP/pagination and normalization. `GoogleImportBridge` takes an existing authenticated session and persists a real normalized Contacts batch as pending, produces a safe review response, then explicitly approves its people/observations into the private graph. It never accepts client actor/root mappings or claims that saved contacts are confirmed friends.

## HTTP contract for Nicolas and integration

These are proposed routes for Ben's HTTP owner to mount; the helper commit does not mount HTTP itself. All requests require the existing same-origin session cookie; all responses are private, `Cache-Control: no-store`. POSTs require existing same-origin/JSON protection and bounded bodies. Pass the request Cookie header as the current credential. Use the shared `apiFailure` sanitizer; never return provider exception bodies or credentials.

1. `POST /api/imports/google` takes exactly `{ scopeId, sourceId, expectedGraphVersion, idempotencyKey }`. All fields are opaque strings. Obtain scope and source from authenticated session/Contacts connection state; the backend resolves ownership, root and policy again. Respond202 with `ImportStartResponse`.
2. `GET /api/imports/:jobId?scopeId=...` responds200 with `ImportReviewResponse` below. Build helper input from path job ID and query scope ID. Show real people, new/existing counts, saved-contact observations, employer fields and warnings.
3. On the explicit **Add these contacts** action, `POST /api/imports/:jobId/approve` takes exactly `{ scopeId, expectedGraphVersion, idempotencyKey, confirm: true }`. The server supplies `jobId` from the path, overriding no user-selected identity mapping. Respond200 with `ImportApprovalResponse`; play its committed `GraphBuildEvents`, then refresh the graph at the returned version. Before the click, explain that names with different source identities remain separate and employer claims still need review.

The exact TypeScript wire DTOs are in `packages/server/imports/contracts.ts`, independent of frontend dependencies. Preserve an import command's idempotency key across retries; use a new key for a genuinely new retrieval. Preserve review key across retries. Expected version is the current graph version returned by graph/review. On409 reload; when `canApprove:false` with the identity-change warning, start a new import because its previously staged source assignments became stale.

Example shapes (angle-bracket values are placeholders, not usable IDs or demo data):

```json
{"scopeId":"<authorized-scope>","sourceId":"<connected-source>","expectedGraphVersion":"1","idempotencyKey":"<request-uuid>"}
```

```json
{"jobId":"<job-id>","scopeId":"<authorized-scope>","sourceId":"<connected-source>","status":"PENDING_REVIEW","duplicate":false}
```

```ts
interface ImportReviewResponse {
  jobId: string; scopeId: string; sourceId: string; graphVersion: string;
  status: 'PENDING_REVIEW' | 'OBSERVATIONS_APPROVED'; canApprove: boolean;
  people: Array<{
    candidateId: string; displayName: string;
    disposition: 'NEW_PERSON' | 'EXISTING_SOURCE_IDENTITY';
    existingPersonId: string | null;
  }>;
  observations: Array<{fromPersonId: string; toCandidateId: string; kind: 'CONTACT_SAVED'}>;
  affiliations: Array<{
    candidateId: string; organizationName: string; role?: string;
    current: boolean | null; state: 'PENDING';
  }>;
  counts: {
    people: number; newPeople: number; existingPeople: number;
    savedContactObservations: number; pendingAffiliations: number;
  };
  warnings: string[];
}
```

Approval returns `{jobId, graphVersion, duplicate, events}`. Events use the existing shared contract, contiguous from0: `IMPORT_STARTED`, `BATCH_COMMITTED(operationKind: REVIEW)`, `IMPORT_COMPLETED`. No constructed nodes appear before the durable approval transaction commits. An already-approved job returns its original events/version with `duplicate:true`; this endpoint has one fixed action and accepts no changing identity assignments.

## Server composition

```ts
const imports = new GoogleImportBridge({
  auth: googleAuth,
  contacts: googleContacts,
  store,
  retrieveAndNormalize: async ({accessToken, sourceId, batchId, ownerPersonId, retrievedAt}) => {
    // Shaw/integration performs the authorized bounded People API retrieval here.
    // Return Shaw's real normalizeGoogleContacts(payload, {sourceId,batchId}) result.
    // payload.ownerPersonId and payload.retrievedAt come from these server arguments.
    // No tokens, actor claims or private payloads come from the HTTP client.
    return retrieveAndNormalizeActualContacts({accessToken, sourceId, batchId, ownerPersonId, retrievedAt});
  },
});
// await imports.start(cookieHeader, body)
// await imports.review(cookieHeader, {scopeId, jobId})
// await imports.approve(cookieHeader, {...validatedBody, jobId: jobIdFromPath})
```

Inputs reject unknown fields and require deliberate `confirm:true`; a frontend must not POST an entire review DTO back. Root HTTP/main, app composition and Shaw source are untouched by this milestone.

`getFreshAccessToken` runs server-side only, after authenticated ownership checks. Its returned scope/source must match the persisted source. The normalized Contacts batch must contain one `GOOGLE_CONTACTS` source identity per person, only root-to-contact `CONTACT_SAVED` observations, no relationship candidates, and only candidate-bound affiliations. The verified owner endpoint is the existing `google` identity created during Contacts consent; it is not a guessed People API resource ID.

## Provenance and repeat imports

Every source record has a SHA256 digest of a **normalized record view**, not a claim to hash raw provider bytes. The view contains the original source person's normalized fields, its observations/affiliations and evidence. It is durably stored inside the immutable private `import_jobs.envelope.batch`; the `norm_<record-id>` private reference resolves that view through `readNormalizedRecord`. That backend-only method checks owner, source and digest and must not be mounted as a raw/public route. No extra raw contacts export, email list or token payload is stored for this bridge.

Evidence belongs to exactly one normalized source record. Every observation/affiliation has a deterministic source fact key and immutable endpoint identities. All evidence references, owner/source/root bindings, dates, IDs, confidences and fact mappings pass the actual shared `validateNormalizedImport` contract before staging and again inside storage. Provenance is complete; missing/ambiguous evidence fails instead of being guessed. Normalizer warnings survive to review.

The client command key becomes a deterministic batch ID scoped to actor, scope and source. Successful retries return the durable job before another provider call, even after graph version changes. Concurrent identical commands may fetch different observations; the first durable command result wins. This does not weaken `ImportPort`: directly submitting a different normalized payload under an existing batch key still returns409.

A fresh import finds only exact immutable identities from the same authorized source. An already accepted source identity reuses its canonical person. An unfamiliar source identity creates a separate person upon explicit approval, even if its name equals another person's name. The bridge accepts no fuzzy/existing-person suggestion from Shaw's batch or the HTTP client. If another import changes the identity map after staging, review blocks that stale job and asks for a new import. Source observation IDs remain stable on refresh; pending affiliation metadata is replaced rather than duplicated, while reviewed claims are preserved.

## Verification and remaining work

Strict server TypeScript passes. Seven bridge tests plus19prior storage tests pass on actual PostgreSQL, using anonymous contract fixtures only. Tests cover pending staging, safe DTOs, persisted/resolvable source evidence, deliberate approval, committed event replay, exact-source reimports, equal-name separation, idempotent concurrent commands, stale versions, changed source identities and cross-owner denial before token/retrieval calls.

The same seven scenarios also passed using Shaw's exact normalizer at `83ad0bdb1409f27502951f527d56f899951128d0`, transpiled without modifying his source and fed anonymous provider-shaped test records. This verifies runtime contract compatibility; it does not resolve that branch's still-requested NodeNext `.js` import extension or prove live Google access. No test data is loaded into the application.

Run the committed suites against an isolated test database:

```sh
npm run build:server
node --test tests/import-bridge*.test.mjs tests/storage*.test.mjs
```

Set `STORAGE_TEST_DATABASE_URL` first; these suites explicitly skip without a database and a skipped run is not validation. Existing temporary test schema cleanup remains in place.

Remaining owners: Shaw provides real bounded retrieval/normalization; Ben mounts routes and supplies configured Google/database services; Nicolas connects review/import UI and graph playback. No confirmed introduction/search edges or confirmed employer targets are invented by this milestone. Relationship/affiliation confirmation, identity merging/undo, rejection/partial review, provider deletions/refresh policy and large asynchronous import job scheduling remain separate tasks. The current POST waits for one injected retrieval/normalization call, so the provider adapter must enforce its time/record limits and report incomplete coverage honestly.
