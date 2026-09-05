# Local frontend and API integration

**Current status:** graph relay composition is complete and the full integration gate passes (196 tests with actual disposable PostgreSQL). Earlier milestone sections below are historical; the latest graph-relay section supersedes their graph-unavailable statements. Live user consent/import/deployment acceptance remains outstanding.

Ben's feature branch reconciles main `7e4aef46e268247622934f284c396325824354bd` with backend correction `3873a0f83425b7136ec6c4b0d34777d72863f352`. Nicolas's `src/` and Shreev's graph implementation are preserved without edits. No public deployment or account creation is included.

## Run

Use Node 22.19+ from this repository root:

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173/**. The API listens only on **127.0.0.1:3001**; Vite proxies `/api` to it. Use the exact browser origin above because POST origin checks reject other origins, including `localhost`. `Ctrl-C` stops both processes. Port conflicts stop the run rather than selecting an unexpected port. Restart `npm run dev` after server TypeScript edits; Vite reloads browser edits. Integrated development forces HTTP auth and rejects a conflicting `VITE_AUTH_MODE`; no preview identity is created. No credentials or database are needed to inspect the signed-out UI.

`npm run build` compiles the server to `dist/packages/server` and the browser to `dist/web`. `npm run preview` is Vite's static preview only; it is not the integrated API procedure. Browser compiler config is `tsconfig.json` (Bundler/DOM), server is `tsconfig.server.json` (NodeNext/strict), and graph is checked separately with `tsconfig.graph.json`. Dependencies are exact-pinned in the npm lockfile; no frontend framework conversion was performed.

## Actual endpoint boundary

- `GET /api/session`: exact frontend-compatible actor/scopes response when a verified adapter exists; currently 401, which Nicolas's HTTP gateway treats as signed out.
- `GET /api/auth/google/start`: full-page browser navigation, currently 502 `SOURCE_UNAVAILABLE`. There is no simulated redirect or Google session. Reserved `GET /api/auth/google/callback` also fails explicitly until implemented.
- `POST /api/auth/logout`: same-origin request, calls the revocation port and clears the HttpOnly, SameSite=Lax cookie; current composition has no persisted sessions and returns 204. Actual durable revocation remains an adapter requirement.
- `GET /api/graph?scopeId=...` and `POST /api/search`: route through `BackendService`, preserving actor/scope checks, runtime validation, graph versions, search-input binding and caps. Without verified auth they return 401. The current UI still passes `snapshot={null}` to GraphViewport; authenticated graph fetching/playback remains Nicolas's integration handoff.
- `GET /api/health`: process availability only. It does not claim database, OAuth or engine readiness.

POST requests require the configured browser Origin. Search accepts bounded JSON (16 KiB), rejects unsupported content types and malformed requests, and never accepts client actor/root overrides. Responses are no-store; errors never serialize exception details. Session cookies are opaque and tokens/raw imports are not returned. This local server is not a hardened production host: real rate limiting, durable sessions, OAuth callback protection and database access need their own integration gate.

## Checks actually performed

- 98 tests pass: prior 93 contract/service regressions plus 5 HTTP integration cases covering actual sockets, session DTO/cookies, Google-unavailable routes, logout origin/revocation, graph/search authorization/versioning and JSON/body limits.
- Browser/server typechecks and Vite/server builds pass.
- `npm run typecheck:graph` **fails** on main's `3dc3a8d` graph code: `searchId` self-shadowing, nondistributive event Omit and unchecked indexed access. No graph engine is loaded into the running API. `npm run check:integration` includes this failing graph gate; this milestone is not a complete integrated graph app pass. Shreev owns corrections; newer remote owner commits are not silently merged here.
- Browser opened the actual WarmPath landing page, verified the empty graph text and Google-only sign-in dialog. Google-start full-page navigation was blocked by Chrome with `ERR_BLOCKED_BY_CLIENT`; no bypass was attempted. Independent requests through the Vite proxy verified `/api/session` 401, `/api/auth/google/start` 502, and same-origin `/api/auth/logout` 204.
- In Codex's restricted shell the socket tests initially failed with `listen EPERM`; they passed when run with loopback binding permission. The normal local Node runtime can bind these ports.

## Next setup action (not performed)

The selected host for this milestone is local Vite + Node, not a cloud provider. Before real sign-in, the account owner should identify an existing Google Cloud project and a private PostgreSQL database/role. Ben then implements and tests the verified adapters; setting environment variables alone does not enable this stub.

1. In the chosen Google project's OAuth configuration, prepare a **Web application** client and selected test users. Register exactly `http://127.0.0.1:5173/api/auth/google/callback` as the local authorized redirect URI. Reserve `http://127.0.0.1:5173` as the application origin. Redirect URI must match the request; Google's web-server rules allow localhost IP exceptions for local development. [Google web-server OAuth documentation](https://developers.google.com/identity/protocols/oauth2/web-server)
2. Keep planned server-only settings `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_ORIGIN=http://127.0.0.1:5173`, `GOOGLE_REDIRECT_URI=http://127.0.0.1:5173/api/auth/google/callback`, and private `DATABASE_URL` outside Git and outside all `VITE_` variables. These are adapter configuration names reserved for the next milestone, **not consumed by the current composition**. Do not paste secrets into the issue or chat.
3. Supply a private PostgreSQL connection through the local secret environment, with a dedicated application role/database (loopback access for local PostgreSQL; TLS for an approved remote database). Ben must add migrations for verified users, opaque hashed expiring sessions, private scopes/source ownership and atomic import receipts before first real import. No database was selected, created, connected to, or migrated here.
4. Implement server authorization-code handling with state/nonce checks, ID-token verification, server-only credentials, and durable session issuance/revocation. Use Google subject identity rather than email as the stable account key. Initial sign-in requests identity/profile only; contacts require a separate later consent flow. [Google OpenID Connect documentation](https://developers.google.com/identity/openid-connect/openid-connect)

Coordinator owns any cloud host choice, deployment, actual user setup request and publication. Remaining owner handoffs: Nicolas authenticated graph loading and errors; Shreev corrected engine + strict contract integration; Shaw normalized provenance envelope; Ben verified OAuth/private storage adapters.

## Issue #2-ready status

Ben: main frontend `7e4aef4` reconciled on `feat/ben-integration`; Vite/React preserved. Local UI + Node API run with `npm ci` then `npm run dev` at http://127.0.0.1:5173/. Browser/server checks and 98 tests pass. Main's graph check still fails separately; owner fix is pending integration. OAuth/DB remain explicitly unavailable (session 401, Google start 502); no fake graph/session or public deployment. Actual API routes match Nicolas's code: GET session, GET auth/google/start, POST auth/logout. Setup instructions are in docs/LOCAL-INTEGRATION.md. Commit supplied in the final handoff; publication remains with command.

## PR #6 reconciliation with main c728c55

Merged main `c728c55` into the existing feature history without rebasing or changing main. Preserved `src/vite-env.d.ts`, the renamed `docs/team/NICOLAS.md`, all upstream name corrections, and `*.tsbuildinfo` alongside private-data/secret ignore rules. Nicolas's UI and graph implementation match main exactly. The existing Vite proxy/loopback config and split browser/server compiler targets remain intact.

Resolved the add/add lockfile conflict by regenerating against the feature package's exact pins: TypeScript 5.9.3, Vite 7.3.6, React plugin 5.2.0, React/ReactDOM 19.2.8, React types 19.2.18/19.2.7 and Node types 22.20.1. Main's new lock selected TypeScript 7.0.2/Vite 8.2.2/plugin 6.1.1 from `latest` ranges; this reconciliation deliberately avoids an unrelated major toolchain migration while retaining the same React packages and declared Node 22.19+ runtime. `npm ci` succeeded from the regenerated lock.

Verification: browser/server typechecks and production build pass; all 98 tests pass. `npm run check:integration` fails at the unchanged graph compiler errors (tests were also run independently). `npm run dev` restarted successfully on ports 5173/3001; live proxy smoke checks returned frontend 200, session 401, Google start 502 and logout 204. No actual OAuth, private database or search-engine composition is enabled.

Observer publication handoff for issue #2: publish the reconciliation merge commit reported in the task, update existing draft PR #6, and post one PULL COMPLETE / PR READY update. Main `c728c55` is incorporated; frontend/name/type additions are preserved; install/build/98 tests pass; graph gate remains blocked awaiting approved PR #3 integration. Ben's human next action is to select the Google project/test users and private database access described above. No teammate should blindly pull the feature branch into an active checkout; publication and merge decisions remain with the observer.

## Parallel auth dependency handoff

Main-conflict reconciliation completed in merge commit `396c17a546b288fba8efefa111caa6701a0db3da` (parents `a97bd50` and `c728c55`). It is ready for observer publication; this task has not pushed it. The separate auth agent requested the exact runtime dependency `google-auth-library@11.0.2`; it is now pinned in the root package and lockfile. This dependency-only change does not contain or enable the auth module, OAuth routes, database, or deployment agent work. Existing browser/server typechecks, build and all 98 tests still pass. The previously reported graph gate remains separate. Root retains sequential review/integration of the isolated auth, storage and deployment commits; this worktree retains root configuration and HTTP/service composition ownership.

## Login, PostgreSQL and production composition (current)

This section supersedes the earlier unimplemented-composition notes above. Integrated stable owner commits: auth `82d2da6` (cherry-pick `7809bd7`), deployment `f42e5e9` (`7c28b6c`), and storage `51c2dbd` (`0252647`). Their implementation files were not edited. Runtime dependencies now also pin `pg@8.23.0` and development types `@types/pg@8.23.1`.

`main.ts` now starts `createApplication` from `application.ts`: validated runtime config, optional real PostgreSQL pool, awaited `migratePrivateStorage` and expired-auth cleanup, then GoogleAuth/PgStore/BackendService composition. Migration failure closes storage and stops startup before listening. No database means no substitute persistence or fabricated auth. Partial Google configuration fails closed. Google callback is derived from runtime origin and supplied to auth config; any explicit conflicting callback is rejected by runtime validation. `APP_ORIGIN`, Google settings and `DATABASE_URL` are now consumed by the composition, unlike the earlier stub.

`http.ts` exports `createApiHandler`, retaining `createApiServer` compatibility. Google start returns the adapter's 302 and complete Set-Cookie array. Callback passes original URLSearchParams and raw cookie header, preserving duplicate detection; success returns all cookies and the adapter redirect, while error clears the OAuth transaction cookie and sanitizes the response. Existing session/logout/graph/search protections remain in place. Source provision/review/Contacts routes are not added in this milestone; durable staging is still distinct from a visible reviewed graph.

Production uses the supplied same-origin static/API handler. Readiness requires successful migration, real auth/storage configuration, installed goal/search adapters and a bounded abort-aware DB probe. The current main composition intentionally has **no search/goal adapters**, so `/api/ready` remains 503 until approved graph integration. Missing auth/storage also keeps readiness false. `/api/health` reports only process liveness. Shutdown stops acceptance, allows a bounded five-second grace period, then closes connections/exits. Pool connect/query limits and readiness cancellation bound database probes. No provider request is made by readiness.

`npm run dev` keeps browser origin http://127.0.0.1:5173 and API 127.0.0.1:3001, rejects conflicting local APP_ORIGIN/callback settings, and forces HTTP auth. Production uses validated `NODE_ENV`, `APP_ORIGIN`, `HOST` and `PORT` from the deployment instructions. Neither mode loads a secret file automatically; supply server-only environment settings through the approved host/process setup. The scratch PostgreSQL cluster used for tests was never configured as the app's DATABASE_URL.

Verification: 146 tests pass with zero skips, including 20 auth tests, 5 deployment tests, 12 actual PostgreSQL storage tests in a disposable schema, and 11 new HTTP/startup/config/readiness composition tests. Browser/server typechecks and build pass. No actual Google user login, managed database connection, container build or deployment has been performed. The old graph check is still the separately reported blocker, and no claim is made that the real-data demo or readiness gate is complete.

Publication handoff: observer publishes the three integrated owner commits plus the final composition commit reported in this task, updates PR #6, and posts a single issue #2 handoff. Next: approved graph/goal adapter integration, actual Google/Render environment setup already owned by command, then the separately reviewed Contacts consent/credential commits and source-provision/import-review HTTP boundaries. Do not conflate this tested composition with a live successful Google callback or imported network.

## Explicit Contacts consent composition (current addition)

Integrated Contacts auth `cc02db8` as `ea96bdc`, followed by Contacts storage `21d4266` as `6522d52`; no changes were made to the owners' module implementations. `openPostgresStorage.migrate()` now awaits migration 001 and then 002 before pruning expired auth/Contacts transactions and returning for listening. A real PostgreSQL composition regression applies both twice and verifies their migration ledger entries.

The application constructs `GoogleContacts` only with configured login, durable storage and valid explicit Contacts callback/encryption settings. Missing, partial or invalid Contacts settings disable this feature without failing existing identity-login composition. Contacts is optional for the current readiness formula; the separately missing search adapters remain the readiness blocker. See docs/CONTACTS-AUTH-SETUP.md for the exact Google callback and secret configuration managed by command.

HTTP contract implemented:

- Same-origin `POST /api/auth/google/contacts/start` accepts strictly `{scopeId}`, passes the session cookie to the Contacts adapter, sets its binding cookie array, and returns 200 `{authorizationUrl}`. It never redirects a fetch to Google and never accepts client actor IDs.
- `GET /api/auth/google/contacts/callback` preserves original duplicate query parameters and raw cookies. Success sets the returned cookie array and sends 303 only to the fixed application root. Failure sanitizes the error and clears only the Contacts transaction cookie, even if Contacts has become unavailable; the login session cookie is not cleared.
- No access-token, refresh-token, import or review endpoint was added. `createApplication().contactsAccess.getFreshAccessToken(credential, sourceId)` is the bound **server-only** facade for Shaw's forthcoming bridge. Its secret result must never be serialized to clients. Current token refresh/encryption/subject/scope checks remain in the reviewed Contacts module. Source registration after consent is not an imported/reviewed visible network.

Checks: 190 tests pass with zero skips using only the authorized disposable PostgreSQL test cluster for database tests; web/server build passes. Includes both owner suites, HTTP response/cookie/origin/input/redirect boundaries, missing-config login isolation, and migration order/idempotence. No live Contacts consent, provider records, source counts, Google refresh, real-user login or deployment is claimed.

Root publication handoff: publish the two cherry-picked owner commits plus the final consent composition commit reported by this task; update PR #6 and issue #2 once. Next bounded work is reviewed graph/goal composition when exact commits arrive, then server-side retrieval/import/review APIs. Root owns all actual Google/Render settings; no credentials were requested or exposed here.

## Graph relay composition (current)

Merged the complete `feat/shreev-relay` history at `b31cc491bc02e28c187169e6dbf778256a07d081`, including corrected PR #3 base `a25d3cc`, the zero-relevance contract fix `e6e9f89`, and the preserved target resolver plus GoalPort adapter. No root package/lock/contracts conflicts occurred. Existing HTTP/auth/Contacts/storage composition and Nicolas UI were preserved; frontend PR #7 was not integrated or edited.

Production `main.ts` now supplies `new EvidenceBackedGoalResolver()` and `new BoundedRouteSearch()` to `createApplication`. The graph target uses strict server/NodeNext settings so the resolver's Node crypto import is typed correctly; browser settings remain separate. No observations are promoted into friendships or introduction edges. The engine consumes only the validated snapshot's search projection. Goal matching stays conservative: current confirmed organization affiliations with appropriate evidence may match; unsupported requirements stay unknown, and former/unknown-current affiliations do not become current-company targets.

Verification: `npm run check:integration` now passes completely—web/server typechecks, graph typecheck, and 196 tests with no skips using the authorized disposable PostgreSQL test environment. The web/server production build passes. Tests include the relay's real-validator and actual BackendService path cases plus a new real PostgreSQL session -> HTTP -> resolver -> engine regression yielding an honest unsupported-goal result. Readiness can now become true when real auth/storage are configured, migrations succeed and the DB probe passes; Contacts config remains an independent optional feature. Passing test readiness is not a live Google login or deployed readiness claim.

Root publication handoff: publish the reconciliation merge commit reported in this task and update PR #6/issue #2 once. Both parents and the complete relay history are preserved. Current blockers move from graph compilation to real environment/user acceptance and the next source import/review API milestone. No independent push, main merge, real account creation, real-source import or deployment occurred here. The source bridge owner remains active; integrate only its exact reviewed commit when relayed by root.

## Nicolas frontend merge e80cc4d

Merged origin/main `e80cc4d` (including `a5dd486` authorized graph/search API client and the editorial gameboard redesign) into the current backend history without conflicts. Frontend source is preserved exactly; root backend dependency pins and all auth/Contacts/storage/search composition remain unchanged. Full integration check passed with 196 tests and no skips against the authorized scratch PostgreSQL database; production build passes (34 browser modules).

Known owner issue remains explicit: `src/main.tsx` in this upstream frontend checks delivered event sequence against `index + 1`, while the backend contract delivers zero-based contiguous sequences. That will reject valid search playback. Nicolas's reviewed sequence-fix handoff/PR #7 remains required; no frontend fix was silently included in this merge. This build pass does not prove real event playback or a live user flow.

Root should publish the frontend merge commit reported by the task after the preceding graph milestone, and post its exact SHA/checks in issue #2. Import bridge/API composition follows as a separate bounded commit.

## Google import HTTP composition

Frontend merge is `08b75c8e69026b9cbe9ad64d403dcd0590323814`. Cherry-picked the stable import bridge `18bce73cccf6bbcae5e8b55e26f73a2eb8f639e5` as `ad8f305`; owner bridge/storage implementations are preserved.

The application now injects `RetrieveAndNormalizeGoogleContacts` into `GoogleImportBridge` through `createApplication` options. Production has no retriever installed yet: authenticated import starts return `SOURCE_UNAVAILABLE` (502) before any token refresh/provider call. Root can connect Shaw's reviewed entrypoint through this seam. Existing staged jobs can still be reviewed and approved when login and durable storage are configured.

Thin HTTP routes are available:

- `GET /api/sources?scopeId=...` returns `{scopeId,graphVersion,sources}` from the owned persisted graph snapshot's source summaries.
- Same-origin `POST /api/imports/google` accepts exactly `{scopeId,sourceId,expectedGraphVersion,idempotencyKey}` and returns the bridge job receipt with status 202.
- `GET /api/imports/:jobId?scopeId=...` returns the bridge's safe review DTO.
- Same-origin `POST /api/imports/:jobId/approve` accepts exactly `{scopeId,expectedGraphVersion,idempotencyKey,confirm:true}` and returns the approval receipt. Job identity comes only from the route; client actor IDs and person assignments are rejected.

The routes pass the extracted opaque session token to the authorized bridge, preserve bounded JSON validation and sanitized failures, and expose no raw normalized records or credentials. Import review/explicit approval remains distinct from search-edge creation.

Verification: full `npm run check:integration` passed with 209 tests, zero failures and zero skips using the authorized disposable PostgreSQL test database. Production server/browser build passed. Added route boundary tests and a real PostgreSQL application regression for persisted sources and missing retrieval. No live provider retrieval, real-user consent or deployment was performed. Nicolas's upstream event-sequence issue remains pending its owner fix.

Root publication handoff: publish the frontend merge, bridge cherry-pick and final import HTTP composition commit reported by this task; update PR #6 and issue #2 once. This worktree has not pushed or modified main. Next action is to connect Shaw's exact reviewed retriever and integrate Nicolas's sequence fix through root.

## Stopping checkpoint for the next observer

Implementation is stopped at `2e297ff7fea7ce564b63a10d7579ad7ba70223b3` on `feat/ben-integration`. The working tree was clean before this documentation-only checkpoint. Completed validation remains: `npm run check:integration` passed all 209 tests with zero skips against the disposable test database, and `npm run build` passed server compilation and the 34-module browser build. No validation is still running in this task. No new implementation milestone, push, main update or deployment was started.

Running processes observed at handoff: existing `npm run dev` PID 59375, runner PID 59420, API PID 59421 listening on 127.0.0.1:3001, and Vite PID 59422 on 127.0.0.1:5173. These predate the latest commits and were not restarted or claimed to serve the latest server composition. PostgreSQL test PID 60373 listens on 127.0.0.1:55439; the separate local live cluster PID 67153 listens on 127.0.0.1:55440. All were left running and unchanged. Process IDs are a point-in-time observation and should be rechecked before operating on them.

Command reports the empty `projekt1_live` database is ready on 127.0.0.1:55440, with required settings in ignored mode-0600 `private-data/server.env` and operations instructions in `private-data/LOCAL-DATABASE-OPERATIONS.md`. This task did not read the secret file, rotate keys, connect the application to that database, or verify live migrations/readiness. Google private-data scope approval is still pending; do not start private-data access before that approval.

Precise remaining gaps for the next observer:

- Publish the verified frontend merge, bridge cherry-pick, import composition and this documentation checkpoint through command's normal review flow.
- Connect Shaw's exact reviewed `RetrieveAndNormalizeGoogleContacts` entrypoint in production composition; authenticated starts currently return `SOURCE_UNAVAILABLE` by design.
- Integrate Nicolas's owned event-sequence fix: the preserved frontend expects one-based sequences while backend events are zero-based.
- After required scope approval and reviewed environment setup, restart the application with the intended live configuration and verify migrations, readiness, login/Contacts consent, persisted source listing, import review, explicit approval and UI behavior using authorized data. None of those live acceptance checks is implied by the synthetic/disposable test suite.
- Keep private-data files out of publication. No deployment or real-provider access has been performed by this task.

No further implementation work is scheduled here. Root/new observer owns continuation and publication.

### Additional Contacts review follow-up

Command reports that the observer automation is paused. The independent Contacts review is at `/Users/benjamindemayo/Documents/GitHub/work/projekt1-contacts-review.md`. It reports two reproduced P2 findings on `5c7f80a`, which the next observer must verify against the current implementation and route for fixes:

- The callback can commit a Contacts grant after logout because session validity is not rechecked transactionally at grant commit.
- Early refresh rejects an access token that is still valid during its final 60 seconds when no usable refresh token exists.

These findings are carried forward from the independent review; this stopping task has not independently reverified or fixed them. Passing integration tests does not resolve either finding. No fixes or new validation were started, and continuation remains with the next observer.

## New observer bounded integration checkpoint

Resumed from published `5996b12` under observer task `01a073d1-23ca-7ad2-ae8e-d2ba5101362e`. Cherry-picked Shaw's exact two PR #4 commits `23c3269` and `7e30d3ca4aaa12161d43e39f3aea52a22b14f0c6` as `87c5dea` and `a253dd6`, preserving authorship. Cherry-picked the exact PR #7 zero-based event fix `bd3b223bc182c40871766158f9c17285fd67aa1b` as `7a704cf`, retaining its recorded author (shreev2703). The prior frontend sequence mismatch is resolved by that one-line owner commit; live playback remains unverified.

Shaw's head contains only normalization of supplied People API connections. Provider fetch, pagination, retries/cancellation and a production `RetrieveAndNormalizeGoogleContacts` entrypoint are absent. No replacement retriever was invented. Strict NodeNext verification reproduced TS2835 on the normalizer's extensionless type import; the only parser-file integration adjustment adds `.js` to that type-only contracts import. Root server compilation now includes the normalizer. Runtime tests verify authorized source/root references, current/former affiliation preservation, empty/malformed optional fields, and saved-contact observations without inferred relationships. No shared contract or graph-engine changes were needed.

Prepared private configuration runners, without executing them against private settings:

- `npm run dev:private` compiles the server, then loads `private-data/server.env` and starts the paired existing dev runner. To use a different existing file: `npm run dev:private -- /absolute/path/to/server.env`.
- After `npm run build`, `npm run start:private -- /absolute/path/to/server.env` starts the production server from that file; default is `private-data/server.env`. Production mode still requires its matching origin/callback/static configuration.
- File values override stale inherited configuration. The loader requires an owned regular file with no group/other permissions, supports Node dotenv quoting without shell evaluation, and reports generic load errors. It rejects private-file `VITE_*` and Node loader-option settings. Dev gives Vite only basic process/terminal environment and fixed HTTP auth mode; server secrets stay with the server. Signals are forwarded to the launched process. Existing local origin validation still applies.

Checks: `npm run build` passed strict server NodeNext compilation and browser typecheck/build (34 modules); `npm --prefix packages/ingestion run check` passed Shaw's types and structural checks; 24 focused tests passed with zero skips via `node --test tests/ingestion-integration.test.mjs tests/private-env.test.mjs tests/http-imports.test.mjs tests/http.test.mjs tests/application.test.mjs`. No full suite was repeated and no database/provider was used by this milestone's checks. Secret-file contents were not read, keys were not rotated, and running app/database processes were not restarted or stopped.

Remaining gates: Shaw's reviewed real provider entrypoint; the separate contacts_fixes agent's two Contacts regressions and independent review; supported relationship/current-affiliation review/search projection; authorized live acceptance and browser playback. Observer reports profile sign-in plus separately consented contacts.readonly are now explicitly approved, superseding the earlier pending-scope note; no live provider test was included in this assignment. Render verification is user-owned and pending. Root retains publication/main integration; this task did not push, pull or merge main. Stop after this checkpoint and report to the new observer.

## Reviewed optional Google retrieval composition

After direct user approval in this implementation task, integrated reviewed retriever `e22ff4a` as `9dc0240` and installed `createGoogleContactsRetriever()` at server startup. Application composition wraps the injected function with `withGoogleRetrievalErrors`: rate limit -> RATE_LIMITED/429; invalid server context -> INTERNAL/500; other fixed retrieval failures -> SOURCE_UNAVAILABLE/502. Unknown adapter exceptions become generic INTERNAL/500. Provider401/403 do not invalidate the application session or expose provider response text.

Retrieval is unavailable before credential/provider access when Contacts configuration or the injected retriever is absent. The configured retrieval flag now also requires configured Contacts. Existing session/scope/source checks, same-origin strict HTTP input, fresh consent-bound credentials, full provenance envelope validation, staging and explicit review/approval remain intact. No parser, auth/storage, graph, facts or frontend implementation was changed. Google remains an optional adapter; link-first LinkedIn/Instagram public discovery is the core product and remains separate work.

Verification: `npm run build` passed strict server and browser compilation/build; focused HTTP/application/ingestion suite passed (26 tests, zero failures/skips); `npm --prefix packages/ingestion run check:retrieval` passed strict NodeNext assignability and all19 offline transport tests. New HTTP tests exercise actual bridge and application wrapper wiring, sanitized failures, retained session after provider401/403, no staging on retrieval failure, and no transport under missing session/scope/consent/configuration or client token override. No private configuration or live database was used for these tests.

The existing OAuth runtime at `b6cfde1` (session66301) was NOT restarted. Build artifacts on disk are newer than that running process; observer must coordinate any restart or live Google request. No live retrieval, new scopes, paid services, push or deployment occurred. The earlier automatic-approval block is resolved by direct user authorization; it is not an outstanding integration blocker.
