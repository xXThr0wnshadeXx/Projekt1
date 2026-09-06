# Orbit project handoff

Last updated: September 6, 2026

This document is the durable context for a new Codex chat. Read it before changing the project. It describes the product goal, architecture, current deployment, database, collector behavior, collaboration expectations, verified fixes, and safe release workflow. It intentionally contains no passwords, database tokens, Google secrets, session cookies, or short-lived deployment credentials.

## Product goal

Orbit is a collaborative LinkedIn relationship knowledge graph for a hackathon demo. Each person signs in, ties one persistent Orbit map to their LinkedIn profile, and uses a Chrome companion to collect information visible in their own authenticated LinkedIn session. All contributors save canonical people, relationship evidence, and source records into one Sites D1 relational database. A person's map can then include every database record connected to their starting profile through an observed path, including paths contributed by teammates.

The intended experience is:

1. One account has one durable, continuously growing map.
2. Collection resumes from exact local checkpoints instead of rebuilding known first-degree connections.
3. Existing people and edges are enriched, never duplicated.
4. Teammates' overlapping graphs connect through shared people and edges.
5. Search, filters, location views, person trees, and introduction routes make the large graph useful without overwhelming the user.
6. The UI stays editorial, minimal, animated, and easy for a nontechnical user.

The long-term aspiration is millions of relationships, but the current implementation is a tested hackathon-scale system. Do not claim that three-million-edge performance has been load-tested. The current shared neighborhood response is intentionally capped at 3,000 people and the companion UI currently caps a collection at 10,000 people.

## Canonical project locations

- GitHub repository: `https://github.com/xXThr0wnshadeXx/Projekt1`
- Production branch: `main`
- Working integration branch: `feature/person-tree-and-resilience`
- Sites project ID: `appgprj_6a9cfe3c7eb4819187da561f93e8a836`
- Public Site: `https://orbit-shreev2703-graph-test.shreev2703.chatgpt.site`
- Sites D1 binding: `DB`
- Shared graph namespace: `demo-knowledge-graph`
- Current application checkpoint: commit `7f2eb4d9f320bd08ec7bab5b30f31bfb61905076`
- Current deployed Sites version at the time of this handoff: version 19
- Current companion/application version: `2.8.1`
- Installable companion archive: `downloads/orbit-network-mapper.zip`

The repository contains `.openai/hosting.json`, so all website build or deployment work must follow the Sites building and hosting skills. The Site also has its own private source Git remote named `sites`. A valid deployment requires the exact source commit to be pushed to both the intended GitHub branch and the Site source repository before saving the version.

## Current access model

- The Site is public to visit, but `/setup.html` and `/map.html` require a signed-in Orbit session.
- Google login creates an Orbit user and a hashed server session in D1.
- External teammates currently appear as Site viewers, not Sites deployment editors. They do **not** need Sites editor access to collect or save graph data.
- Any signed-in user who can use the Site and companion writes through authenticated APIs to the same shared D1 graph namespace.
- Teammates can contribute code through GitHub. A GitHub push does not automatically deploy to Sites; an owner-authorized Sites publish is still required.
- The current Codex environment has authenticated Git access to the GitHub remote and owner access to the Sites project. A new chat may still receive a normal approval prompt for network pushes or deployment tools. A Markdown file cannot transfer operating-system permissions, authentication, or temporary credentials.
- Never commit `.env`, Google client secrets, Turso tokens, Sites write credentials, session cookies, or bearer tokens. `.gitignore` already excludes `.env` files. Generate short-lived Sites source credentials through the Sites connector only when publishing.

This project no longer depends on Turso in production. The authoritative shared database is the Sites built-in D1 database. GitHub Pages is not a database and is not the deployed backend.

## System architecture

### Website and Worker

- `index.html` is the landing and authentication experience.
- `setup.html` performs initial account/profile setup.
- `map.html` is the persistent graph workspace.
- `server/worker.js` serves compiled assets, protects authenticated pages, injects the shared workspace namespace, and exposes the API.
- `server/api.js` routes authentication, profile, reset, library, search, path, graph, activity, and ingest calls.
- Vite plus `@openai/sites-vite-plugin` bundles the Worker and static assets into the Sites deployment artifact.

### Chrome companion

The companion remains necessary for LinkedIn collection. A normal website cannot directly read a user's authenticated LinkedIn pages because of browser origin, authentication, and platform restrictions. The companion:

- runs collection inside the user's own Chrome/LinkedIn session;
- communicates with the Site through explicitly allowed external extension messaging;
- opens or reuses a controlled LinkedIn tab;
- parses visible profile, connection-list, pagination, and optional activity/comment content;
- saves its exact state in `chrome.storage.local`;
- sends changed canonical people and relationships to the Site, which upserts them into D1.

