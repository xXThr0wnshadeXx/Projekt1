# Public citation staging and explicit identity materialization

This is the first public-citation checkpoint: durable private source text/citations/proposal revisions and
explicit source-mention→canonical-person decisions. It **does not accept public relationship/affiliation
claims, compute their scores, or create SearchEdges**. It imports frozen discovery contract68214d3 and
PUBLIC_ARTICLE enum extensiond79638c without changing them or the existing manual-facts module.

## Composition and ports

```ts
import {migratePublicFactsStorage} from './public-facts/migrate.js';
import {PgPublicFactsStore} from './public-facts/postgres.js';
import {PublicFactsService} from './public-facts/service.js';
await migratePublicFactsStorage(pool, absolutePathToMigration004);
const publicFacts = new PublicFactsService({auth, publicFacts: new PgPublicFactsStore(pool)});
```

Use existing startup migration registry/order. All public methods take the opaque session credential,
resolve actor via AuthPort and transactionally lock app_sessions before private_scopes through the
existing facts transaction helper. Database wall-clock expiry is rechecked after all waits/writes.
HTTP/application composition belongs to backend; preserve bounded JSON, same-origin/CSRF checks and
apiFailure mapping. Do not route `stage` directly from an arbitrary browser envelope.

Exact typed contracts are in `contracts.ts`:

- **Server-only `stage(credential, request)`** takes `{expectedGraphVersion,idempotencyKey,envelope,texts}`.
  `envelope` is the unchanged PublicSourceEnvelope. `texts` contains
  `{documentId,documentRevision,normalizedText}` for each document. This call actually stores those texts,
  source metadata, citations, proposals and endpoint revisions in one private transaction. It returns
  `{batchId,scopeId,graphVersion,duplicate,status:'PENDING_REVIEW'}`. Document retrieval's NOT_PERSISTED
  status must remain until this succeeds. No provider fetch, extraction or fabricated assertion occurs here.
- **`review(credential,{scopeId,batchId})`** returns current graphVersion, safe document metadata (no
  privatePayloadRef), exact short citations, unchanged PENDING proposals and endpoint views. Each endpoint
  includes server-derived endpointId/revision, original unresolved/source-asserted endpoint,
  latestResolutionDecisionId, current:boolean and a valid current resolution or null. It returns no normalized
  text, raw record envelope, session data or DB handles. Proposals are immutable original records; join their
  sourceIdentity to endpoint views for current resolution rather than treating their initial personId as current.
- **`resolve(credential,request)`** takes `{scopeId,expectedGraphVersion,idempotencyKey,confirm:true,
  endpointId,expectedEndpointRevision,expectedResolutionDecisionId,disposition}` and personId only for
  LINK_EXISTING. NEW_PERSON creates a separate canonical Person from the exact quoted mention;
  LINK_EXISTING attaches the chosen source identity to an explicitly selected existing scoped person.
  Use endpoint.latestResolutionDecisionId (nullable) for expectedResolutionDecisionId. Response includes
  endpoint/identity/person IDs, decisionId, base/current graphVersion, duplicate and one real seq0
  BATCH_COMMITTED/IDENTITY_LINK event. Reload graph/review afterward.

An existing accepted source identity cannot be reassigned to another person or auto-merged. A revised
source mention can be explicitly re-reviewed by LINK_EXISTING to the same mapped person; NEW_PERSON
cannot duplicate its accepted source identity. A full unlink/reassignment/revert flow is not implemented.
New intermediates **may be discovered outside all prior contact lists**: explicitly create/bind them here
before later public-claim acceptance. Neither relationship endpoint must be root after that future acceptance.

## Producer/source provisioning invariants

Source provisioning is server-owned. Before staging, the authenticated composition must provision an
actual enabled private_sources record via the existing PgStore.provisionSource interface:

```ts
// actorUserId comes from verified server auth, and source.id is allocated by the server.
await store.provisionSource({actorUserId, scopeId, expectedGraphVersion,
  source: {id: sourceId, provider: 'PUBLIC_ARTICLE', origin: 'PUBLIC_SOURCE',
    label: displaySafeSourceLabel, importedAt: retrievedAt},
  policyVersion: 'public-citation-review-v1'});
// Reload the resulting graph version before staging. Do NOT supply verifiedOwnerIdentity.
```

