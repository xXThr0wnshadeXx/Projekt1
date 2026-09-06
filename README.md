# Orbit — Shared LinkedIn Connection Graph

Orbit builds an evidence-backed graph from LinkedIn pages that a contributor can already view. A Chrome companion reads those pages locally; one OpenAI Sites deployment hosts the interface, authenticated API, and shared D1 database.

## Use Orbit

- **Canonical application:** [orbit-shreev2703-graph-test.shreev2703.chatgpt.site](https://orbit-shreev2703-graph-test.shreev2703.chatgpt.site/)
- **Repository:** [xXThr0wnshadeXx/Projekt1](https://github.com/xXThr0wnshadeXx/Projekt1)
- **Companion download:** [download the current ZIP](https://orbit-shreev2703-graph-test.shreev2703.chatgpt.site/downloads/orbit-network-mapper.zip)
- **Current application and companion version:** `2.1.0`

This is the single supported hosted application and database. Do not use the retired Turso setup or the older `doublejav.chatgpt.site` deployment.

## Contributor setup

1. Open the canonical application and sign in with ChatGPT.
2. Download and unzip the Chrome companion.
3. Open `chrome://extensions`.
4. Enable **Developer mode** and choose **Load unpacked**.
5. Select the extracted `orbit-network-mapper` folder.
6. Reload the hosted Orbit page and click **Connect companion**.
7. Enter a full LinkedIn profile URL and start the collection.

Each contributor installs the companion in their own Chrome profile because it reads their own visible LinkedIn pages. They do not run a database or web server. Discoveries are sent to the same hosted API and merged into the same graph.

## One deployment model

```text
LinkedIn pages visible to a contributor
                │
                ▼
Local Chrome companion
  - reads visible page content
  - stores resumable maps in that Chrome profile
  - spaces LinkedIn page actions
                │
                ▼
Canonical Orbit Site
  - interface and companion download
  - ChatGPT authentication
  - /api/library/* Worker routes
                │
                ▼
Sites D1 binding: DB
  - shared workspace: demo-knowledge-graph
  - people, relationships, and evidence
  - per-contributor rate limits
```

The extension is local; the permanent knowledge graph is not. All authenticated contributors use the hard-coded shared workspace `demo-knowledge-graph`. Their identities remain separate for authentication and rate limiting.

## Multiple local maps

Version 2.1 supports several resumable maps in one Chrome profile:

- **Your maps on this device** returns to an existing collection.
- **New map** starts another collection.
- Switching maps pauses the active build and preserves its checkpoint.
- Only one map collects at a time, and the LinkedIn cooldown carries across maps.
- **Cancel build** keeps discovered people as a viewable map but permanently stops that map’s queue.
- Filters reduce line clutter; **Show all connections** restores the complete visible edge set.

These map checkpoints are device-local. The hosted D1 library combines saved discoveries from every authenticated contributor.

## Shared database

Sites supplies a D1 database through the `DB` binding in [`.openai/hosting.json`](.openai/hosting.json). No Turso URL, token, `.env` file, LinkedIn API key, or local SQLite server is required.

Migrations live in [`drizzle/`](drizzle/) and are packaged with each deployment. The live schema contains:

- `people` — canonical profile URL, name, search name, headline, location, and timestamps;
- `connections` — stable undirected endpoints and first/last observation times;
- `evidence` — the visible connection-list source supporting a relationship;
- `api_rate_limits` — atomic per-contributor request counters.

Ingestion uses idempotent upserts. Overlapping collections add evidence and relationships without duplicating people. Empty incoming fields do not replace existing nonempty profile information.

The hosted limits are 20 ingestion requests and 120 read requests per authenticated contributor per minute. A rejected request returns HTTP 429 with `Retry-After` and rate-limit headers.

## Collection rules

Orbit processes only LinkedIn pages that the contributor can access in their browser. It does not bypass sign-in, verification, privacy controls, hidden lists, or commercial-use restrictions.

- One collection tab is used at a time.
- Collector-initiated LinkedIn actions are spaced by at least two minutes.
- Checkpoints survive browser restarts.
- Unexpected pages, ownership changes, verification screens, and restrictions stop or pause collection.
- Every saved relationship requires an observable connection-list source.
- A missing relationship means “not recorded,” not “not connected.”

Wait for **Saved to library** before clearing a local checkpoint. Clearing a browser map does not remove records already written to D1.

## Local development

Local development is for editing and testing; it is not another production architecture.

```powershell
git clone https://github.com/xXThr0wnshadeXx/Projekt1.git
cd Projekt1
npm ci
npm run check
npm test
npm run build
npm run preview
```

The preview opens at `http://127.0.0.1:8770`. It serves the frontend and companion download but does not provide ChatGPT authentication or local D1. Use the canonical hosted Site for shared-library testing.

The npm tooling uses Node.js on Windows, macOS, and Linux. Python is not required.

## API

Authenticated routes are under `/api/library/`:

- `GET /api/library/stats` — shared people and connection counts;
- `GET /api/library/search?q=...` — search saved profiles;
- `GET /api/library/graph?url=...&depth=2&limit=1000` — bounded neighborhood;
- `POST /api/library/ingest` — validate and merge a collection batch.

`GET /api/session` reports whether Sites supplied a trusted identity. Clients cannot choose their own identity. Anonymous library requests return 401, cross-origin writes return 403, oversized bodies return 413, and a missing database binding returns 503.

## Repository layout

```text
.openai/hosting.json   Sites project and D1 binding
drizzle/               D1 migrations and metadata
server/                Worker, API, database, and rate limiting
src/                   UI, graph, collection, and companion code
tests/                 API, database, collector, graph, and UI tests
tools/                 Cross-platform build, package, and preview tools
manifest.json          Chrome companion manifest and allowed Site origin
```

## Team and deployment workflow

1. Pull the latest `main`.
2. Create a focused branch.
3. Run `npm run check`, `npm test`, and `npm run build`.
4. Open and review a pull request.
5. Merge it into GitHub `main`.
6. Save and deploy that exact merged commit through the existing Sites project.
7. Verify the live page, D1 tables, session behavior, and companion download.

Pushing GitHub does not automatically publish Sites. The Sites version is production. Do not create another Site or database for ordinary development.

After companion changes, also run `npm run package`, copy `dist/orbit-network-mapper.zip` to `downloads/orbit-network-mapper.zip`, and commit the refreshed download. Installed unpacked extensions do not update themselves; teammates must replace the files and click **Reload** in `chrome://extensions`.

## Capacity and limitations

The UI renders bounded graph views and supports up to 10,000 people per local map. The D1 library has no application-level 10,000-person lifetime cap, but a multi-million-person dataset has not been load-tested. Add capacity tests, monitoring, backups, and restore procedures before treating D1 as the sole copy of an important corpus.

There is no unattended cloud crawler, verification bypass, hidden-data inference, full-database export, or record-deletion interface. LinkedIn may prohibit automated collection; contributors are responsible for following applicable terms and laws.

## Troubleshooting

- **Companion not connected:** install the ZIP from the canonical Site, reload the extension, and refresh the Site.
- **401:** sign in with ChatGPT on the canonical Site.
- **403:** use the canonical Site rather than another origin.
- **429:** wait for the indicated retry period.
- **503:** the Sites deployment is missing its `DB` binding.
- **Collection paused:** inspect the collection tab and resolve the LinkedIn restriction manually.
- **Build failure:** use a current Node.js release, run `npm ci`, then run the npm scripts from the repository root.

Never commit browser profiles, session cookies, tokens, personal exports, database dumps, or credentials.