Important files:

- `manifest.json`: Chrome extension metadata and permissions.
- `src/background.js`: durable queue, pacing, navigation, pause/resume, refresh, recovery, and Site bridge.
- `src/collector.js`: LinkedIn DOM inspection and guarded extraction.
- `src/core.js`: canonical URLs, people/edge merging, route computation, import/export, and collection state.
- `src/companion.js`: expected extension version and Site origin.

Updating an unpacked companion should preserve its folder and extension identity: download the newest ZIP, replace the files in the same unpacked folder, open `chrome://extensions`, and click **Reload**. Do not remove/re-add the extension unless necessary because its local checkpoint is stored under that extension installation.

### Durable collection behavior

- Closing the Site pauses an active run and preserves the current URL, queue, page signatures, branch coverage, and pacing policy.
- Reopening the Site renews the workspace lease and resumes an unfinished run.
- Duplicate Start actions do not refresh the whole known graph.
- Completed maps wait for a daily freshness window and then rotate through a bounded stale batch.
- **Explore next layer** keeps the root/direct-list checkpoint and prioritizes unexpanded saved people.
- Profile metadata repairs are separate from connection-list completion, so missing locations/headlines can be revisited without erasing list progress.
- Connection-list collection is the default. Comment relationships remain available as an optional Map setting and do not block normal deeper expansion when disabled.
- The collector enforces a minimum two-minute LinkedIn action interval and honors login, restriction, retry-after, and checkpoint-storage failures. Application-level shared API rate limiting still exists but is disabled in `server/worker.js` during team testing.

LinkedIn DOM changes can break individual selectors. Never respond by rapidly retrying, bypassing restriction pages, inventing relationships, or discarding checkpoints. Add fixtures and tests for every parser change.

## Shared D1 data model

The live `DB` binding currently contains:

- `users`, `identities`, `sessions`: Google account and Orbit session state.
- `people`: one canonical person per shared owner and normalized LinkedIn profile URL.
- `connections`: one canonical undirected pair per shared owner.
- `evidence`: relationship evidence such as a visible connection list or commenter-to-author observation.
- `people_contributors`, `connection_contributors`, `evidence_contributors`: provenance used to merge overlap and safely remove only one account's contribution.
- `collection_coverage`: contributor-specific profile, connection-list, and comment checkpoints with server-derived reuse eligibility.
- `imports`, `import_records`: loss-conscious archive ingestion and original-record preservation.
- `people_search`: full-text search data.
- `api_rate_limits`: dormant/configurable shared API throttling.

Schema migrations live in `drizzle/`. Do not modify the production database manually before adding and testing a forward migration.

### Canonical deduplication rules

- A person ID is the canonical `https://www.linkedin.com/in/<slug>/` URL.
- Repeated people update missing/richer metadata in place.
- An undirected edge sorts its two canonical endpoints, so A–B and B–A are the same relationship.
- A repeated edge adds new observation metadata/evidence rather than a second edge.
- Evidence has its own stable identity (source URL, type, and comment identity where applicable).
- Contributor tables preserve who supplied each fact. Resetting one account removes only unsupported contributions; facts also supplied by teammates survive.
- The client also merges nodes, edges, and evidence by keyed maps before rendering.

Never add a second person or connection row merely because a new import or teammate observed it. Save new source evidence and newly available metadata against the canonical record.

## Shared-account graph behavior

- `src/library.js` periodically upserts local collection changes to `/api/library/ingest`.
- The account view loads `/api/library/graph` with a connected-neighborhood depth up to six and a 3,000-person response limit.
- D1 results are added to a person's map only when an actual saved edge connects them to that account's root. Unrelated database rows do not appear merely because they exist.
- Client and server recompute shortest observed depths from the root.
- The Site checks the graph revision while visible and refreshes approximately every 30 seconds. An unchanged revision returns a compact unchanged response.
- Complete profile coverage is reusable for seven days; complete unfiltered connection/comment coverage is reusable for 24 hours. Incomplete, hidden, mutual-only, filter-adjusted, and stale coverage never suppresses collection by another teammate.
- The companion receives connected D1 people as exploration hints, but does not attribute or upload a teammate-only person until it actually observes that person. Each account's root/direct list is still collected from its owner.
- Route lookup uses the combined shared graph and can show a strongest route plus secondary observed alternatives.
- The visible distance filter supports 1st through 6th degree without changing what is stored.

This is how Ben, Nicolas, Shreevatson, and other teammates' maps can join: once their contributed records share a canonical person or relationship path, every account whose root reaches that component can load those paths. There is no blind copying of all database people into every map.

## Search, filters, and map UX

