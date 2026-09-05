# Production deployment handoff

This milestone prepares a single Node service for Vite assets and the existing API. It does not deploy the app or create accounts. It adds `packages/server/deployment/runtime.ts`, a portable Dockerfile, optional `deploy/render.yaml`, and HTTP tests. Ben's integration owner must make the small composition changes below; auth, database migrations and search remain their respective adapters' responsibility. Do not claim readiness from an unconfigured process.

## Host choice and account steps

No existing host configuration or compatible connected deployment tool was found. Docker, Render, Railway, Fly and Vercel CLIs are absent locally. The available Sites connector is not a compatible Node/Postgres deployment target without changing the application architecture. Use **Render Free web service + Free PostgreSQL in the same region** for the hackathon, with no paid resource creation. The account owner has confirmed there is no existing host or Google project.

1. Ben signs in at Render and authorizes the Projekt1 GitHub repository. Use manual **New → PostgreSQL**, choose **Free**, region **Oregon**, database `projekt1`, user `projekt1`. Record the internal connection URL privately. Disable external connections in the database access settings; the web service connects privately from the same region.
2. Create **New → Web Service** from the same repository. Choose **Node**, **Free**, **Oregon**, the coordinator's reviewed integration branch/commit, and repository root. Build: `npm ci --include=dev && npm run build`. Start: `node dist/packages/server/main.js`. Auto-deploy: **Off** until the integrated release gate is green. Health check: `/api/ready`. Creating a service can trigger a first build; wait to create it until the composition is integrated.
3. Set server environment `NODE_VERSION=22.19.0`, `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=10000`, and the non-secret browser build setting `VITE_AUTH_MODE=http`. Add `DATABASE_URL` using the private connection and `APP_ORIGIN=https://<actual-assigned-host>.onrender.com` with no trailing slash. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` only in the private service environment. Nothing secret belongs in a `VITE_` setting, GitHub, browser bundle or chat.
4. Ben creates a Google Cloud project and OAuth **Web application** client with the real application name and participating test users. Authorized production redirect: **the exact APP_ORIGIN followed by `/api/auth/google/callback`**. Local redirect remains `http://127.0.0.1:5173/api/auth/google/callback`. The helper derives that callback; if `GOOGLE_REDIRECT_URI` is supplied, it must match exactly. Initial sign-in requests identity/profile only; Google Contacts needs separate consent and People API setup.
5. The integration runtime must validate config, connect the database, run reviewed idempotent migrations and install real adapters before its readiness probe can pass. Storage's exact entrypoint is `migratePrivateStorage(pool, resolve('migrations/001_private_storage.sql'))` from `packages/server/storage/migrate.ts`; call it before listening. Free Render services do not provide SSH/one-off jobs, so startup migration is required for this path. A failed migration must leave the new instance unavailable. Do not publish an administrative migration HTTP route.

