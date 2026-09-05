# WarmPath production deployment

Audited from integrated commit `5996b12b503dd01f124681f866b380e665cb8659` on September 5, 2026. This is a configuration and local verification handoff, not a deployed-release claim. The observer owns account setup, reviewed integration publication and actual deployment. Keep PR #6 draft until remaining acceptance gates are resolved; no automatic main merge.

## Existing resources and concrete free service settings

The observer reports an AVAILABLE **warmpath-db**, ID `dpg-daea208n74is73cvmjhg-a`, **Free ($0/month)**, **Oregon**, **PostgreSQL 18**, database `warmpath`, user `warmpath_app`, expiring **October 5, 2026**. The observer is disabling external DB traffic. Reuse this database and existing Google project/Web OAuth client/People API. Profile and separately consented Contacts readonly scopes are approved; card verification is complete. Paid resources are not authorized. These account facts were supplied by the observer, not independently inspected by the deployment task.

Create/configure one Render **Web Service**, not a Static Site:

- Name: `warmpath-web` (the assigned public hostname must be verified separately).
- Repository: `https://github.com/xXThr0wnshadeXx/Projekt1`; branch: `feat/ben-integration`; root directory: repository root.
- Runtime: **Node**; instance: **Free**; region: **Oregon**.
- Build command: `npm ci --include=dev && npm run build`.
- Start command: `node dist/packages/server/main.js`.
- Auto-deploy: **Off**; health check: `/api/ready`; no disk, worker, preview or paid pre-deploy job.
- Deploy only the exact reviewed integration SHA selected by the observer. Branch selection alone does not pin a release to a reviewed SHA. Confirm the deployed commit in Render before acceptance.