- Search ranks exact names/profile URLs, aliases, abbreviations, full profile metadata, related terms, and bounded spelling similarity.
- Short aliases such as `LA`, `SF`, and `AI` expand only as whole terms; they cannot accidentally match words such as “Clara.”
- Examples include SJSU/San Jose State University, UCLA/UC Los Angeles/Los Angeles/LA, UC Berkeley/UCB, common technical abbreviations, and common healthcare/life-science terms.
- A company query such as Apple is matched against actual saved profile fields; hidden nonmatches are not selectable.
- Sector inference lets one person belong to several useful categories. Healthcare includes medicine, pre-med, biology, biotech, biochemistry, biomedical, genomics, clinical, nursing, pharmacy, public health, and related evidence.
- Recorded location wins when it is meaningful. If it is empty or only generic (for example `United States`), known school/headline clues may infer a metro.
- Sacramento, Greater Sacramento, Folsom, El Dorado Hills, Roseville, Rocklin, UC Davis, and Sacramento State normalize to **Sacramento Area**.
- San Francisco/Bay Area cities plus UC Berkeley and SJSU clues normalize to **San Francisco Bay Area**.
- UCLA/USC and common Los Angeles variants normalize to **Los Angeles Area**. UCSD and San Diego variants normalize to **San Diego Area**.
- Location mode uses at most three cluster columns, compacts repeated `United States` suffixes, spaces clusters by population/label size, and suppresses stray person labels unless the user deliberately searches/selects.
- Switching between Network and Locations clears any stale selected route.
- Search results spread apart and only highlighted/search-visible people can be clicked.
- A person can be opened as the root of a local observed tree. The inspector shows concise profile details, the strongest introduction route, secondary route options, connected people, and source evidence.
- The landing page includes Nicolas's scroll-rotated, perspective-projected 3D node system with reduced-motion support and deterministic tests.

## Main API surface

All `/api/*` endpoints are same-origin and authenticated unless explicitly part of login configuration:

- `GET /api/session`
- `POST /api/auth/google`
- `POST /api/auth/logout`
- `POST /api/account/profile`
- `POST /api/account/network/reset`
- `GET /api/library/stats`
- `GET /api/library/imports`
- `GET /api/library/activity`
- `GET /api/library/search?q=...`
- `GET /api/library/path?to=...&depth=...`
- `GET /api/library/graph?url=...&depth=...&limit=...&since=...`
- `POST /api/library/ingest`

Do not expose D1 credentials to browser code. Every browser write goes through the Worker, which derives the contributor from the signed session rather than trusting a user-supplied identity.

## How a teammate uses Orbit

1. Pull `main` from GitHub if working on code.
2. Visit the public Orbit Site and sign in with Google.
3. Download Companion 2.8.1 from the Site/README.
4. Unzip it to a stable folder, enable Developer Mode in `chrome://extensions`, choose **Load unpacked**, and select that folder.
5. If updating, replace files in the same folder and click **Reload** instead of removing the extension.
6. Stay signed in to LinkedIn in Chrome.
7. Open Map settings, connect the companion, and confirm the version indicator says it is current.
8. Enter the account's canonical LinkedIn profile once and continue collecting.
9. Use **Explore next layer** to prioritize saved people's lists after first-degree coverage exists.
10. Leave comments disabled unless comment-to-author relationships are specifically desired.

Collection writes to D1 automatically. A teammate does not upload a database file and does not need Sites editor access. JSON imports are a separate user-driven ingestion feature for existing archives and preserve original source records.

## Viewing database activity

The database is part of the Sites project, not a file in GitHub. In ChatGPT Sites, open the Orbit Knowledge Graph project and its database/data area for the `DB` binding. The Sites database tools can also inspect the schema and table rows by project ID and binding name. The Map's Team Library, Database activity panel, people/relationship counters, imports, and shared-route results are the user-facing views.

Useful integrity checks:

- `people` count grows only for new canonical profile URLs.
- `connections` count grows only for a genuinely new canonical pair.
- repeated observations grow or update `evidence`/contributor data without duplicating people or pairs;
- `imports` and `import_records` show archive provenance;
- resetting one account does not delete overlapping facts supported by another contributor.

## Development and verification

From the repository root:

```powershell
npm ci
npm test
npm run check
npm run build
npm run package
```

Current verified state: 147 tests passing, syntax checks passing, migration replay passing, Worker build passing, companion packaging passing, and local visual verification completed for Nicolas's landing interaction at a compact viewport.

Test coverage includes authentication, body limits, collector pacing, exact resume checkpoints, daily refreshes, reusable teammate coverage, deeper exploration, optional comments, current LinkedIn result layouts, parser restrictions, metadata extraction, canonical deduplication, contributor reset semantics, six-hop shared neighborhoods, search aliases/misspellings, 10,000-node layout assembly, scale-independent zoom, selectable search results, filter transitions, route alternatives, imports, rate-limit primitives, landing motion, and the 3D node system.

