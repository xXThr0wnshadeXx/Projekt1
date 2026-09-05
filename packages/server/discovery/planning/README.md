# Bounded public discovery planner

`createDiscoveryPlanner(ports, lowerLimits?).collect({request, authority}, signal?)`
collects public query hints and exact document-backed, unreviewed proposals. It does
not authenticate, persist, resolve identities, write graph data, rank paths, or emit
graph/search playback events. This is a standalone integration export; the existing
source service has not been changed.

## Ports and source contracts

- `provider`: existing `SearchProvider` (`TAVILY`, `BRAVE`, or `WIKIMEDIA`).
- `documents.fetch`: existing `PublicDocumentFetcher.fetch` shape, returning exact
  `RetrievedPublicDocument`. Use the reviewed public HTTP/robots implementation.
- `extraction.extract(document, signal)`: returns existing `PublicCitation[]` and
  `PublicClaimProposal[]` as `{citations, proposals}`. The companion extraction
  module's pure `extractPublicClaimFragments(document)` is structurally compatible.
  Its extra top-level extraction diagnostics are omitted by this planner.

For the companion extractor, the composition adapter is:

```ts
const planner = createDiscoveryPlanner({
  provider,
  documents: publicDocumentFetcher,
  extraction: {extract: async document => extractPublicClaimFragments(document)},
});
const collected = await planner.collect({request, authority}, signal);
```

The fragment IDs are document-local query provenance, **not staged proposal refs**.
After successful collection and fresh authorization, the private extraction
producer can produce its source-scoped staging envelope from `collected.documents`.
Use that producer's total proposal/citation caps and the facts staging validator;
do not combine these planner fragments directly into a staging envelope.

## Authorization and runtime preconditions

Only authenticated server composition may call this API. Validate session, scope,
graph version, enabled source policy, and explicit selection of each public context
before invocation. `authority` is a trusted server result, not client-supplied
authority. The planner checks matching scope/version/selected IDs and bounded
public terms; it cannot determine whether an arbitrary string was privately sourced.
Never supply a graph snapshot, Contacts names, raw import, credential or cookie.

Before disclosing or staging collection results, recheck session, scope, graph
version, source enablement/policy and the exact selected public contexts. On changed
authority discard results. Cancellation returns partial, unpersisted output and
accurate attempted counts; the runtime should discard it rather than stage it.
Deadline/provider failure also return partial output with an explicit stop reason;
any partial staging policy must be deliberate and preserve incomplete coverage.

Ports must honor AbortSignal and bound their own I/O. The planner races asynchronous
ports against the shared deadline, but JavaScript cannot forcibly terminate a
synchronous CPU-bound port or stop network work in a port that ignores cancellation.
No provider retries, authentication flows or network calls occur outside these ports.

## Queries and identity semantics

Initial queries quote both normalized social anchor URLs literally plus the target.
Slugs never become names. Exactly cited profile identity proposals can seed a quoted
profile URL plus target query, without authenticating profile ownership.

The current extractor instead supplies source-local `PUBLIC_DOCUMENT_MENTION`
occurrences. An unresolved occurrence can seed a query only when attached to a
`DIRECT_EXPLICIT` interpersonal proposal, with exact relationship and separate
identity quotations from the same document revision. Its query contains the quoted
mention, target, and complete quoted assertion as public context. Ordinary unresolved
identity/source-verification disclaimers are allowed; other extraction uncertainty
fails closed. Bare/common names, co-employment, affiliation-only claims, snippets,
unattributed names and ambiguous assertions do not seed this frontier.

Each candidate retains its occurrence identity, document/revision and citation IDs,
and is explicitly `EXPLORATORY_ONLY` / `UNRESOLVED`. Same names in separate occurrences
stay separate, even when identical query strings deduplicate. Search results never
inherit the candidate's identity. A query does not prove a user-to-person link, a
canonical identity, relationship truth or any introduction path. These decisions
remain with explicit facts/identity review and the graph engine.

The planner trusts the injected extractor's assertion semantics, while checking
bounded structure, pending/nontraversable state, citation references, exact offsets,
document revision and text digest. It is not a semantic model-output verifier or the
facts acceptance validator. Source text is always data, never an instruction.

## Budgets and deterministic order

Defaults are hard upper bounds: four attempted provider calls, eight retained unique
hits, five attempted documents, and 30 seconds for the entire collection including
extraction. Overrides can only decrease these limits. Attempts increment immediately
before calling a port, including synchronous failures and in-flight cancellations.
Robots/redirect HTTP requests are internal to the bounded fetcher; one document
attempt is not a claim that exactly one HTTP request occurred.

Two initial searches reserve two remaining calls for expansion. The initial stage
retains at most four hits, with space for both anchors, and attempts at most three
documents. The expansion stage may retain four more hits and gets the two remaining
document attempts first. Unused document capacity can then process retained initial
or explicitly selected URLs. The next frontier freezes after initial extraction;
there is no recursive crawl. Up to eight exploratory occurrences are retained.

Frontier ordering is deterministic by identifier/name/occurrence for identical port
outputs. Expansion queries run before selected public context/target-only fallbacks.
Overlong queries are skipped explicitly rather than truncating a discriminator.
Canonical queries normalize Unicode/whitespace but preserve case-sensitive URL text.
Canonical URLs normalize origin/default ports/fragments and social profile forms;
arbitrary query parameters and case-sensitive paths stay distinct. Known redirect
aliases are not refetched. Unknown redirect aliases can consume an attempted page
before the fetcher reveals their final destination.

All search-provider failures stop collection without retry. Existing search adapters
collapse denied/quota responses into `ACCESS_DENIED`, so the planner does not claim
it can distinguish a 403 from a 429. Individual blocked document/extraction failures
are recorded and may leave room for another bounded document attempt.

`UNREVIEWED_PUBLIC_EVIDENCE` means only that valid unreviewed proposals were returned.
`INSUFFICIENT_PUBLIC_EVIDENCE` means no such proposals were available. Neither status
asserts a supported route. `exhausted` conservatively reports limits reached or omitted
results, including hits omitted to reserve frontier capacity; it is not an optimality
claim. Queries/citations/documents in this output are private server-side collection
data and should not be copied into general logs or unauthenticated responses.

## Verification

Run `npm run build:server`, then
`node --test tests/discovery-planning.test.mjs tests/discovery-sources.test.mjs tests/discovery-tavily.test.mjs`.
All fixtures are anonymous and injected; no live search, credentials, personal
imports, database, graph writes or outreach is involved.
