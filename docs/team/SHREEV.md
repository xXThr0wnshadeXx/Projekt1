# Shreev — graph search, scoring and identity proposals

Deadline: Sunday September 6, 2 p.m. Pacific. Your first milestone is a deterministic search engine over real supported relationships. Identity matching and extraction follow it; they must not block the first integrated route.

## Your outcome

Return the strongest supported introduction paths and explain their scores, with a bounded event trace Nicholas can animate. Finding a person, observing a follow and proving an introduction route are separate steps.

## You own

packages/graph: search projection policy, target matching, adjacency indexing, score breakdowns, top-K and events/tests. packages/ai: identity proposals, then structured relationship extraction and grounded explanations. Ben owns shared contracts, auth, actor filtering, persistence and merge/undo transactions. Shaw owns raw retrieval. Nicholas owns rendering.

## First hour

Read contracts/index.ts and agree with Ben on the search projection before implementation. Ask Shaw/Ben for an authorized private sample and its evidence. Implement a pure search function with no framework, LLM or provider dependency. Structural numeric unit cases can test math; they never become product/demo data. Report unsupported real targets truthfully.

## Search tasks

- S1: project eligible relationship claims into directed SearchEdges. Keep contact/follow/co-participant observations separately typed. Follows/coemployment do not automatically become paths; observed connection priors require an explicit conservative policy and visible basis.
- S2: use adjacency lists and a heap for bounded simple-path best-first top-K. Path-local cycle prevention preserves alternative routes. Account for final target relevance before declaring winners. Return deterministic, distinct person sequences; consolidate parallel evidence rather than offering the same route three times.
- S3: compute relationship quality, identity contribution once per distinct non-root person, target relevance and hop penalty. Version priors; display relative heuristic scores. Don't reward a weak contact as a close friend merely because a source record is certain.
- S4: emit actual events. Cap/sample detailed exploration independently of search budget; always preserve chosen paths and completion. Budget-limited results explicitly disclose incompleteness. No global 'rejected person' state.
- S5: identity proposals with evidence, positive/negative signals and confirmation. Same-source external-ID reimport is idempotence; fuzzy cross-platform links always require review. No photo/face matching.
- S6: structured text extraction only after S1–S5 and integration permit it. Validate schema/evidence and return pending candidates; refusal/timeout fallback leaves existing graph intact.

## Tests and done

Test stronger-longer vs weaker-shorter scoring in isolated numeric cases; directionality; cycles; K distinct routes; target relevance; zero-confidence links; stop budgets; stable ties; event size and sequence. Compare against a brute-force oracle on tiny numeric graphs. Reject unknown IDs and malformed proposals. Verify unauthorized edges cannot appear in paths, explanations or events using Ben's scope fixtures. Low/high fuzzy matches both require appropriate separation/review. Work with Ben on link/revert roundtrip, preserving source records and invalidating stale snapshots.

Done for first milestone: real authorized snapshot -> supported target -> up to three paths -> score factors -> bounded real events, integrated through Ben's API. Done for identity milestone: real proposal can be reviewed/reverted without erasing source evidence. Unknown affiliations remain unknown; an AI-sector hint must not become OpenAI employment.

## Handoffs

Need a validated authorized snapshot from Ben and evidence-rich batches from Shaw. Send Nicholas a real SearchResult privately plus its contract version. Report timing, expansions and limits against actual real node/edge counts; no promise that graph size implies unlimited search depth. If identity work threatens the route milestone, ship separate identities and ask users to confirm relationships manually.

## Copy this into your Codex task

```text
You are Shreev's graph and identity implementation agent for Projekt1. Deadline: Sunday September 6, 2026, 2 p.m. America/Los_Angeles; feature freeze noon. Repository: https://github.com/xXThr0wnshadeXx/Projekt1.

If the shared planning files are missing from GitHub, use the attached Projekt1-Team-Handoff.zip; inspect and reconcile it with existing work before copying files. Read AGENTS.md, docs/COMMAND-CENTER.md, docs/ARCHITECTURE.md, contracts/index.ts and docs/team/SHREEV.md. Inspect current repository/branches; do not adopt the paused fictional prototype. Own packages/graph and packages/ai. Ben owns contracts/auth/storage/transactions; Shaw ingestion; Nicholas visualization. Propose shared changes instead of modifying their files.

First deliver a pure typed bounded top-K engine with adjacency lists and a heap. Search only an authorized projection of supported real introduction relationships. Separate observed contacts/follows, identity candidates and confirmed relationship claims. Do not invent friendships from shared employers or targets from vague bios. Use path-local cycle detection, deterministic ties, distinct person routes, final target relevance and an explainable versioned score. Charge identity uncertainty once per distinct person. Return partial status on budgets; emit bounded actual search events for Nicholas, preserving winner/completion events.

Real product/demo data only. Request an authorized private sample from Shaw/Ben. Isolated anonymous numeric unit tests never populate the app. Add tests for scoring, direction, cycles, target relevance, top-K, budgets, event bounds and actor visibility; compare small cases to an independent exhaustive oracle.

Then implement evidence-backed identity proposals with mandatory fuzzy-match review and cooperate with Ben's reversible link transactions. Structured extraction is a later milestone; LLM output is pending data, never canonical truth. Work on feat/shreev-graph-ai, use bounded subagents only in your directories/separate checkouts, and deliver small PRs without merging main. First report baseline, first task, contract needs and missing sample, then proceed within scope.
```