The expected warning lines printed during tests for rejected oversized/invalid requests are intentional negative-path tests. Do not treat them as failures when the test suite exits successfully.

## Release workflow for the next chat

1. Announce the active Sites skills because `.openai/hosting.json` exists.
2. Fetch GitHub and inspect `origin/main` plus recent teammate branches before editing.
3. Preserve unrelated/local work; never hard-reset or clean user data without explicit authorization.
4. Integrate teammate changes first when the user asks for a shared checkpoint. Resolve behavior, not merely conflict markers.
5. Append new compatible user requests to the active workflow instead of abandoning earlier unfinished work.
6. Add regression tests for collector, search, location, graph, dedup, or UI logic as appropriate.
7. Run the full test/check/build/package sequence and `git diff --check`.
8. Copy the newly packaged `dist/orbit-network-mapper.zip` to the tracked `downloads/orbit-network-mapper.zip`.
9. Commit the exact tested source. Push the integration branch and fast-forward `main` only after confirming `origin/main` is an ancestor of the tested commit.
10. Push that same full SHA to the Site's private `main` source branch using a fresh short-lived Sites write credential.
11. Package the built Site artifact with `.openai/hosting.json` and all `drizzle` migrations, save a Sites version with the exact full SHA, and deploy that saved version.
12. Wait for a terminal deployment status and visually test the production page. For canvas/map changes, test at both narrow and desktop widths and inspect the actual rendered graph—not only DOM text.
13. Update this handoff when architecture, deployment IDs, versions, or known limitations change.

Do not create a second Sites project for this repository. Reuse the existing project ID. Do not deploy a source archive; deploy the validated Worker/static build artifact. Do not claim a publish succeeded until Sites returns `succeeded`.

## Recent integrated checkpoints

- `fed6b01`: restored modern profile-location capture and prioritized optional post checks without losing list checkpoints.
- `e559423`: added shared six-hop account maps, revision-aware D1 refresh, canonical evidence merge, visible distance filtering, and optional comments.
- `9ea43c0`: normalized/inferred metro locations and removed stale route selection when changing layouts.
- `058631e`: added the teammate's reversible scroll-driven rocket landing experience.
- `7f2eb4d`: corrected production location-cluster readability at narrow widths.
- `c352385`: made Fit a stable 100% baseline and made every zoom step useful regardless of graph size.
- `309be97`: added reusable contributor-aware collection coverage and teammate exploration hints.
- `c4449c8`: integrated Nicolas's latest scroll-rotated 3D node landing system on top of current main.

## Known limitations and honest next priorities

- LinkedIn collection depends on visible, user-authorized DOM and can require selector maintenance as LinkedIn changes.
- Chrome may suspend extension service workers, and operating-system sleep stops browser execution. Durable alarms/checkpoints resume work; they cannot collect while the computer and Chrome are actually off.
- The current free/hackathon deployment has not been validated at the three-million-edge target. Before scaling, benchmark ingest throughput, D1 storage/index size, FTS growth, graph traversal latency, pagination, and client rendering with realistic synthetic data.
- The shared graph intentionally returns a bounded connected neighborhood rather than loading the whole D1 database into one browser.
- Metro inference is rule-based and conservative. Expand it with tested canonical location dictionaries or geocoding only if privacy, cost, and false-positive behavior are acceptable.
- There is no automatic GitHub-to-Sites deployment. The database remains available while the owner is offline, but new code needs an authorized Sites publish.
- External Site viewers cannot become co-owners through the current external-viewer list. Code collaboration belongs in GitHub; data collaboration belongs in the authenticated application APIs.
- Keep the rate-limit implementation available even while the app-level limiter is disabled for short-term team testing. Never remove restriction detection, durable pacing, canonical validation, or contributor provenance.

## Collaboration expectations from the user

- Work autonomously and make reasonable in-scope decisions instead of repeatedly asking for confirmation.
- Do not drop earlier unfinished requests when a compatible new request arrives; add it to the workflow.
- Check and integrate teammate work carefully, then create one tested checkpoint where everyone is on the same code.
- Protect previously collected data and exact collection progress.
- Prioritize correct behavior, canonical storage, clear evidence, and no duplicates.
- Keep UI changes sleek, minimal, understandable, responsive, and visually verified.
- Communicate concise progress during long work, then provide a concrete final result with live link, commit, tests, and any honest limitation.

The user's preferred operating pattern does not broaden authority to expose secrets, bypass LinkedIn restrictions, erase data, or overwrite teammate work. Those safeguards remain mandatory.
