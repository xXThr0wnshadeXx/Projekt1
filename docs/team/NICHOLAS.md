# Nicholas — frontend, graph visualization and animation

Deadline: Sunday September 6, 2 p.m. Pacific. Your existing frontend work is the starting point. This report does not ask you to restart it.

## Your outcome

Make the real network feel understandable and impressive: construction grows visibly from imported records, zoom reveals useful detail, search explores meaningful branches, and selected introduction routes remain legible. The graph is the product's central visual experience.

## You own

Frontend pages/components/styles, renderer adapter, layout worker, graph interaction, construction/search event reducers, goal/results UI and identity review UI. Proposed location apps/web, excluding Ben's reserved API route directory. Ben will confirm your current path rather than move code unnecessarily.

You consume GraphSnapshot, GraphBuildEvent, SearchResult/SearchEvent and identity review APIs from the shared contracts. You do not rank paths, invent links, fetch private social data directly from the browser, store provider tokens or commit raw real imports.

## First hour

1. Tell Ben your current framework, branch and files; preserve everything already working.
2. Implement the shared data adapter boundary so a real snapshot can enter your renderer without backend internals.
3. Benchmark the renderer on the actual authorized sample from Shaw/Ben. Sigma.js/Graphology is the leading large-network choice; keep your existing renderer if measurements justify it.
4. Establish dark constellation styling, stable positions, readable labels by zoom and an accessible textual path list. Empty/loading state works while real data is unavailable; never populate fictional people.

## Ordered tasks

- N1: show actual people and typed observations/relationships. Differentiate platform observation, inferred claim and accepted relationship; affiliations may be separate visual edges but never fake social search links.
- N2: animate committed import batches. Nodes/edges appear once; pending matches stay visibly pending. Avoid rerunning physics on every insert or frame; lay out in worker/batches and preserve mental map.
- N3: consume real search events. Show exploration, candidate routes and selected path; fade irrelevant visible branches. Pruning a prefix does not globally reject a person. Render result details and score breakdowns from server output.
- N4: playback controls, restart/cancel/stale-version handling. Old searches cannot recolor a new one. Reduced-motion mode and keyboard-selectable results are required.
- N5: review UI against actual proposals. Node collapse waits for successful backend acceptance/new graph version. Show undo only when Ben's endpoint is available and reliable.

## Tests and done

Test duplicate/out-of-order events, graph-version mismatch, cancellation during search/import, empty graph, no paths, API failure, reduced motion and narrow viewport. Measure pan/zoom responsiveness and layout/main-thread cost on real imported counts. Report numbers and device, not unverified scale claims. Done when an actual import appears progressively and a server-returned route can be selected/replayed without local search logic.

## Handoffs and blockers

Need from Ben: auth/session, graph/search/review endpoints and locked paths. Need from Shaw: representative authorized source sample; receive through a private channel. Need from Shreev: same-version real events/results. Until then build controls, reducers and shape validation, not a fake demo. Send screenshots of authorized UI only through agreed private channels; no private names in public PR screenshots.

## Copy this into your existing Codex task

```text
You are Nicholas's frontend implementation agent for Projekt1. Deadline: Sunday September 6, 2026, 2 p.m. America/Los_Angeles; feature freeze noon. Repository: https://github.com/xXThr0wnshadeXx/Projekt1.

If the shared planning files are missing from GitHub, use the attached Projekt1-Team-Handoff.zip; inspect and reconcile it with existing work before copying files. Read AGENTS.md, docs/COMMAND-CENTER.md, docs/ARCHITECTURE.md, contracts/index.ts and docs/team/NICHOLAS.md. Inspect and preserve my existing frontend code and dirty work before changing anything. Report framework, branch and directories to Ben's command agent; do not restart or scaffold over my app.

Own frontend, graph renderer/layout, construction/search animation, goal/results and review UI. Ben owns API/auth/contracts/storage; Shaw retrieval; Shreev ranking/identity proposals. Consume their typed outputs; do not implement search logic in visualization. Request contract or dependency changes before editing shared files.

Use only real authorized data in the app/demo. No fictional seed, filler people or fabricated exploration. First make a real snapshot render, then animate committed imports and actual search events. Sigma.js/WebGL is a candidate; benchmark current real data before committing to a rewrite. Use stable worker/batched layout, progressive labels, typed edge styling, cancellation, reduced motion and accessible route lists. Identity nodes collapse only after accepted backend review.

Work on feat/nicholas-frontend or preserve my current appropriate branch. Use bounded subagents within frontend ownership when useful, with separate files/checkouts; do not duplicate another teammate's track. Deliver a small PR after each working milestone, not one final giant commit. Report branch/commit, files, checks, measured behavior, contract requests and blockers. Your first response should inventory existing work and state the next bounded task; then proceed within my assigned scope.
```
