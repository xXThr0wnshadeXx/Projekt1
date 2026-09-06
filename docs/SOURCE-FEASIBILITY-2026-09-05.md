# Real public-source two-hop feasibility — September 5, 2026

**GO for selected-source feasibility. NOT acceptance of the complete deployed or real-user flow.**

The application produced Scott Young → James Clear → Mark Heckmann using two actual retrieved public articles. No people or edges were preloaded. Both relationships began pending and nonsearchable. The extraction/planning code discovered James Clear; explicit identity resolution materialized him and linked the two reviewed source occurrences. Ordinary citation acceptance persisted both directed edges, and BackendService with the actual bounded route engine returned one two-hop path.

## Evidence and identity review

- Scott Young → James Clear: [Useful Mental Model: Exponential Growth](https://www.scotthyoung.com/blog/2019/07/10/exponential-growth/), source-declared publication July 10, 2019. Exact normalized citation: “My friend James Clear likes to argue that habits are the exponential growth of personal improvement .” Source-author metadata agrees on Scott Young. The paragraph links the habits statement directly to James Clear's Atomic Habits page, supporting the explicit cross-source James identity review.
- James Clear → Mark Heckmann: [Eisenhower Box](https://jamesclear.com/eisenhower-box), source-declared publication April 7, 2014. Exact normalized citation: “My friend Mark Heckmann is a fan of using the phrase for personal time management and I like it too.” Agreeing author metadata and visible byline identify James Clear. Mark is only the person named by this source; no external account, employer or same-name profile was attached.

Both sources support directed historical friendship assertions, not reciprocal edges, current contact or willingness to introduce. Article publication dates are not relationship dates. The source-declared author values remain labeled as unverified metadata until explicit review.

Retained normalization is `public-source-attributed-v2`, with author identity and relationship citations bound to exact document revisions and offsets:

- Scott document revision `f45f9fd54005b4477c570bc49f7da4d257361f2e20f248de7cee5b1d49d6b0c2`; relationship UTF-16 interval `[2513,2614)`.
- James document revision `2e5b839c01b46771fde8cf130b27688c05f26a66225588d66a3b08be6fb142dd`; relationship UTF-16 interval `[5579,5679)`.

Complete retained documents, database records and receipts remain private, outside Git. The citations above are short excerpts, not raw page publication.

## What ran

1. Protected PublicDocumentFetcher retrieved the public documents, including access/robots restrictions.
2. Actual extraction producer created pending proposals and exact source citations; canonical graph candidates were empty. Exploratory planner output included James Clear.
3. PublicFactsService staged both batches into a dedicated temporary PostgreSQL database on loopback55441, separate from the live owner database and anonymous unit-test database.
4. Explicit review created three public people and linked only the reviewed James occurrences. The technical harness account remained a separate fourth, disconnected owner; it does not claim Google login or represent a public persona.
5. PublicClaimReviewService accepted both relationships with Shreev's actual policy adapter and an isolated, explicit feasibility configuration: reviewer weight0.5, direct-support heuristic0.55, unknown-recency factor0.25. These factors are not probabilities or measured closeness. Production policy configuration remains a release gate.
6. BackendService selected the reviewed Scott person as an ephemeral search start, preserving the stored owner root. The actual route engine returned one two-hop path, score0.004348437500000001. That score is a relative policy assessment, not a success probability.
7. Default owner search returned no route; a foreign actor was forbidden. Rejecting the second relationship through the normal service removed the route. No graph SQL update or fabricated relationship was used.

## Exact remaining blockers

The feasibility harness supplied an explicitly selected reviewed-person target through GoalPort. The production natural-language goal resolver was also run and returned `NO_TARGETS`, because it currently resolves organizations only. Shreev owns the minimal reviewed-person target resolver and production policy configuration.

The documents were selected from public research leads, then processed by the application's real retrieval/extraction pipeline. This does not prove autonomous discovery from arbitrary profile URLs. The separate Tavily profile-query probe remains pending explicit payload approval after automatic review rejected it; this selected-document test did not execute or bypass those queries.

Nicolas's latest review/acceptance UI is published separately but not yet integrated or browser-verified with this source patch. The proof called real application services in a private harness, not the deployed HTTP/browser flow. No route from Ben's own network, current introduction opportunity, broad source coverage, or deployed acceptance is claimed.

The earlier Scott Young → Cal Newport → Eric Barker candidate remains unresolved at the Study Hacks author alias. It was not forced into the accepted graph.
