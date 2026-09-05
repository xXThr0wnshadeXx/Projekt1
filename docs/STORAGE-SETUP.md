# Private PostgreSQL storage milestone

`PgStore` implements `ReadPort`, `ImportPort`, and the agreed `AuthStore`. It persists actual verified Google account names/subjects, a private root and scope, hashed sessions, one-use OAuth transactions, sources, pending normalized imports, and the versioned canonical graph. It includes no demo data and never writes raw imports, tokens, passwords or provider responses to logs.

## Integration wiring (Ben)

Merge auth first: storage imports types from `packages/server/auth/ports.ts`. Add exact runtime dependency `pg@8.23.0` and dev dependency `@types/pg@8.23.1`; root package/lockfile remain the integration owner's responsibility. Import `Pool` from `pg`, `PgStore` from `packages/server/storage/postgres.js`, and `migratePrivateStorage` from `packages/server/storage/migrate.js` in the server composition.

```ts
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
await migratePrivateStorage(pool, `${process.cwd()}/migrations/001_private_storage.sql`);
const store = new PgStore(pool);
// Supply store to new GoogleAuth(config, store).
// BackendService({ auth: googleAuth, reads: store, imports: store, goals, engine }).
// Listen only after migration succeeds. On shutdown, await pool.end().
```

Ship `migrations/001_private_storage.sql` in the deploy artifact and run from the repository root. The migration runner takes a PostgreSQL transaction advisory lock, creates an applied-migration ledger, and compares the checked-in SQL SHA256 on every startup. Concurrent replicas cannot apply it twice. An edited already-applied migration fails startup; subsequent schema changes need a new migration and runner entry. This milestone contains one migration, no speculative migration framework. Use a separate dedicated app database/user with schema CREATE permission; never run integration tests against a database holding personal data.

Use the managed provider's required verified TLS configuration for external connections. Do not turn certificate verification off. Render's private internal database URL is suitable for an app in the same region; use the provider's documented settings for any external connection. No database credentials are provided by this commit. Public deployment, Google consent settings and real account login still need configuration and acceptance testing.

## Verified-account and session guarantees

Call `upsertGoogleUser` **only after** validating Google's ID token. Subject uniqueness plus a transaction creates exactly one user/private scope/root under concurrent first callbacks. The root name comes from that actual verified account, with no guessed acquaintances. Subsequent login preserves the existing root/scope. `getUser` and `listPrivateScopes` are server-internal methods; expose them only through authenticated routes.

OAuth state and browser bindings are SHA256 hashes. Nonce and PKCE verifier remain server-side in the short-lived transaction table. Conditional DELETE/RETURNING consumes a transaction only once and only for a matching browser and unexpired deadline. All AuthStore timestamps are epoch milliseconds. Session token hashes cannot be overwritten, reassigned or resurrected. `getSession` returns the stored expiry/revocation fields; **GoogleAuth performs expiry/revocation enforcement**. Schedule or opportunistically call `pruneExpiredAuth(Date.now())` to remove expired sessions/transactions; this maintenance method needs no background service.

## Source and import integration (Ben + Shaw)

1. After real source authorization, call `provisionSource({ actorUserId, scopeId, expectedGraphVersion, source, policyVersion, verifiedOwnerIdentity? })`. Derive actor/scope from the session and source IDs/policy from server state. `SourceSummary` is display-safe. Supplying a verified owner source identity creates its evidenced assignment to the private root; this identity **must be obtained from verified ownership**, never an HTTP client assertion or a guessed provider resource ID. Provisioning advances graph version; repeated identical provisioning returns its current version. No provider token is stored here.
2. Shaw produces `CandidateBatch` plus the agreed `NormalizedImportEnvelope` record/fact provenance. Resolve scope/source/batch/policy on the server. `BackendService.stageImport(...)` computes the canonical digest and calls the store. Storage independently recomputes digest, validates all references and ownership, and checks current source policy inside its transaction.
3. Staging creates a durable `PENDING_REVIEW` job and receipt; **it does not alter the canonical graph or its version**. The unique `(scope, source, batch)` receipt is checked before version/reference checks. Identical retries return the original job even after later graph changes. Different payloads for the same key return409. Imports and reviews serialize through the private-scope row; unrelated owners proceed independently.
4. `getImportReview(actorUserId, scopeId, jobId)` returns the safe candidate batch, job status, current version and committed events. It excludes private records/payload refs and checks owner/source policy again. Keep the review endpoint authenticated and private.
5. After the user reviews the imported people, call `approveImportObservations({ actorUserId, scopeId, jobId, expectedGraphVersion, idempotencyKey, personAssignments })`. Every candidate must have an **explicit** `{tempId, personId}` decision: `null` creates a distinct person; a selected existing person assigns only to that exact authorized person. Never default guessed identity matches to acceptance. Existing immutable identities cannot be moved by this operation; source identity relinking/undo requires the later dedicated ledger. A candidate `existingPersonId` proposal must match the explicit choice or the operation returns409.
6. Approval publishes people, explicitly accepted source identities and observed links. Relationship claims and affiliations remain `PENDING`; it invents no reverse links or SearchEdges. A second relationship/affiliation confirmation operation is still needed before these claims support search. Approval writes the new version, snapshot and durable construction events atomically. The three events are `IMPORT_STARTED`, `BATCH_COMMITTED(operationKind=REVIEW)` and `IMPORT_COMPLETED`, contiguous from0. They describe committed data, not fake animation progress. The delta passes the shared full-reconstruction validator. A duplicate review returns the original events/version before checking the now-stale request version.

`readSnapshot` rechecks owner/root and validates source references in storage; the caller-supplied scope object alone never authorizes data. Every query for jobs/sources uses owner+scope predicates. Foreign keys prevent attaching sources/jobs to a different owner. The snapshot stores only the display-safe graph, while private normalized record metadata stays inside its owner-scoped import job. Graph updates use a locked, versioned JSON document: suitable for this hackathon, with one writer per private network. Large snapshots/history, retention/source deletion, reversible identity ledger and fine-grained partial approval remain follow-ups. Do not expose arbitrary snapshot writes as an HTTP endpoint.

## Verification

The included `tests/storage.postgres.test.mjs` runs against **actual PostgreSQL**, in a randomly named temporary schema removed afterward. Set `STORAGE_TEST_DATABASE_URL` to an isolated test database, then run:

```sh
npm run build:server
node --test tests/storage.postgres.test.mjs
```

Without that environment variable the suite explicitly skips; a skipped run is **not** database validation. Storage was verified on a disposable local PostgreSQL12.15 cluster with12 passing tests. Production should use a supported managed PostgreSQL release. Tests cover concurrent migrations/account creation, cross-owner/source-policy and root isolation, concurrent duplicate receipt staging/approval, conflicting digests, first-request stale versions, rollback after database-triggered failure, canonical event replay, persistent reads through a new pool, BackendService retries after graph updates, one-use browser-bound OAuth state, expiration and revocation. Strict server TypeScript build passes. Anonymous test strings stay in tests only.

Not yet verified by this milestone: managed database connectivity/TLS, real Google login, actual contact retrieval or ingestion into the deployed app, browser review controls, supported introduction edges, and production operation. Node HTTP/main composition and root dependencies belong to Ben's integration branch and are deliberately untouched here.

Implementation reference: [node-postgres transaction documentation](https://node-postgres.com/features/transactions) requires all transaction statements to use the same checked-out client; PgStore does so with guaranteed rollback/release.
