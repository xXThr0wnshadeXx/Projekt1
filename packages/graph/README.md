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

## Reviewed public-evidence policy

`publicEvidencePolicy.ts` is a pure, proposed projection policy for the facts
and backend owners to review. It cannot persist a claim or create a graph edge.
It allows only an accepted directional claim between explicitly resolved
identities with direct attributable evidence. Co-mentions, follows,
co-employment and shared organizations remain context-only and non-traversable.

The policy applies relative factors (not probabilities): direct attributable
support is `0.85`, corroborated direct support is `1.00`; current, recent,
stale and unknown freshness are `1.00`, `0.85`, `0.65` and `0.50`. Reviewer
preference is a deterministic tie-breaker only, never a score boost. Existing
reviewed relationship strength remains the sole relationship-strength input.