PgStore rechecks owner scope and expected version under its scope transaction and inserts the matching
source into GraphSnapshot. Browser input must never choose actor, source ownership, verified identity or
SourceContext. Production source composition must retain live-session authorization; staging and identity
writes independently recheck it with session-before-scope locks. Do not call provisionSource's
verifiedOwnerIdentity option for profile links: it emits verified-account evidence that these links do not prove.

Use PUBLIC_ARTICLE for PUBLIC_ARTICLE/WIKIMEDIA_PAGE documents; use PUBLIC_PROFILE for actual
PUBLIC_PROFILE/WIKIDATA_ENTITY sources. Do not relabel an article to fit an old enum. One envelope has
one correctly owned source. Multi-source evidence uses several staged sources; cross-owner sharing is
not supported and sharingDecisionId must remain null. A prior import/sign-in does not grant contribution.

Stage itself persists normalized text in DOCUMENT resources. Allocate an opaque privatePayloadRef in the
server producer, bind it uniquely to the exact SourceRecord and document, and claim persistence only after
stage commit. It is an internal reference, not a caller-authorized filesystem path or fetch URL. Existing source
records' owner/source/digest/retrievedAt/privatePayloadRef must match the retained document exactly.

## Validation, revisions and evidence semantics

Bounds: at most5 documents, 1MiB UTF-8 each/5MiB total,100 citations,50 proposals; each quote≤2000
characters and endpoint mention≤200. Verify SHA256 of exact normalized UTF-8 text and UTF-16 quote
start/end offsets. Citation roles match evidence and claims; endpoint identityEvidenceIds reference IDENTITY
citations and at least one exact quote contains its mention. Normalized graph candidate/fact arrays remain
empty; normalized records/evidence/evidenceRecords hold provenance only.

Stage rejects caller-supplied EXPLICITLY_CONFIRMED/personId/resolutionDecisionId bindings. UNRESOLVED
and OWNER_ASSERTED_ANCHOR endpoints have null personId/decision; neither grants account ownership.
Publication/occurrence dates and precision stay distinct from retrieval. Null public proposal confidence,
currentness and relationship kind are retained; no numeric defaults are created. Required normalized
Evidence.confidence may use0 to represent unassessed evidence in a producer; this is never projected as
positive public relationship confidence. Public scoring/freshness and organization mapping remain separate
agreements. CONTEXT_ONLY/AMBIGUOUS/co-occurrence may be retained as unreviewed proposals but
never traverse. Even direct proposals remain PENDING here. CORROBORATED_DIRECT requires at least
2 declared independence groups; the producer must establish actual independence, not invent group IDs.

Explicit identity assignment uses the existing Person.identityConfidence convention (1 for the accepted
assignment), not a new public relationship/source-confidence score. Underlying evidence confidence/dates
are preserved. No MANUAL source/self-attestation is added to public evidence; resolution is recorded in
its separate identity ledger, and graph identities refer to their original public identity citations.

Documents/proposals have immutable revisions. Citation and evidence IDs are immutable: change them on
content/locator/source revision changes. Endpoints are keyed by owner scope/source/platform/externalId;
their server-derived revisions include identity citations and document metadata. Duplicate mentions of
one source identity must agree; equal names with different source IDs never merge automatically.
New source batches advance graphVersion even with identical graph collections, so metadata changes
serialize with graph/identity operations. A past revision cannot become current again through a new stage.
Identical evidence already materialized by identity review may be reused only after exact equality checks.

Exact full-request retries return the original receipt after current session/source and (for identity decisions)
endpoint/mapping authorization. Retain original expectedGraphVersion when retrying. Changed key payloads,
stale graph/source/endpoint/resolution revisions and changed canonical mappings conflict; revoked/foreign
sources fail closed. Stage/document-head updates or identity/graph/evidence/ledger writes all roll back on
failure or session expiry. Older texts/decisions remain private audit history, not silently rewritten records.

## Remaining gates

Producer/extractor must create actual proposals from permitted retrieved documents; the source-only
provider module returns no proposals. Root owns authenticated source orchestration and HTTP/UI ports.
Route-level public-citation acceptance, citation-aware graph projection, source/identity withdrawal
invalidation, reassign/revert and Ben/Shreev-approved public score/freshness policy remain unimplemented.
No live public record, provider query, real person or multi-hop route is claimed by this checkpoint.

Run `npm run build:server`, typecheck:server/typecheck:graph and focused tests/public-facts*.test.mjs.
Database suite allows only anonymous postgres://projekt1_test@127.0.0.1:55439/postgres and creates/drops
a random schema; it must never run against the private live database. Anonymous fixtures are tests only.
