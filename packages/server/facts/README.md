# Explicit private fact review

This module adds owner-attested decisions over canonical imported claims. It does not import people,
assign identities, contact providers, or compose HTTP routes. The observer approved the narrow contract
and `manual-attestation-v1` policy; graph ranking and target resolution remain unchanged.

## Composition

```ts
import {migrateFactsStorage} from './facts/migrate.js';
import {PgFactStore} from './facts/postgres.js';
import {FactReviewService} from './facts/service.js';
import {withFactWarnings} from './facts/search.js';

// After the existing migrations, before accepting traffic:
await migrateFactsStorage(pool, absolutePathToMigration003);
const facts = new FactReviewService({auth, facts: new PgFactStore(pool)});
const engine = withFactWarnings(existingEngine);
```

Route composition must apply the existing bounded JSON body, session-cookie extraction, same-origin
write/CSRF checks, and `apiFailure` mapping. Pass the opaque session token as `credential` (as for
BackendService), never the cookie header or a client-supplied actor. Public request/response types and
strict runtime validators are in `contracts.ts`; no shared contract was modified.

- `facts.review(credential, {scopeId})` returns canonical relationships and affiliations, including
  rejected/confirmed claims that may need correction, current graph version, exact affiliation keys,
  referenced display-safe evidence/sources and warnings. Use the existing authorized graph endpoint
  for people, organization labels and saved-contact observations.
- `facts.confirm(credential, {scopeId, expectedGraphVersion, idempotencyKey, confirm: true, change})`
  commits **one** explicit change. See the `FactChange` union for ACCEPT/REJECT variants.
- A relationship from an observation takes only `observedLinkId`. Storage derives endpoints and
  accepts only a canonical root-to-contact `CONTACT_SAVED` observation. The owner supplies kind,
  strength, statement and a separate `includeInSearch` choice. A subsequent correction selects the
  new relationship ID, not the observation again. New arbitrary third-party bridges are unsupported.
- Affiliation acceptance selects `personId` plus the exact `affiliationKey` returned by review;
  the owner explicitly chooses `current: true | false | null` and supplies a statement. Organization
  and role are preserved and must be displayed for confirmation. Unknown currentness stays unknown.
- `confirm:true` is required for rejections too. Rejections preserve observations/evidence and mark
  the selected claim rejected. Acceptance may subsequently correct a rejected claim.

Responses contain `schemaVersion:1`, `scopeId`, `baseGraphVersion`, `graphVersion`, `decisionId`,
`duplicate`, and one committed `BATCH_COMMITTED / REVIEW` event with `seq:0`, whose jobId is the
decisionId. There is no invented import lifecycle. The simplest UI behavior is cancel old playback
and reload the graph. Do not poll the import-job endpoint using a fact decision ID. The event is
validated against both committed snapshots. Collection order is not an adjacency signal.

Exact retries retain the **entire original request**, including expectedGraphVersion. After current
session/scope/source-policy authorization an exact retry returns the original receipt/version even
when the current graph has advanced. Any changed request under that key conflicts. New decisions
with stale versions conflict and write nothing. Reload to obtain a fresh affiliation key after any edit.

## Attestation and projection semantics

Every acceptance creates new immutable MANUAL/USER_PROVIDED evidence and retains original evidence.
Evidence summaries explicitly label the owner's statement as self-attested; raw provider records,
tokens, session hashes and ledger rows never enter responses. The private ledger binds actor, request,
before/after claim, evidence ID, source policies, inclusion choice, timestamp and result in one commit.

`manual-attestation-v1` fixes confidence to 1 for the explicit assertion, **not independent factual
verification**. Recency factor 1 means no decay model, **not proof of recent contact**. User strength
is a relative affinity assessment. Willingness, jobs/openings and unsupported role/location constraints
remain unknown. Install `withFactWarnings` around the existing engine so result warnings and path
uncertainties explain this; rankings, scores and trace order are preserved.

Only relationships with an explicit latest ledger inclusion choice, CONFIRMED state, non-UNKNOWN
kind, positive factors, and present relationship evidence/source/observation dependencies project
to edges. IDs are deterministic per relationship. No reverse edges, saved-contact priors, employment
adjacency, name merges or default inclusion are produced. Rejection or opt-out removes the derived
edge in the same transaction. False/null/rejected affiliations are excluded by the existing target resolver.

## Transaction and source lifecycle

Storage locks `app_sessions` before `private_scopes`, matching Contacts fix `315548e`, and keeps both
locks through commit. It rechecks database wall-clock session expiry after all lock waits/writes.
The scope lock serializes import/consent/review writes. Snapshot, manual source/evidence and decision
receipt either all commit or all roll back. Source-policy/ownership checks also apply to retries.

The baseline has no source-removal API. `projectConfirmedRelationships(graph, includedIds)` omits
edges when their sources/evidence/observations disappear; tests exercise this behavior. A future
source-removal transaction must retain the original dependency links, load the latest per-relationship
ledger `include_in_search` values, and persist that projection with its versioned removal. Disabling
a source without reconstructing the baseline snapshot fails closed on reads/review; this module does
not silently repair source deletion or add a removal endpoint. Contacts credential revocation retains
the owner's imported graph by existing policy.

## Verification

`npm run build:server`, `npm run typecheck:server`, `npm run typecheck:graph`.

The focused suites are `tests/facts.test.mjs` and `tests/facts.postgres.test.mjs`. Database fixtures are
anonymous, created in a random schema and removed afterward. The latter explicitly rejects any
`STORAGE_TEST_DATABASE_URL` outside `postgres://projekt1_test@127.0.0.1:55439/postgres` so it cannot
accidentally run on private live port 55440. No provider calls or real product records are involved.
