# Orbit — Shared LinkedIn Connection Graph

Orbit builds an evidence-backed graph from LinkedIn pages that a contributor can already view. A Chrome companion reads those pages locally; one OpenAI Sites deployment hosts the interface, authenticated API, and shared D1 database.

## Use Orbit

- **Canonical application:** [orbit-shreev2703-graph-test.shreev2703.chatgpt.site](https://orbit-shreev2703-graph-test.shreev2703.chatgpt.site/)
- **Repository:** [xXThr0wnshadeXx/Projekt1](https://github.com/xXThr0wnshadeXx/Projekt1)
- **Companion download:** [download the current ZIP](https://orbit-shreev2703-graph-test.shreev2703.chatgpt.site/downloads/orbit-network-mapper.zip?v=2.6.2)
- **Current application and companion version:** `2.6.2`

This is the single supported hosted application and database. Do not use the retired Turso setup or the older `doublejav.chatgpt.site` deployment.

## Contributor setup

1. Open the canonical application and sign in with Google or ChatGPT.
2. Download and unzip the Chrome companion.
3. Open `chrome://extensions`.
4. Enable **Developer mode** and choose **Load unpacked**.
5. Select the extracted `orbit-network-mapper` folder.
6. Reload the hosted Orbit page. Orbit connects to the companion automatically; use **Connect companion** only if it needs another attempt.
7. Enter a full LinkedIn profile URL and start the collection.

Each contributor installs the companion in their own Chrome profile because it reads their own visible LinkedIn pages. They do not run a database or web server. The hosted Site is the only workspace: clicking the extension icon focuses the most recently used Orbit Site tab, or opens one only when none exists. Discoveries are sent to the same hosted API and merged into the same graph.

## One deployment model

```text
LinkedIn pages visible to a contributor
                │
                ▼
Local Chrome companion
  - reads visible page content
  - stores one resumable account checkpoint in that Chrome profile
  - spaces LinkedIn page actions
                │
                ▼
Canonical Orbit Site
  - interface and companion download
  - Google or ChatGPT authentication
  - /api/library/* Worker routes
                │
                ▼
Sites D1 binding: DB
  - shared workspace: demo-knowledge-graph
  - people, relationships, and evidence
  - authenticated, validated writes
  - optional per-contributor rate limits
```

The extension is a background collection companion; the permanent knowledge graph and user onboarding are not local. All authenticated contributors use the hard-coded shared workspace `demo-knowledge-graph`.

## One account, one network

Orbit maintains one continuously growing network for each signed-in account. Resuming an unfinished collection keeps its exact page, queue, and checkpoint; duplicate starts leave an active collection alone. A finished map becomes **Check for new connections**. Orbit never clears its saved coverage or requeues the whole known network: after 24 hours it checks the 24 stalest eligible branches, prioritizes the starting account, and rotates through the remainder on later runs. Newly discovered people still expand outward to the chosen degree. Reopening the Site starts a due daily batch, while reopening an unfinished run resumes exactly where it stopped. Every changed person and relationship is periodically upserted into the shared team graph. **Reset my account network** is deliberately kept in Settings and removes only that account’s contribution—overlapping records supported by teammates remain.

### Comment relationships (2.6.2)

A commenter and the actual author of a visible post get one **undirected, equal-weight relationship**, whether or not they are LinkedIn connections. Repeated comments and connection-list observations merge into the same pair while keeping separate evidence. Commenters on the same post are not automatically connected to each other.

Enter your profile or another person's profile in **Map settings → Starting LinkedIn profile**. The collector follows a visible activity link, reads original posts by that profile, and expands comment/reply controls. It excludes reposts by other authors, mentions inside comment text, anonymous placeholders, and hidden comments. Each observation retains the source post, stable comment ID, commenter, author, and time. A hidden connection list can still produce paths through comment relationships. Paths and name/profile-URL search include those people.

Each activity job uses the same persisted action governor as connection collection. It stops after three unchanged expansion/scroll attempts or 20 actions per profile and marks uncertain coverage **Incomplete**. It never posts, likes, or sends replies. Available DOM layouts may omit activity links or comments; absent evidence is not invented.

Existing exports with `commentObservations`, combined comment evidence, or `kind: "commented_on_post"` links can be imported into the graph. Autosave splits long evidence histories into API-sized batches without discarding observations. The `0007_comment_evidence` migration adds typed evidence metadata with a backward-compatible default for existing list sources. **Deploy the site with this migration before using companion 2.6.0**; the older backend rejects comment links.

### Collection pacing and recovery (2.6.0)

- One collection tab. The **first two actions of a fresh run have no mandatory gap**; **action three onward waits at least 120 seconds after the preceding action**, including navigation, Next, load-more, scrolling and retries. DOM reads consume no action budget. Parsing time overlaps the existing interval instead of starting another full wait.
- Rolling local budgets of **25 actions/hour and 150 actions/day**, persisted in `orbitCollectionPolicy` independently of maps. Switching, cancelling, clearing, reloading the companion, or restarting Chrome preserves the reservation history. These are conservative Orbit guardrails, **not LinkedIn-published or approved quotas**. They do not cover manual browsing or other installed collectors. The two-action startup allowance belongs to a persisted run ID; pause, resume, browser restart, and duplicate Start do not reset it. Starting another run still honors the preceding run’s cooldown, and restriction/backoff events invalidate any unused allowance.
- HTTP **429/999**, document **401/403**, and visible verification/restriction notices stop collection. `Retry-After` seconds and HTTP dates are respected, with a minimum 15-minute cooldown for restrictions. Time alone and reopening the Site never clear a restriction: inspect LinkedIn and explicitly resume. Login pages pause for sign-in. Repeated platform notices can extend the cooldown.
- Transient failures back off exponentially, with two navigation retries per job and a pause after repeated failures. A stalled Next/scroll gets at most three paced attempts without repeatedly reloading the list. A checkpoint-write failure stops further actions until the companion is reloaded.
- Scrolling uses overlapping viewports and combines unique people across virtualized snapshots. Modern and legacy result cards can coexist. A person cap saves only accepted rows and resumes the remainder without inflating page counts. An uncertain end remains **Incomplete** in Coverage.
- Incomplete direct lists no longer block exploring the people already found. Resume keeps the active page and pending queue, including older coverage pauses. Browser restarts preserve the last paginated URL.
- **Explore next layer** moves on to saved people's connections immediately, keeping the current direct-list checkpoint for later. It skips branches already attempted and does not re-create people. Increase coverage to 3rd degree in Map settings to explore another layer. Known people can still receive updated profile fields and new relationship evidence.
- Collection scheduling uses the companion's local URL index and branch checkpoints. D1 merges the discovered people and relationships; a person existing in D1 alone is not proof their connection list was fully explored. Update an unpacked companion by replacing its existing files and clicking **Reload**, never by uninstalling it: uninstalling removes its local collection checkpoint.
- An open Site now keeps its collection lease through background-tab throttling and overnight computer sleep. A normal Site close still pauses immediately and reopening resumes the same checkpoint.
- Completed maps keep per-branch freshness timestamps. Daily refreshes inspect at most 24 stale branches at a time, retain all prior people, relationship evidence, comment coverage, and pagination history, and use idempotent URL/edge keys so a refresh cannot duplicate graph records.

The added `webRequest` permission observes status codes and `Retry-After` in the collector tab using Chrome's [response-header events](https://developer.chrome.com/docs/extensions/reference/api/webRequest). It does not request blocking interception, read response bodies or cookies, change headers, or expand host access beyond `www.linkedin.com`.

LinkedIn [prohibits scraping extensions and automated activity](https://www.linkedin.com/help/linkedin/answer/a1341387/prohibited-software-and-extensions). No delay, quota, or browser agent guarantees that an account will avoid restrictions. Test collector changes with the local fixtures, not a live scraping run on a teammate's account.

Use the filters to organize this persistent network by distance, location, estimated field, or school/employer/skill keywords. Search is suggestion-based rather than exact-only: aliases such as `SJSU`, full institution names, profile details, and close spellings are ranked together. The map can animate all visible people into readable location clusters. Selecting a person shows progressively disclosed professional details, alternate observed routes, and a person-centered two-hop connection tree.

### Workspace and settings

The **Map workspace** tab contains the graph, people, filters, route viewer, and share action. Use **Map settings** for the account profile, collection coverage, Team library, live database activity, and the guarded reset control. Starting or continuing collection returns to the workspace automatically. Optional scroll zoom eases toward the pointer; reduced-motion mode applies changes immediately.

## Shared database

Sites supplies D1 through the `DB` binding in [`.openai/hosting.json`](.openai/hosting.json). No Turso URL, token, `.env` file, LinkedIn API key, or local SQLite server is required.

Migrations live in [`drizzle/`](drizzle/) and are packaged with each deployment. The live schema contains:

- `people` — canonical profile URL, name, headline, location, About, Experience, Education, Skills, generated search keywords, and timestamps;
- `people_search` — FTS5 trigram search index for aliases, substrings, and suggestion candidates;
- `connections` — stable undirected endpoints and first/last observation times;
- `evidence` — the visible connection-list source supporting a relationship;
- `people_contributors`, `connection_contributors`, and `evidence_contributors` — which signed-in accounts support each shared record and source observation;
- `api_rate_limits` — atomic per-contributor request counters used when enforcement is enabled;
- `imports` and `import_records` — imported file metadata and lossless preserved source records;
- `users`, `identities`, and `sessions` — server-backed account, onboarding, and hashed-session state.

Open **Map settings → Database activity → View database activity** to see live totals, the latest saved people, the latest relationships, contributor names, timestamps, and imported files without leaving Orbit. For raw rows, open **Sites → Orbit Knowledge Graph → Edit → Database → DB**, select `people`, `connections`, `evidence`, or a contributor table, and refresh the table. The Settings and Analytics pages show configuration/traffic, not row contents.

### Google account login

The hosted Site uses Google Identity Services with the configured Web client ID. Google returns a signed ID token; the Worker verifies its signature, audience, issuer, expiry, and per-attempt nonce before creating a seven-day Orbit session. Only a SHA-256 hash of the opaque session token is stored in D1. The browser never receives or needs a Google client secret.

Set `GOOGLE_CLIENT_ID` in the Site environment to the public Web client ID, then publish a version. The Google Cloud client must list the exact Site origin under **Authorized JavaScript origins**. New users continue to LinkedIn setup, returning users with a saved starting profile go to the map, and onboarding is stored in D1 so it follows the account to another device. ChatGPT sign-in remains available during the transition.

Ingestion uses idempotent upserts. People are globally deduplicated inside the shared workspace by canonical LinkedIn URL; undirected relationships are deduplicated by their sorted endpoint pair. Overlapping collections add contributor attribution and evidence without duplicating people or links. Empty incoming fields do not replace existing nonempty profile information.

### Import a teammate's existing collection

A teammate does **not** need Sites editor access or direct D1 credentials to add data. They need to:

1. Open the [canonical Orbit Site](https://orbit-shreev2703-graph-test.shreev2703.chatgpt.site/map.html) and sign in with Google or ChatGPT.
2. Open **Map settings → Team library**.
3. Choose **Choose a JSON file**. Orbit previews the recognized totals locally and does not upload yet.
4. Select **Import into shared D1** only after the totals look right, then keep the tab open until **Import complete** appears.

The importer recognizes `profiles`/`connections`, `nodes`/`edges`, `people`/`relationships`, and `people`/`links`. Rich archives can also contain sections such as `profileDetails`, `commentObservations`, and `sources`. Every source array record and the top-level metadata are preserved in `import_records` and `imports`, while recognized people and connections are also normalized into the visual graph. Unsupported relationships remain preserved and are clearly counted in the preview rather than silently discarded.

People must use canonical LinkedIn profile URLs. Every visual graph edge must name its source and target profile URLs and include at least one visible LinkedIn connection-list observation. Evidence may use Orbit's `url`/`observedAt` fields or archive-style `source`/`firstSeen`/`lastSeen` fields. Orbit uploads people first, then connections and preserved records in atomic batches.

Duplicate protection is enforced in D1, not just in the browser. A person is unique by canonical LinkedIn URL; a connection is unique by its alphabetically ordered endpoint pair; evidence is unique by connection and source URL. Re-imports update newer details and observations, while genuinely new people, connections, and evidence are added.

Application rate limiting is currently disabled for team development. The implementation and database table remain present. Set the hosted environment variable `ORBIT_RATE_LIMIT_ENABLED=true` for final testing or production; the defaults are then 20 ingestion requests and 120 read requests per authenticated contributor per minute, configurable with `ORBIT_WRITE_LIMIT_PER_MINUTE` and `ORBIT_READ_LIMIT_PER_MINUTE`.

## Collection rules

Orbit processes only LinkedIn pages that the contributor can access in their browser. It does not bypass sign-in, verification, privacy controls, hidden lists, or commercial-use restrictions.

- One collection tab is used at a time.
- The first two actions of a fresh collection run start promptly; action three onward is spaced by at least two minutes. Existing server cooldowns and rolling budgets still apply to every action.
- Orbit completes or explicitly marks the starting profile’s visible direct list before expanding connections-of-connections; jobs are always ordered from the shallowest layer outward.
- The collector identifies LinkedIn’s actual virtualized connection-list scroller and performs bounded loading retries rather than silently skipping the first layer.
- Checkpoints survive browser restarts.
- Unexpected pages, ownership changes, verification screens, and restrictions stop or pause collection.
- Every saved relationship requires an observable connection-list source.
- A missing relationship means “not recorded,” not “not connected.”

Wait for **Saved to library** before closing the Site. Closing or navigating away auto-pauses LinkedIn collection while preserving the exact local checkpoint; reopening the Site resumes that workspace-managed pause and syncs pending changes to D1. A manual pause or LinkedIn restriction never auto-resumes. The Settings reset action removes that account’s contributor attribution and deletes only records unsupported by another teammate.

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

The preview opens at `http://127.0.0.1:8770`. It serves the frontend and companion download but does not provide account authentication or local D1. Use the canonical hosted Site for shared-library testing.

The npm tooling uses Node.js on Windows, macOS, and Linux. Python is not required.

## API

Authenticated routes are under `/api/library/`:

- `GET /api/library/stats` — shared people and connection counts;
- `GET /api/library/activity` — live totals plus recent people, connections, contributors, and imports;
- `GET /api/library/search?q=...` — search saved profiles;
- `GET /api/library/graph?url=...&depth=2&limit=1000` — bounded neighborhood;
- `GET /api/library/path?to=...&depth=6` — shortest observed cross-team route from the signed-in account profile;
- `POST /api/library/ingest` — validate and merge a collection batch.
- `POST /api/account/network/reset` — remove only the signed-in account’s contribution while retaining teammate-supported records.

`GET /api/session` reports whether Sites supplied a trusted identity. Clients cannot choose their own identity. Anonymous library requests return 401, cross-origin writes return 403, oversized bodies return 413, and a missing database binding returns 503.

## Repository layout

```text
.openai/hosting.json   Sites project and D1 binding
drizzle/               D1 migrations and metadata
server/                Worker, API, database, and optional rate limiting
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

After companion changes, also run `npm run package`, copy `dist/orbit-network-mapper.zip` to `downloads/orbit-network-mapper.zip`, and commit the refreshed download. Installed unpacked extensions do not update themselves. The Site compares its current companion version with the version reported by Chrome and shows a small update notice when they differ; teammates then replace the files and click **Reload** in `chrome://extensions`.

## Capacity and limitations

The responsive browser view is bounded to 10,000 people at once. The D1 library has no application-level 10,000-person lifetime cap, but a multi-million-person dataset has not been load-tested. Add capacity tests, monitoring, backups, and restore procedures before treating D1 as the sole copy of an important corpus.

There is no unattended cloud crawler, verification bypass, hidden-data inference, full-database export, or record-deletion interface. LinkedIn may prohibit automated collection; contributors are responsible for following applicable terms and laws.

## Troubleshooting

- **Companion not connected:** install the ZIP from the canonical Site, reload the extension, and refresh the Site.
- **401:** sign in with Google or ChatGPT on the canonical Site.
- **403:** use the canonical Site rather than another origin.
- **429:** wait for the indicated retry period.
- **503:** the Sites deployment is missing its `DB` binding.
- **Collection paused:** inspect the collection tab and resolve the LinkedIn restriction manually.
- **Build failure:** use a current Node.js release, run `npm ci`, then run the npm scripts from the repository root.

Never commit browser profiles, session cookies, tokens, personal exports, database dumps, or credentials.
