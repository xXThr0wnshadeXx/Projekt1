# Projekt1 — real-network architecture v1

Implementation status: the original design below includes historical planning assumptions. The app now uses the preserved Vite + React frontend, Node/TypeScript backend and PostgreSQL snapshot persistence. Runtime validation, auth, import review and search are implemented; current verified state and outstanding acceptance gates are in COMMAND-CENTER.md and BACKLOG.md. Do not interpret the original license-only inventory or framework defaults below as current state.

Decision date: Saturday, September 5, 2026. Deadline: Sunday, September 6, 2:00 p.m. America/Los_Angeles. Owner: Ben, with the command/planning Codex task coordinating.

**This plan supersedes the previous fictional-data prototype plan. Only real, supported information belongs in the product or demo.** Application implementation is delegated to the four named owners; this handoff adds documentation and typed contracts only.

## 1. What exists and what is still uncertain

GitHub main was rechecked on September 5: commit `55a0414ac2ccd5c542ac96f5a69b58fad5452e00` contains only GPL v3 LICENSE. Preserve it. Nicolas is already working on frontend; Shaw on retrieval. Their local work has not been inspected and must be preserved. First coordination task: get their branch links, frameworks, file ownership and current status.

An earlier local, uncommitted Vinext/Cytoscape fictional prototype exists only in the planning workspace. It is paused, its preview has been stopped, and it is not the approved shared baseline. Do not copy its seed, 200-node caps, dependency tree or architectural assumptions into teammates' work. No shared application release or real provider access is established by these documents.

Known requirements: real data only; large, readable graph; animated construction and search; cross-platform identities; weighted human introduction paths. Unknowns: actual obtainable node/edge count, export formats, live provider permissions, teammate stack, hosting and model credentials. These unknowns require short experiments, not invented data or promises.

## 2. Product and data flow

```text
Google sign-in --------------------------> actor + private network scope
                                                  |
Google Contacts / uploaded exports / manual facts / public profile links
                         |
             Shaw: source-specific adapters
                         |
              Evidence + CandidateBatch
                         |
         Shreev: extraction / identity proposals
                         |
              Ben: validation + user review
                         |
       authorized, transactional canonical storage
                         |
      observable links + supported relationship claims
                         |
             policy-based search projection
                         |
Goal -> supported target discovery -> weighted bounded top-K engine
                                            |                 |
                                         paths            SearchEvents
                                            |                 |
                              Nicolas: results + graph playback

Committed import batches -> GraphBuildEvents -> graph construction animation
```

The LLM is never the database. A profile match, a platform connection and willingness to introduce are three separate facts. Organizations are target attributes, not social traversal hubs. Co-employment or coattendance must not generate all-to-all friendship edges.

## 3. Technology and deployment decisions

