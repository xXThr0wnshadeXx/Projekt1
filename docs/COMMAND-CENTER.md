# Projekt1 command center

**Deadline: Sunday, September 6, 2026, 2:00 p.m. Pacific. Feature freeze noon; rehearsal 1 p.m.**

This is the shared coordination entry point. Ben's existing Codex task is the command/planning agent. Teammates keep their own Codex tasks, accounts and existing code. No application implementation agent has been dispatched by this planning handoff; two bounded planning reviewers checked data access and graph contracts.

## Assignment map

- **Nicholas — frontend, large graph and animation.** [Brief + kickoff prompt](team/NICHOLAS.md). Own the graph renderer, layout worker, construction/search playback, goal/results and review UI. Already underway; preserve current frontend.
- **Shaw — real-data retrieval and normalization.** [Brief + kickoff prompt](team/SHAW.md). Own Google Contacts adapter, real export parsers, provenance, progress and source feasibility. Already underway; preserve current retrieval.
- **Shreev — graph engine and identity proposals.** [Brief + kickoff prompt](team/SHREEV.md). Own search projection, supported targets, weighted top-K, scores, events; identity/extraction second milestone.
- **Ben — backend, integration, release; command agent support.** [Brief + kickoff prompt](team/BEN.md). Own auth, private storage, contracts/validation, APIs, review/undo transactions, dependency coordination and deployment. Use a separate implementation task if this task should remain strictly the command room.

## What the command agent does

Maintain architecture, contract version, task board and integration gate. Review module handoffs against contracts, identify blockers, and prepare precise prompts for the responsible agent. Do not independently recreate another teammate's feature. Do not assume access to another person's Codex session; teammates post branch/commit and reports here or in their PR. No monitoring automation is created by this pack.

## Immediate launch sequence

1. Each teammate gives their agent the repository link and their brief's kickoff prompt. Use the existing Nicholas/Shaw task where possible so its local context is retained.
2. Each agent inspects current repo/local work and reports branch, framework, files owned and next bounded deliverable. Do not pull over conflicting dirty files or reset them; preserve on a branch first.
3. Ben collects those reports, locks the app path/framework/package manager, and posts the ownership/path mapping. Defaults in ARCHITECTURE.md are conditional on existing work.
4. Shaw proves one source with a participating owner's real records; request exports now rather than assuming instant downloads.
5. Ben implements/validates contracts and gives each teammate the same version. Nicholas and Shreev receive an authorized private sample or can work on empty states/isolated mathematical tests until one exists.
6. Integrate the smallest real import -> graph -> search -> visual result before adding a second difficult connector.

## Saturday checkpoints

**By 3 p.m.: baseline + access proof.** Nicholas/Shaw publish or report existing branch paths. Ben locks shared contracts and auth/storage setup. Shaw reports source status/counts/field availability. Shreev agrees on search projection and scoring. If source access is blocked, use a participating user's actual export/manual facts; no fictional seed.

**By 5 p.m.: first real graph.** Ben persists a small real import privately. Nicholas renders actual nodes/observations and animates committed changes. Shreev can consume the same authorized snapshot. Counts need not be impressive yet; semantics and integration must work.

**By 8 p.m.: supported path.** A real goal with evidenced target yields a route or honest missing-data result. Scores/events arrive from Shreev through Ben's API; Nicholas highlights them. Identify a genuinely supported demo route from the participants' data, without inventing missing relationships.

**By 10 p.m.: integrated checkpoint.** Merge working tracks, deploy a private test preview if available, record run instructions and blockers. This is a checkpoint, not a requirement to keep everybody working all night.

## Sunday checkpoints

**By 10 a.m.: demo core complete.** Real source import, graph construction, search animation, evidence and supported target work. Identity confirmation is added only if its review transaction and undo are reliable.

**Noon: feature freeze.** Drop unproven Instagram live API, Gmail, broad automatic enrichment, 3D, extra scale benchmarks or speculative UI before compromising access control, truthful evidence or a working path.

**1 p.m.: rehearsal.** Test on the actual presenting account/device; show what is real and missing. Verify refresh/restart, login/callbacks, retained private real dataset and local fallback. Show empty/error cases honestly. Keep a screen recording of the actual completed demo as backup if the hackathon permits it.

**2 p.m.: submit/demo.** Ben owns submission, deployed link and known limits. Confirm any submission-specific requirements with the event instructions.

## Handoff objects

- Shaw -> Ben: CandidateBatch, source capability report, field coverage, private sample reference. Do not send provider tokens or raw exports in public PRs.
- Ben -> Nicholas: authorized GraphSnapshot, GraphBuildEvent stream/poll endpoint, review decision API and error format.
- Ben -> Shreev: validated actor-filtered snapshot, graph version and runtime caps.
- Shreev -> Ben + Nicholas: SearchResult and exact SearchEvents, score policy and timing; identity proposals later.
- Nicholas -> Ben: routes/screens, API adapter and event playback; measured performance and browser checks.

Shared contract owner is Ben. Freeze names and semantics first; improve internals independently. Breaking change proposal must identify producer, consumer, migration and test updates. Ben accepts/rejects or versions it before merge.

## Agent status format

Copy into your PR or send to Ben at each checkpoint:

```text
Owner / branch / commit:
Existing work preserved:
Files owned and changed:
Working behavior (actually verified):
Real source + record counts (no personal details):
Checks run + results:
Contract changes requested:
Blocker + who can resolve it:
Next bounded deliverable + estimate:
```

## Review and merge rules

Ben integrates small PRs. Teammates do not push over main or merge each other's branches. Root lockfile/config is Ben's responsibility; request dependencies with reason and version compatibility. Review private graph isolation, confidence semantics and event versioning along with ordinary correctness. Keep imported personal data out of this public GitHub repo. Preserve GPL v3.

## Definition of a working demo

A consenting participant signs in/imports actual data, the real graph grows visibly, and an evidenced goal triggers server-ranked introduction routes with a grounded explanation. Unknown links stay unknown. Graph includes only actual records. Large-scale rendering is measured on available real records; counts are never inflated. External source failure does not erase already authorized imported data or silently switch to a fictional dataset.