[deploy/render.yaml](../deploy/render.yaml) is an optional **service-only** Blueprint matching these settings. Select that path explicitly if using a Blueprint. It neither creates nor manages the existing database: enter its internal `DATABASE_URL` privately. Use either manual setup or this Blueprint, avoiding duplicate services. `sync: false` prompts for configuration; it does not provide values. Auto-deploy off does not prevent the initial service creation from building/deploying. [Render Web Services](https://render.com/docs/web-services), [Blueprint reference](https://render.com/docs/blueprint-spec).

## Exact environment and OAuth settings

Set these literal nonsecret values:

```text
NODE_VERSION=22.19.0
NODE_ENV=production
HOST=0.0.0.0
PORT=10000
VITE_AUTH_MODE=http
```

Set the following account-specific values in Render's private environment UI:

- `APP_ORIGIN`: the **actual assigned HTTPS origin**, e.g. `https://<assigned-host>.onrender.com`, with no trailing slash, path, credentials or query. Do not assume the requested service name is the hostname.
- `DATABASE_URL`: existing `warmpath-db` **internal connection URL**, supplied by the account owner; do not reconstruct it from an ID or use the external URL. Same account and Oregon region are required for the private connection. External access restrictions do not block same-region internal connections. [Render Postgres connections](https://render.com/docs/postgresql-creating-connecting).
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: the existing Google Web application client. These are server configuration, never `VITE_` variables.
- `GOOGLE_CONTACTS_REDIRECT_URI`: exact `APP_ORIGIN` plus `/api/auth/google/contacts/callback`. This setting is **required** for Contacts and is not inferred.
- `PROVIDER_TOKEN_ENCRYPTION_KEY`: existing securely retained Contacts key. The runtime requires exactly **32 bytes encoded as canonical unpadded base64url (43 characters)**. It uses AES-256-GCM with owner/scope/source/Google-subject/token-kind binding. Keep the same key across restarts/deploys; replacing or losing it makes existing encrypted grants unreadable. Do not regenerate it for a deploy or use the smoke fixture key. Rotation/re-encryption is not implemented.

`GOOGLE_REDIRECT_URI` is optional: runtime derives `APP_ORIGIN` plus `/api/auth/google/callback`. If set, it must match exactly or startup fails. Configure **both** resulting full HTTPS callback URLs on the existing Google OAuth Web client. Retain existing local callbacks separately. Render terminates public TLS; Node listens on internal HTTP. Secure cookies and OAuth/origin checks use configured `APP_ORIGIN`, not a forwarded header or internal listener URL. [Render port and TLS behavior](https://render.com/docs/web-services).

There is no `SESSION_SECRET`, provider-token key alias, AI API key, or environment flag that installs retrieval in this checkpoint. Session tokens are hashed in Postgres. Vite embeds build-time `VITE_` values into public assets, so only `VITE_AUTH_MODE=http` belongs there. The integration owner maintains the private env-file runner; this handoff does not add a competing runner or read/copy `private-data/server.env`.

## Actual runtime and migration behavior

The existing `main.ts` already composes Node HTTP, the real PostgreSQL store, Google identity/Contacts adapters, the evidence-backed goal resolver and bounded graph search. `createApplication` mounts `dist/web` and `/api` on the same origin in production. No composition patch remains to be applied from the old deployment milestone.

Startup opens a pool (maximum 10 connections), applies **001_private_storage.sql followed by 002_contacts_grants.sql**, prunes expired auth transactions, verifies the built web entrypoint, then allows listening. Both SQL files must ship in `migrations/`; TypeScript compilation does not copy them. Each migration has its own transaction, advisory lock and SHA-256 entry in `app_migrations`. Restart skips unchanged applied migrations. A checksum mismatch or SQL/connection failure prevents the process from listening and logs a generic startup failure. Migration 001 remains committed if 002 fails; after fixing the cause, replay resumes at 002. Never edit applied SQL or clear migration history to bypass the check. No public migration endpoint is provided.

The migrations use ordinary tables, composite unique/foreign-key constraints, JSONB `->>` checks, regular expressions, bigint and timestamptz; they require no extension or superuser. The local smoke executes both as a non-superuser database/schema owner, verifies their digests, and replays them through a process restart. PostgreSQL 18 documentation supports these constructs; no SQL syntax incompatibility was found by inspection. **Execution was on local PostgreSQL 12.15, not PostgreSQL 18.** PostgreSQL 18 startup/schema privileges remain a host verification gate. `warmpath_app` must have ownership/CREATE rights in the target schema plus normal table access; the deployment task has not inspected or changed live grants. [PostgreSQL 18 CREATE TABLE](https://www.postgresql.org/docs/18/sql-createtable.html), [JSON operators](https://www.postgresql.org/docs/18/functions-json.html).

Native Render deployment retains SQL in the checkout and runs from its root. Startup migration also avoids reliance on shell access or one-off jobs, unavailable on Free. The portable Dockerfile copies the built Node/browser artifacts and both migrations, prunes development dependencies and runs as `node`. Its health check uses `/api/ready`. **Docker is unavailable locally; no image was built or run.** Native Node is the tested deployment recipe. If Docker is selected later, build/run verification is a separate gate. There is currently no `public/` directory; revisit explicit Docker build-stage copies if frontend assets/layout change.

## Readiness means infrastructure, not demo acceptance

- `/api/health`: GET/HEAD 200 for process liveness, even during a DB outage.
- `/api/ready`: GET/HEAD 200 when storage, configured identity OAuth and search adapters exist and a bounded database `SELECT 1` succeeds. Missing adapters, connection failure, thrown checks or the 1.5-second probe deadline produce generic 503. Probes share concurrent work; pool connection acquisition is limited to one second. No Google call occurs per probe. Render uses this endpoint to gate traffic. [Render health checks](https://render.com/docs/health-checks).
- Missing/malformed Contacts callback or encryption key is caught by composition and disables **Contacts only**. Login and readiness may still succeed. A valid-looking but incorrect client secret likewise is not verified with Google by readiness.
- At the audited SHA, `main.ts` does **not inject a retriever**. Authenticated `POST /api/imports/google` returns `502 SOURCE_UNAVAILABLE` while readiness can return 200. No Render environment value can supply missing code. Shaw/Ben must integrate and verify the reviewed adapter. Readiness also does not prove People API permissions, an active consent grant, usable real data, an evidenced route, browser event playback or Contacts race fixes.
- Unknown `/api` routes stay JSON 404. Signed-out graph/search return 401 with valid request shape/origin. SPA fallback applies to extensionless HTML navigation, not JSON fetches or missing assets. Static routing refuses dotfiles, traversal, escaped symlinks and disallowed file types including source maps. HTML is no-store; hashed assets are immutable. Never place personal files in `dist/web`.

## Repeatable local production smoke

From an isolated checkout, build with the lockfile, then run:

```sh
npm ci --include=dev
VITE_AUTH_MODE=http npm run build
PG_BIN=/absolute/path/to/postgresql/bin node deploy/smoke-production.mjs
node --test tests/deployment-runtime.test.mjs tests/application.test.mjs
```

On the verification machine `PG_BIN=/Library/PostgreSQL/12/bin`. PostgreSQL binaries must already exist; the script installs nothing. Loopback permission is required. This is a dedicated gate, not part of root npm scripts. It **accepts no database URL or env file**, strips inherited provider/DB/Node options from child environments, creates its own temporary loopback-only cluster and non-superuser test database, and deletes it after stopping its processes. It runs actual `dist/packages/server/main.js` with production mode and a reserved HTTPS `.invalid` origin, using two anonymous test accounts/sessions solely in that cluster. Authorization URLs are inspected without following them; no live Google callback or provider retrieval is attempted.

The gate checks built Vite assets/navigation/HEAD/cache behavior, static/API isolation, real 001/002 startup and replay, signed-out and other-owner rejection, origin enforcement, actual search's honest no-target result, configured callback/Secure-cookie attributes, unavailable retrieval despite readiness, restart persistence, logout and DB-outage 503 versus liveness 200. It checks HTTP headers on loopback, not browser TLS/cookie delivery. Existing deployment tests additionally exercise traversal, symlinks and readiness timeout. This does not seed product data or prove a successful real import.

Observed September 5: Node 22.19.0 production build passed; production smoke passed against PostgreSQL 12.15; all **14** selected deployment/application tests passed, zero skips. Build used existing integration dependencies via a temporary local `node_modules` symlink, not a fresh `npm ci`; no package or lockfile changes. Initial sandbox-only socket runs failed with EPERM, then passed with authorized loopback execution. Full integration tests and clean installation remain the integration owner's gate on the final combined SHA.

## Remaining release and rehearsal gate

1. Integration owner resolves/reviews the two Contacts findings in OBSERVER-HANDOFF.md, injects Shaw's reviewed retriever, resolves the frontend/server event sequence mismatch, and supplies explicit supported relationship/current-affiliation review and search projection. Reconcile those historical findings against the **final** integration SHA; this audit does not claim fixes absent from its baseline. Run clean install, integrated typechecks/tests/build and this production smoke on that SHA.
2. Observer confirms exact nonsecret settings, existing key/client values, both production callback registrations, external DB access disabled, and free plans. Publish the reviewed integration commit and manually deploy that exact commit. Verify PostgreSQL 18 startup/migrations and actual HTTPS `/api/ready` 200; a healthy probe alone cannot approve the demo.
3. On the assigned HTTPS URL, a consenting participant completes real identity login, separate Contacts consent, retrieval, private review/commit, graph rendering, supported goal/ranked path and actual event playback. Confirm no fabricated route when evidence is insufficient. Verify Secure-cookie delivery, browser refresh and logout, retained imported records after restart, signed-out API rejection and another account's inability to read/search the owner's scope. Keep records/tokens out of public logs and handoffs.
4. Rehearse on the presenting account/device by September 6 at 1 p.m. Pacific; deadline is 2 p.m. Open the app before rehearsal: Free services sleep after 15 idle minutes and may need about a minute to wake. Free local files are ephemeral; the DB has 1 GB capacity, a 30-day lifetime and no managed backups. Arrange any authorized private export before the reported October 5 expiry; no paid upgrade is implied. Account verification does not remove usage limits or guarantee availability. [Render Free limitations](https://render.com/docs/free).

Until these gates pass, report **production configuration/local smoke verified; live provider, PostgreSQL 18 and end-to-end release acceptance pending**. No deployment or main merge was performed by this task.
