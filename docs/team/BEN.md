# Ben — integration, backend and command

Deadline: Sunday September 6, 2 p.m. Pacific. This existing Codex task stays the command room. You can start a separate implementation task using the prompt below so planning and coordination remain available.

## Your outcome

Keep one working application assembled from Nicolas's frontend, Shaw's real sources and Shreev's engine. Own the demo's truthfulness, private data boundaries, deployment and final submission. You need not implement teammates' features to coordinate them.

## You own

contracts/index.ts and runtime validators; packages/server; app API routes; auth/OAuth callbacks and tokens; database schema/migrations; ingestion/review transactions; graph versioning; source deletion; dependency/lockfile changes; deployment/config; docs/COMMAND-CENTER.md and task board. Confirm the actual directory layout after inventory instead of forcing the paused prototype on the team.

## First hour

1. Collect Nicolas/Shaw branch links and current frameworks. Get Shreev online with his prompt.
2. Lock the app path, package manager, API base and contract version. Default modular TypeScript; preserve a working frontend stack.
3. Configure one private development database and Google test OAuth client with exact local/deployed callback URLs. Use account-owner sign-in; don't pass tokens between teammates or paste secrets into chat/Git.
4. Implement runtime validators for the type pack, authenticated scope resolution, and an empty private GraphSnapshot. Agree with Shaw on an owner-scoped SourceContext.
5. Receive Shaw's first actual CandidateBatch, validate/persist it and emit a committed construction event Nicolas can consume.

## Ordered integration tasks

- B1: auth, scopes, sources/evidence, canonical records and graph versions. Never expose one shared public graph of users' imports.
- B2: import endpoint/job status, idempotence, payload limits and transactional batches. Evidence references must resolve; raw/private fields are not public graph DTOs.
- B3: bind Shreev's pure engine to POST /api/search. Validate/clamp inputs; root/authorization come from session. Return graph-version conflict for stale searches and consistent errors.
- B4: review decisions and identity link ledger. Accept/reject with expectedGraphVersion + idempotencyKey. Revert mappings without deleting source identities; handle subsequent decision conflicts. Emit new version/deltas after commit.
- B5: real-data deployment and rehearsal. Test access isolation, refresh, provider failures and private real-data fallback. Do not publicly publish the graph or repurpose an unverified preview as production.

## What to ask teammates for

Nicolas: renderer/UI branch, current API adapter, frame-time/interaction results and screenshots through private channel. Shaw: source access evidence, counts/field coverage and private sample reference. Shreev: pure engine interface, score policy, tests, event sample and measured search limits. Each report should include commit, verified behavior, blockers and next handoff.

## Merge and release gates

Run types/tests/build and real endpoint smoke on each integrated checkpoint. Required security/correctness tests: unauthenticated/other-scope graph access, hidden-edge search/event leakage, malformed imports, repeated import, stale review, identity undo, correct source removal and no secrets/PII in logs. Never assume 'private hosting' replaces application user isolation. Provider rules can limit cross-user derived-data pooling even with consent; check before adding shared workspaces.

Noon Sunday is feature freeze. Retain a real supported route, honest empty results, core construction/search animation and working deployment. Defer unavailable sources or unproven identity merging. By 1 p.m. rehearse on the actual account/device and verify submission details.

## Copy this into a separate backend/integration Codex task

```text
You are Ben's backend/integration implementation agent for Projekt1. Our existing command/planning task owns coordination; do not recreate Nicolas's frontend, Shaw's ingestion or Shreev's graph engine. Deadline: Sunday September 6, 2026, 2 p.m. Pacific; feature freeze noon. Repository: https://github.com/xXThr0wnshadeXx/Projekt1.

If the shared planning files are missing from GitHub, use the attached Projekt1-Team-Handoff.zip; inspect and reconcile it with existing work before copying files. Read AGENTS.md, docs/COMMAND-CENTER.md, docs/ARCHITECTURE.md, contracts/index.ts and docs/team/BEN.md. Inspect existing teammate work and preserve dirty files. First inventory branches/frameworks and lock the actual paths/package manager with the command agent. The earlier fictional prototype is not our shared baseline.

Own contracts/runtime validation, backend routes, authentication, private data scopes, database, source credential handling, transactional import/review/identity undo, graph versions, dependencies and deployment. Use the simplest modular TypeScript implementation compatible with Nicolas's existing app. Build a private empty graph/session first; integrate Shaw's actual normalized batch, then Shreev's engine and Nicolas's event consumer. No fictional seed or fallback graph, invented identities or silent fuzzy merges.

Authorize scope before storage/query/search/events; never trust client actor/root IDs. Keep raw exports and credentials server-side, outside Git/logs. Separate import permission from selected-record sharing; check source restrictions before pooling. Validate payload size, IDs, confidence, provenance, idempotency and optimistic versions. Implement reversible identity link decisions only after the first real-data route works.

Work on feat/ben-integration. Use bounded subagents within backend ownership with separate checkouts; coordinate contract/lockfile changes before merging. Integrate small reviewed PRs and run meaningful types/tests/build/API checks, including isolation, stale versions and undo. Do not silently deploy real data to a public audience. Report branch/commit, working behavior, tests, blockers and next integration handoff after each milestone. First respond with baseline and your first bounded task, then proceed within scope.
```
