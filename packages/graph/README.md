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
