# Local frontend and API integration

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