- **Language/backend:** TypeScript modular monolith. Default is Next.js App Router with route handlers and React. If Nicolas already has a working React/Vite app, preserve it and expose the same JSON API through one small TypeScript server. Ben locks this choice after inventory; do not make Nicolas restart for framework consistency. FastAPI adds another runtime and schema translation with no current benefit.
- **Renderer:** Sigma.js/Graphology is the leading candidate for a large WebGL network. Nicolas owns a measured spike on available real records, labels, edge styling and interactions. Cytoscape is a fallback if it already meets the actual scale and animation needs. React Flow is less aligned with dense social graphs. Do not equate a renderer's maximum-node claim with acceptable layout or search performance. [Sigma docs](https://www.sigmajs.org/docs/), [Cytoscape docs](https://js.cytoscape.org/), [React Flow layouts](https://reactflow.dev/learn/layouting/layouting).
- **Layout:** compute force layout in a worker or use a cached stable layout. Never recalculate the full layout per animation frame. Cluster by evidence-backed affiliations and graph communities, not invented family categories. Store positions by graph version; progressively reveal labels and hide low-priority edges at distant zoom. Names missing from data stay source handles, not generated names.
- **Database:** managed PostgreSQL for the shared real-data build; canonical relational tables plus application-memory graph projection. Neo4j adds a service and does not solve custom willingness scoring. SQLite is acceptable for a single-machine fallback, not an ephemeral deployment pretending to persist. If the team already selected Sites, its D1 adapter is an alternate storage implementation, not a reason to rewrite frontend. [Postgres queries](https://www.postgresql.org/docs/current/queries-with.html), [Neo4j deployment choices](https://neo4j.com/deployment-center/).
- **AI:** provider-independent typed structured outputs; runtime schema validation plus referential validation. Configure provider/model through server environment. Explain from actual path evidence; deterministic text fallback. No live AI prerequisite for first real-data search. [Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
- **Deployment:** Ben owns one preview and one integrated app. Prefer the existing working host; default Next deployment plus managed Postgres if none. Establish Google callback URLs early. Never serve real graphs from a public unauthenticated endpoint. Avoid queues/microservices initially: small import batches and job status; add a worker only if measured provider latency or host limits require it.

## 4. Data acquisition and identity policy

Sign-in gives account identity, not contacts. Google Contacts needs separate read authorization; it does not expose contacts of contacts. LinkedIn connection exports are a viable input; its Connections API requires approval and does not return second-degree connections. Instagram export contents must be verified on an actual account; no working general personal-account mutuals endpoint is established. Sherlock discovers candidate usernames, not email-to-person proof and not social edges. See SOURCE-ACCESS.md for sources and the proof-of-access checklist.

Store `ObservedLink` (CONTACT_SAVED, FOLLOWS, CONNECTED_ON_PLATFORM, CO_PARTICIPANT) separately from `Relationship`. Preserve direction. An observed connection may receive a conservative, documented introduction prior; it remains labeled weak/unconfirmed knowledge of closeness. FOLLOW alone should default to display-only until a deliberate policy is reviewed. Co-participants and shared employers are display/context evidence, not traversable introduction edges. Reciprocal introductions require separate evidence/policy, never automatic inversion of PARENT_OF or FOLLOWS.

Cross-platform identity: exact source external ID is idempotent reimport; exact user-authenticated ownership can link that user's profiles. Fuzzy matches always require review. Prioritize score >=0.90; surface 0.65–0.90; otherwise keep separate. These thresholds are initial heuristics, not calibrated probabilities. Shared names, reused handles or shared email addresses alone are not universal identity proof. No face matching, breached data, account-recovery probes, password collection, session-cookie harvesting or bypassing restricted access.

Multiple users' networks remain private by default. Shared demo workspace requires explicit selection of contributed connections, source-policy compatibility and access checks. Permission to sign in/import is not permission to pool or reveal private contacts. Source restrictions apply to derived data too. Ben must review source permissions before cross-user pooling, especially Google/Gmail-derived data. An unauthorized path is never returned, even with hidden node labels.

## 5. Canonical contracts and invariants

`contracts/index.ts` is the versioned TypeScript wire contract. Ben owns changes and runtime validators. It contains Person, Identity, Organization, Evidence, SourceSummary, ObservedLink, Relationship, SearchEdge, Goal, Target, OpportunityPath, PathScore, SearchEvent, GraphBuildEvent, CandidateBatch, inference and review interfaces. It is a **type declaration pack**, not runtime validation or a implemented backend.

Required runtime checks: finite [0,1] scores; opaque stable IDs; UTC ISO dates; unique provider/external-ID per private source; all references resolve inside the authorized scope; no cross-scope references; pending inference never becomes accepted automatically; path has N+1 distinct people for N edges; edges connect consecutive people in the correct direction; all consequential claims have evidence; returned evidence is display-safe for the actor.

Evidence is immutable and source-grounded. Raw uploads/tokens/addresses are held separately, minimized, never committed or emitted to broad graph endpoints. Persistent tables include users, scopes, scope_members, sources, evidence, people, identities, identity_link_decisions, observed_links, relationship_claims, affiliations, ingestion_jobs, review_decisions and graph_versions. Use composite scope constraints and transactions. Targets/path results are derived from an immutable snapshot and carry its version.

Identity review writes an append-only identity-link decision with old/new mapping. Keep source identities and source-level references unchanged. Rebuild the canonical projection on acceptance/revert; don't destructively rewrite all edges. Optimistic version checks return 409 on stale review. Reversion restores the selected decision if no conflicting later decision exists; otherwise require re-review. Search results from older versions are invalidated.

## 6. Weighted top-K search

Input is the authorized SearchEdge projection, not everything drawn on screen. Target matching must cite actual affiliation or goal-relevance evidence. Unsupported role/location criteria are reported as unknown; an employer match is not an internship-opening match.

For v1, score each edge as strength × evidenceConfidence × recencyFactor. Multiply identity confidence **once per distinct non-root person**. Multiply target relevance and a modest hop penalty `0.92^(hops-1)`. Source reliability informs evidence confidence, not an extra duplicate factor. Strength is the introduction-affinity proxy for now; avoid multiplying another correlated willingness estimate. Label the total a relative score, not a probability of getting help. All factors and score policy version are returned.

Use a min-heap over nonnegative negative-log costs, or equivalent max-heap of product upper bounds, enumerating simple path states. Repeated nodes are forbidden within each path; no global visited-node set that loses alternative paths. A completed target competes by its final relevance-adjusted score; don't stop after K target encounters. Keep searching through relevant people when they can lead to another relevant target. Deterministic tie-breaking.

Start with k=3 (max 5), 5 hops (max 6), 10,000 expansions, 25,000 frontier states, <=3,000 detailed trace events and an approximately 1-second compute deadline, all server-clamped. Shreev tunes from measurements. Budget stop returns best found with `optimalWithinHopLimit:false`; never claim globally exhaustive search. Reserving completion/selected events is mandatory if trace is sampled. Beam search is an optional explicitly approximate fallback; BFS is only a comparison baseline. Yen's algorithm is a later optimization if profiling justifies it.

## 7. API boundary and animation semantics

Ben owns HTTP/session storage; Shaw owns normalization; Shreev owns pure engine functions; Nicolas owns rendering/reducers.

- `GET /api/session`: authenticated actor and authorized scopes, no tokens.
- `POST /api/sources/google/connect`: begin contacts authorization; callback server-side.
- `POST /api/imports`: accepted source kind + uploaded content through bounded endpoint -> jobId. Scope authorized from session. No arbitrary server fetch of user URLs; public retrieval needs explicit allowlist and SSRF protection.
- `GET /api/imports/:jobId?afterSeq=N`: job status and sanitized construction events. Polling first; SSE is optional transport later.
- `GET /api/graph?scopeId=...`: authorized GraphSnapshot. Versioned pagination/subgraph selection when actual graph size needs it.
- `POST /api/search`: SearchRequest -> SearchResult; 409 if expected version stale. Root person is server-owned.
- `GET /api/reviews?scopeId=...`: authorized candidate/proposal list.
- `POST /api/reviews/decisions`: versioned, idempotent ReviewDecision -> new graphVersion.
- `POST /api/identity-links/:decisionId/revert`: versioned reversal or conflict.
- `GET /api/health`: no personal data or secrets.

Consistent errors: 400 validation, 401 sign-in, 403 scope, 409 version conflict, 413 size, 429 rate limit, 502 source failure, 500 internal. Logs carry IDs/timing/counts, not raw imported personal data.

Search events are generated by the engine. Frontend may slow/replay/summarize them, never fabricate visits. Construction events represent committed batches, not a fake endless expansion. Pending matches get a distinct visual treatment; nodes collapse only after accepted identity decisions. Event sequences are monotonic per job/search. Ignore duplicates; stop/reload on graph-version gaps; cancel old playback when a new search begins. `PATH_PRUNED` is a path-prefix decision, not a globally rejected person. Textual path lists remain accessible if WebGL fails; honor reduced motion.

## 8. Repository ownership

Target layout (adapt the existing app path once, then document it):

```text
contracts/                  Ben: shared wire types + validation contract
apps/web/                   Nicolas: page/components/styles/rendering
apps/web/app/api/           Ben: API routes (reserved even inside frontend tree)
packages/ingestion/         Shaw: adapters, source access, provenance normalization
packages/graph/             Shreev: projection, targets, search, score tests
packages/ai/                Shreev: extraction/identity proposals/explanations
packages/server/            Ben: persistence/auth/transactions/services
 docs/team/                 Ben + command agent: briefs and kickoff prompts
 docs/                     architecture, task board, integration decisions
```

Single package manager/lockfile owner: Ben. Do not run scaffolders over someone else's project. If existing work has different paths, owners supply a mapping; keep interfaces stable instead of moving everything for aesthetics. Never run multiple agents in the same dirty checkout. One owner branch per track; PRs can be small; coordinator integrates only reviewed, runnable changes.

## 9. Dependencies, MVP, demo and stretch

```text
Contracts + teammate inventory
   |-- Shaw: real source record -> candidate batch --|
   |-- Ben: auth + private persistence ------------|--> first real graph
   |-- Nicolas: renderer + event consumer --------|
   |-- Shreev: projection/search/identity ----------|--> ranked real path
```

Shaw can normalize local owner-provided exports before OAuth is finished. Nicolas can build empty/loading controls and consume approved actual samples before full ingestion. Shreev can write pure algorithms and unit cases before provider access. No fictional people/network appears in app/demo; anonymous structural unit-test cases are algorithm tests only, never product data. User data fixtures stay local/ignored; teammates exchange schema summaries and authorized samples through suitable private channels, not this public repo.

MVP: authenticated user imports real contacts/export -> real nodes/observed links -> confirms a few meaningful relationships -> enters a goal with an evidenced target -> ranked actual path -> visible construction/search. An honest no-route/insufficient-data result is required. Do not invent a missing bridge to make a demo succeed.

Demo additions: multiple real sources, reviewed identity link collapsing duplicates, real multi-hop route, zoomed-out clusters, alternate routes and evidence drilldown. A real weak-short vs strong-long contrast is used only if supported by the actual network. Stretch: source refresh, richer goal discovery, multiple opt-in contributors, path diversity, larger data benchmarks, live event streaming.

## 10. Scale and risk gates

Engineer for thousands of nodes, but report actual imported counts. A 5,000-node or 20,000-node display is a performance aspiration, not an invented dataset requirement. Bound rendering separately from search; large network does not imply unbounded traversal. Measure import latency, visible node/edge count, first useful render, frame times during pan/zoom, search p50/p95 and limits on team hardware.

- Source access: high likelihood/high impact. Prove access first hour; primary fallback real export/manual statements. No unsupported API promise.
- Sparse network: high/high. Ask real users for meaningful context/contributions; show coverage and missing evidence. Fallback narrower genuine goal, not fabricated graph.
- False identity link: high/high. Confirmation + reversible ledger; fallback separate identities.
- Privacy/source-policy leakage: medium/high. Actor-scoped storage and evidence; share only authorized compatible records. Fallback private individual demo.
- Layout/search stalls: medium/high. Worker layout, zoom detail, heap search and caps. Fallback cached positions, smaller authorized viewport, partial results clearly labeled.
- Integration churn: high/high. Contracts and file ownership first; early vertical merge, daily dependencies controlled by Ben.
- Secrets/verification/hosting: medium/high. Ben configures test users/callbacks early. Fallback local authenticated demo from already authorized real exports; production availability is not presumed.
- AI hallucinations: high/high. schema/evidence validation, user review; fallback deterministic extraction of structured imports and source-based explanation.

## 11. Build checkpoints

See COMMAND-CENTER.md for named responsibilities and clock times. First gate is real-data access and inventory, second is one integrated real graph, third is a ranked supported path. Sunday noon feature freeze; 1 p.m. rehearsal; 2 p.m. deadline. If behind, reduce source breadth and animation complexity before cutting provenance, access control or evidence truthfulness.
