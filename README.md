# Orbit — Shared LinkedIn Connection Graph

Orbit builds an evidence-backed graph from LinkedIn pages that a contributor can already view. A Chrome companion reads those pages locally; one OpenAI Sites deployment hosts the interface, authenticated API, and shared D1 database.

## Use Orbit

- **Canonical application:** [orbit-shreev2703-graph-test.shreev2703.chatgpt.site](https://orbit-shreev2703-graph-test.shreev2703.chatgpt.site/)
- **Repository:** [xXThr0wnshadeXx/Projekt1](https://github.com/xXThr0wnshadeXx/Projekt1)
- **Companion download:** [download the current ZIP](https://orbit-shreev2703-graph-test.shreev2703.chatgpt.site/downloads/orbit-network-mapper.zip)

There is one hosted application and one hosted database. Do not use the retired Turso setup or the older `doublejav.chatgpt.site` deployment.

## Contributor setup

1. Open the canonical application and sign in with ChatGPT.
2. Download and unzip the Chrome companion.
3. Open `chrome://extensions`.
4. Enable **Developer mode** and choose **Load unpacked**.
5. Select the extracted `orbit-network-mapper` folder.
6. Reload the hosted Orbit page and click **Connect companion**.
7. Enter a full LinkedIn profile URL and start the collection.

Each contributor installs the companion in their own Chrome profile because it reads their own visible LinkedIn pages. They do not run a database or web server. Discoveries are sent to the same hosted API and merged into the same shared graph.

## What runs where

```text
LinkedIn pages visible to a contributor
                │
                ▼
Local Chrome companion
  - reads visible page content
  - stores a resumable local checkpoint
  - spaces LinkedIn requests
                │
                ▼
Canonical Orbit Site
  - user interface
  - ChatGPT authentication
  - /api/library/* Worker routes
                │
                ▼
Sites D1 binding: DB
  - shared workspace: demo-knowledge-graph
  - people, relationships, evidence
  - per-contributor rate limits
```

The extension is local; the knowledge graph is not. All authenticated contributors use the hard-coded shared workspace `demo-knowledge-graph`. Their authenticated identities remain separate for authorization and rate limiting.

## Shared database behavior

The Sites runtime supplies a D1 database as the `DB` binding declared in [`.openai/hosting.json`](.openai/hosting.json). No Turso URL, token, `.env` file, LinkedIn API key, or local SQLite server is required.

Database migrations live in [`drizzle/`](drizzle/) and are packaged with every Sites deployment. The schema stores:

- canonical LinkedIn profile URLs and profile metadata;
- undirected relationships with stable, sorted endpoint IDs;
- connection-list evidence and observation timestamps;
- atomic per-contributor rate-limit counters.

Ingestion uses idempotent upserts. Overlapping collections add new evidence and relationships without creating duplicate people. Empty incoming fields do not overwrite existing nonempty profile information.

The hosted limits are currently 20 ingestion requests and 120 read requests per authenticated contributor per minute. A limit response uses HTTP 429 with `Retry-After` and rate-limit headers.

## Collection rules

Orbit only processes LinkedIn pages the contributor can access in their browser. It does not bypass sign-in, verification, privacy controls, hidden connection lists, or commercial-use restrictions.

- One collection tab is used at a time.
- LinkedIn requests are spaced by at least two minutes.
- Checkpoints survive browser restarts and can be resumed.
- Unexpected pages, ownership changes, verification screens, and restrictions stop or pause collection.
- Every saved relationship must include an observable connection-list source.
- A missing relationship means “not recorded,” not “not connected.”

Wait for **Saved to library** before clearing a local checkpoint. Clearing the browser checkpoint does not remove data already written to D1.

## Local development

Local development is for editing and testing. It is not a second production architecture.

```powershell
git clone https://github.com/xXThr0wnshadeXx/Projekt1.git
cd Projekt1
npm ci
npm run check
npm test
npm run build
npm run preview
```

The preview opens at `http://127.0.0.1:8770`. It serves the frontend and companion download, but it does not provide ChatGPT authentication or a local D1 backend. Shared-library testing must use the canonical hosted application.

The npm tooling uses Node.js on Windows, macOS, and Linux. Python is not required.

## API

Authenticated routes are under `/api/library/`:

- `GET /api/library/stats` — shared people and connection counts;
- `GET /api/library/search?q=...` — search saved profiles;
- `GET /api/library/graph?url=...&depth=2&limit=1000` — bounded neighborhood;
- `POST /api/library/ingest` — validate and merge a collected graph batch.

`GET /api/session` reports whether the request has a trusted Sites identity. Clients cannot supply their own user ID. Anonymous library requests return 401, cross-origin writes return 403, oversized bodies return 413, and a missing database binding returns 503.

## Repository layout

```text
.openai/hosting.json   Sites project and D1 binding
drizzle/               D1 migrations and metadata
server/                Worker, API, database, and rate limiting
src/                   UI, graph, collection, and companion code
tests/                 API, database, collector, graph, and UI tests
tools/                 Cross-platform build, package, and preview tools
manifest.json          Chrome companion manifest
```

## Team workflow

1. Pull the latest `main`.
2. Create a focused branch.
3. Run `npm run check`, `npm test`, and `npm run build`.
4. Open a pull request and merge it after review.
5. Save and deploy that exact merged commit through the existing Sites project.
6. Verify the live application, session endpoint, D1-backed library, and companion download.

Pushing GitHub does not automatically publish Sites. The deployed Sites version is the production system. Do not create another database for ordinary local development.

## Capacity and limitations

The interface renders bounded graph views and defaults to a maximum of 10,000 people per map. The D1 library does not impose a 10,000-person lifetime limit, but a multi-million-person deployment has not yet been load-tested. Before treating D1 as the only copy of a large dataset, add capacity tests, monitoring, backups, and a restore procedure.

There is no unattended cloud crawler, verification bypass, hidden-data inference, complete-database export, or deletion interface. LinkedIn may prohibit automated collection; contributors are responsible for following applicable terms and laws.

## Troubleshooting

- **Companion not connected:** install the ZIP from the canonical Site, then reload both the extension and Site.
- **401:** sign in with ChatGPT on the canonical Site.
- **403:** use the canonical Site rather than another origin.
- **429:** wait for the indicated retry period.
- **503:** the Sites deployment is missing its `DB` binding.
- **Collection paused:** open the collection tab and resolve the LinkedIn restriction manually.

Never commit browser profiles, session cookies, tokens, personal exports, database dumps, or credentials.
