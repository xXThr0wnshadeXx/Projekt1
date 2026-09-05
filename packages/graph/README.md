# Graph engine

`BoundedRouteSearch` is a pure TypeScript implementation of contract v1's
`SearchEngine`. It accepts an already-authorized `GraphSnapshot`, explicit
evidence-backed `Goal` and `Target` objects, and server-clamped options.

It only traverses `snapshot.searchEdges`; this package never converts contacts,
follows, affiliations, or screen layout into introduction edges. The server must
construct that projection after authorization and validation.

The engine uses directed, path-local simple paths and ranks each final route by:

`product(edge.strength × edge.confidence × edge.recencyFactor) × product(distinct non-root identity confidence) × target relevance × 0.92^(hops - 1)`

Its output is versioned with the input snapshot and includes bounded actual trace
events. A budget-limited result is explicitly marked as non-exhaustive.

Integration decisions still needed from Ben: the eligible
`OBSERVED_CONNECTION_PRIOR` policy (if any), runtime validation/error behavior,
and the private actor-filtered snapshot fixture. Until then, consume only the
pre-projected `SearchEdge[]` supplied by the server.

## Goal and target integration

`new EvidenceBackedGoalResolver()` structurally implements the backend `GoalPort`:
`resolve(text, authorizedSnapshot)` returns `Promise<{ goal, targets }>`. Use it as
`goals` alongside `engine: new BoundedRouteSearch()` in Ben's composition root.
It recognizes literal organization names already present in this scope, with
case/spacing normalization and word boundaries. It never discovers organizations,
profiles, vacancies or connections. Ambiguous equal names and negative/contrastive
requests yield no speculative matches. Overlapping names prefer the longest match.

Targets reuse Shreev's PR5 resolver at `960f6fd`: only non-root people with current,
confirmed positive affiliations backed entirely by AFFILIATION evidence qualify.
Former or unknown employment does not qualify. Other goal requirements are
explicitly UNKNOWN; the full original request is retained in `goal.text`. No role,
location or opening is represented as satisfied. Relevance is an organization-only
heuristic, not a probability of fulfilling every goal requirement.

After Ben's backend contracts are present, run `npm run build:server` then
`node --test tests/graph-*.test.mjs`. These tests compile graph entrypoints with
strict NodeNext settings and pass results through the actual backend validators.
Anonymous mathematical fixtures stay in tests and never populate the application.
