# Shaw — real-data retrieval and normalization

Deadline: Sunday September 6, 2 p.m. Pacific. Preserve your current retrieval work; report its branch and owned files before expanding it.

## Your outcome

Give the team a growing network made from actual obtainable records, with enough provenance to tell what every link means. Your first success is a small real batch reaching the app, then breadth and repeatability. Account discovery and relationship access are separate capabilities.

## You own

Source adapters, uploaded export parsers, import normalization, source capability reporting and retrieval tests. Proposed directories packages/ingestion and docs/SOURCE-ACCESS.md. Ben owns login/callbacks, credentials, upload boundaries, canonical writes, private storage and graph events emitted after commits. Shreev interprets uncertain identities/relationships; you supply evidence, not silent merges.

## First 45–60 minutes

1. Inventory existing retrieval code and tell Ben the paths/framework.
2. Prove one source on a participating owner's real account or supplied export. Google Contacts read-only is the first automated candidate. Report counts and populated fields without logging names/emails.
3. Request actual LinkedIn/Instagram exports now. Inspect files when available; do not assume filenames, fields, size or download latency.
4. Deliver one CandidateBatch using contracts/index.ts to Ben. Use stable source IDs, evidence references and source record identifiers; ask Ben for private source-record storage.
5. Mark every source VERIFIED, AVAILABLE_BUT_UNTESTED, BLOCKED or UNSUPPORTED with evidence. A token alone does not prove connection access.

## Source order

Primary: Google Contacts with additional consent; actual LinkedIn export; explicit manual relationship statements. Next: Instagram export if actual follower/following records are present; Google Other Contacts after a contract extension. Optional: user-supplied profile URLs/handles plus bounded public-profile discovery. Sherlock is username candidate discovery, not email lookup, person identity proof or relationship proof. Gmail metadata is a separate restricted-scope investigation, not the initial dependency.

No LinkedIn second-degree API access is assumed. No general personal Instagram mutuals endpoint is established. Public pages may support identity/employer evidence; shared employers do not generate friendship edges. Read docs/SOURCE-ACCESS.md for verified references.

## Ordered tasks

- W1: source proof and one real normalized batch.
- W2: pagination, bounded batches, retries/backoff/cancellation; report progress counts. Do not stream uncommitted graph updates yourself.
- W3: idempotent reimport and provenance preservation. A repeated source record should not create another person on each sync. New cross-platform records stay separate or become review candidates.
- W4: handle malformed/missing fields; private uploaded files stay out of Git. Provide accurate warnings and useful empty-source behavior.
- W5: second source, identity signals and employer evidence; only after integrated first-source import works.

## Tests and done

Check actual export structure, pagination, repeated import, token expiration, malformed/oversized rows, rate limits, partial source failure, direction of follows and no automatic reverse edges. Document deletion/revocation semantics: Ben removes affected source support and reprojects facts still supported elsewhere. Never pool users' networks by default. Do not expose private account existence through cross-user matching.

Done when a real source produces repeatable private batches with source provenance, clear link semantics, progress and honest capability/field coverage. Supply Ben an integration example privately and commit only schemas, parsers and count-only reports.

## Copy this into your existing Codex task

```text
You are Shaw's data retrieval agent for Projekt1. Deadline: Sunday September 6, 2026, 2 p.m. Pacific; feature freeze noon. Repository: https://github.com/xXThr0wnshadeXx/Projekt1.

If the shared planning files are missing from GitHub, use the attached Projekt1-Team-Handoff.zip; inspect and reconcile it with existing work before copying files. Read AGENTS.md, docs/COMMAND-CENTER.md, docs/ARCHITECTURE.md, docs/SOURCE-ACCESS.md, contracts/index.ts and docs/team/SHAW.md. Inspect and preserve my existing retrieval work first. Own packages/ingestion or the existing mapped adapter directory, source capability docs, normalization and retrieval tests. Coordinate file ownership with Ben; do not rewrite Nicholas's frontend.

First prove a participating owner's real source access and deliver one actual CandidateBatch within the first hour. Prioritize Google Contacts read-only through Ben's authorization boundary and user-provided exports. Request/inspect real LinkedIn and Instagram files before assuming their format or access. Report counts and field coverage, not private content. Every record needs stable source attribution, timestamp and evidence. Keep contact/follow/platform connection observations distinct from confirmed relationships. Sherlock-style discovery creates identity candidates only.

No fictional graph, padding, fabricated bridges, private-account scraping, account-recovery probes, or session-cookie/password collection. Keep imports private; source policy and explicit selected-record consent govern any pooling. Ben owns token storage, transactions and canonical graph writes; Shreev owns AI/projection/search. Use shared contracts and ask before changing them. Implement idempotence, pagination, limits, cancellation and source-specific errors without blocking other usable real sources.

Preserve my current branch or use feat/shaw-ingestion. Bounded subagents may work within retrieval ownership; do not spawn duplicate frontend/backend work. Deliver small reviewed PRs; do not push directly to main. First report baseline, source proof, files owned, contract needs, blockers and next bounded deliverable; then continue within scope.
```