The optional Blueprint at `deploy/render.yaml` describes the same two free resources, uses a private DB connection, disables external DB access, and turns off automatic web deploys. Select its path explicitly when creating a Blueprint; it is not a root-level automatically selected file. It targets `main`, so use it only after the coordinator has merged and verified the integrated runtime. Manual setup is preferred while the host URL and Google client are being configured. Do not apply both workflows and create duplicate resources. [Render web services](https://render.com/docs/web-services), [Postgres connections](https://render.com/docs/postgresql-creating-connecting), [Blueprint specification](https://render.com/docs/blueprint-spec).

Render's free plan is adequate for tomorrow's modest demo, subject to account eligibility. Web services sleep after 15 idle minutes and can take about a minute to wake; open the actual app before rehearsal. The database is limited to 1 GB and expires 30 days after creation, with no managed backups. Local files disappear on restart/redeploy: all retained real data and sessions must be in Postgres. The docs describe operation without a payment method, with suspension when included usage is exhausted. They do not guarantee an account will never face card verification. If signup requests billing/card verification, Ben handles that decision; these instructions authorize no payment or upgrade. Export any retained real data privately before database expiry. [Free plan limitations](https://render.com/docs/free).

## Exact composition changes for integration owner

`http.ts`: extract the existing `createServer(async (request,response) => { ... })` callback into exported `createApiHandler(deps: HttpDependencies): RequestListener`. Keep `createApiServer(deps)` as `createServer(createApiHandler(deps))` for existing tests and Vite development. Keep every authentication, origin, body limit and error check in that handler unchanged. This helper adds no alternate auth path.

`main.ts`: read `readRuntimeConfig(process.env)` once, use `config.browserOrigin` for the API and verified OAuth client, and choose the production handler when `config.production` is true. The structure is:

```ts
import { createServer } from 'node:http';
import { createApiHandler } from './http.js';
import { createProductionHandler, readRuntimeConfig } from './deployment/runtime.js';

const config = readRuntimeConfig();
// Integration supplies verified auth, service, storage and migrations here.
const apiHandler = createApiHandler({ service, auth, browserOrigin: config.browserOrigin });
const handler = config.production
  ? await createProductionHandler({
      apiHandler,
      webRoot: config.webRoot,
      readiness: async signal => {
        // Actual bounded storage query + migrations/required-adapter readiness.
        // Respect abort, pool connection timeout and query timeout.
        return await checkApplicationReadiness(signal);
      },
    })
  : apiHandler;
const server = createServer(handler);
server.requestTimeout = 10_000;
server.headersTimeout = 10_000;
server.listen(config.port, config.host);
```

`service`, `auth` and `checkApplicationReadiness` above are composition placeholders, not provided fake implementations. Missing readiness always returns 503. The function should return true only after migrations, storage, real session/OAuth adapter configuration and the graph engine are installed. Do not call Google on every health probe. Do not return raw errors or credentials. Add bounded shutdown: stop accepting requests on SIGTERM, close idle connections and DB pool, allow active requests a short grace period, then exit. Integration owns the implementation and associated lifecycle tests.

The helper defaults production to `0.0.0.0:10000`; `PORT` and `HOST` are validated. It requires canonical HTTPS `APP_ORIGIN` in production. Render terminates TLS before forwarding HTTP, so cookies must derive `Secure` from configured public origin, not the internal socket or untrusted `Host`/`X-Forwarded-*` values. Do not widen CORS or allow arbitrary post-login redirect destinations. Production frontend uses relative `/api` routes on the same host. [Render port/TLS behavior](https://render.com/docs/web-services).

## Runtime behavior and checks

- `/api/health`: process liveness only, GET/HEAD 200. It says nothing about login, database or usable demo data.
- `/api/ready`: GET/HEAD 200 only on a successful supplied readiness check; missing, thrown or timed-out probes return 503 with a generic status. Concurrent probes share one in-flight check. The default deadline is 1.5 seconds; the database adapter must enforce cancellation/timeouts too. Render's release health check uses this route. [Health check guidance](https://render.com/docs/health-checks).
- Other `/api` paths always reach the authenticated API, including unknown API paths. They can never receive SPA HTML.
- Static GET/HEAD serves only allowed web asset types under the real built web root. Dotfiles, path traversal, escaped symlinks, source maps and malformed URL paths are refused. Assets missing from `/assets` are 404. Extensionless HTML navigations fall back to `index.html`; JSON fetches and unsupported methods do not. HTML is no-store, hash-named assets immutable, other assets revalidate. The built asset directory must stay immutable and contain no personal data.

Verified in this worktree on Node 22.19.0: server compilation, full web/server production build, and 5 deployment tests covering configuration, real HTTP navigation/assets/API separation, traversal/symlinks, HEAD, readiness failure and timeout. Socket tests require loopback permission under the Codex sandbox. Run:

```sh
npm ci
npm run build
node --test tests/deployment-runtime.test.mjs
```

The test worktree temporarily reused the existing integration `node_modules` through a local symlink, removed before commit; no dependency manifest was changed. Docker itself is not installed, so an actual container build/run remains unverified. The current Dockerfile copies only application source/build dependencies into the build stage and uses a non-root runtime stage. It requires the storage milestone's `migrations/` directory, absent from this baseline, and copies it into the final image. After integration, validate with:

```sh
docker build -t projekt1-demo .
docker run --rm --env-file /absolute/private/path/projekt1-production.env -p 10000:10000 projekt1-demo
```

The env file must be outside the repository. This serves plain HTTP at the internal listener; use an HTTPS reverse proxy matching `APP_ORIGIN` for actual OAuth. The native Render recipe avoids any local Docker requirement. Startup migration loads `/app/migrations/001_private_storage.sql` in the container; TypeScript compilation alone does not copy SQL. If the frontend later adds a `public/` directory, add an explicit build-stage copy before building Vite; the current baseline has none. The coordinator must verify the complete artifact when integrating teammates' output.

Release gate: integrated typechecks/tests/build pass; actual deployed `/api/ready` returns 200; signed-out graph/search remain 401; real Google callback and logout work; one owner's import survives restart and is inaccessible to another account; Nicolas's UI renders real committed nodes and Shreev's search results; refresh on the actual graph route works. Deployment is not complete until these checks run against the live assigned URL.
