# Conservative public assertion extraction

This server-only module executes offline on the **exact** `RetrievedPublicDocument.normalizedText`. It requires no model account, key, network, contacts or database. It does not establish truth, verify a real-world identity, persist evidence, or create a graph edge.

## Executable coverage

`explicit-sentences-v2` retains the `public-source-text-v1` grammar for complete English sentences, terminated by a period, with two to four capitalized Unicode name tokens on each person endpoint. The supported predicates are:

- `is a friend of` → `FRIEND_OF` / `FRIEND`
- `is a close friend of` → `CLOSE_FRIEND_OF` / `CLOSE_FRIEND`
- `is the parent of` → `PARENT_OF` / `PARENT_OF`
- `is a coworker of` → `COWORKER_OF` / `COWORKER`
- `is a former coworker of` → `FORMER_COWORKER_OF` / `FORMER_COWORKER`
- `worked directly with` → `WORKED_DIRECTLY_WITH` / `UNKNOWN`. Direct collaboration does not establish common employment, closeness or that a relationship ended.
- `works at` / `worked at` followed by one to six capitalized organization tokens → an affiliation proposal only. Present-tense employment records the source's present-tense assertion (`current: true`), not independently verified current employment at search time. Past-tense employment has `current: null`, because it does not prove departure.

Dates on assertions are always `{start:null,end:null}` in this version. Date-bearing sentences are unsupported rather than silently dropping their dates. Valid source publication dates retain their supplied precision; publication/retrieval times never become relationship dates.

Sentence length is at most 500 UTF-16 units. Unsupported clauses, incomplete sentences, pronouns, single-token names, initials, lowercase names, co-mentions, follows, inferred shared-employer links and willingness statements produce no claim. A document containing recognized negation (including ordinary negative contractions with straight or typographic apostrophes), uncertainty, quotations, questions or fictional-context markers is conservatively withheld in full. This guard reads the original text without rewriting it. This abstention may suppress valid statements elsewhere on the same page. These lexical guards are not a general semantic verifier: source lies and linguistic context outside this small grammar still require review. `DIRECT_EXPLICIT` means the complete source sentence matches the explicit grammar, never that the claim is confirmed.

`public-source-attributed-v2` is a separate, narrow lane. It is available only when the fetcher has a unique HTML `meta[name=author]`, agreeing JSON-LD Article/BlogPosting author and URL/headline, and one non-comment article. Its exact normalized text retains the agreed source-declared author label and article headings, paragraphs, lists, and block quotes so a correction or denial is not discarded. Only direct, unquoted paragraph ranges are eligible relationship text; scripts, nested articles and comments are excluded. The sidecar records author/article/prose ranges and is marked `SOURCE_SUPPLIED_NOT_VERIFIED`.

That lane recognizes only `My friend Full Name ... .` as `AUTHORED_FIRST_PERSON_FRIEND_OF` / `FRIEND`. The author remains an unresolved source occurrence; an alias or name never authenticates, merges with, or replaces an account root. Its author identity citation binds the sidecar author range, its relationship citation binds the complete article sentence, and its object identity citation binds the name within that sentence. A later named retraction, guest/quotation conflict, or plausible first-person friend-term denial about the candidate suppresses the proposal. Unrelated negatives do not. The proposal is still pending, unsearchable, and requires identity and claim review.

## Public exports (`index.ts`)

`extractPublicDocument(document, maxAssertions = 10): DocumentExtraction` returns source occurrence mentions, assertions, exact `DocumentExcerpt`s and finite diagnostic codes. The configurable assertion bound is 1–16. Document text is bounded to 1 MiB and its SHA-256 digest is recomputed before extraction. All offsets refer to the unmodified UTF-16 input, including non-BMP characters.

`extractPublicClaimFragments(document, maxAssertions = 10): PublicClaimFragments` returns the exact existing `PublicCitation[]` and `PublicClaimProposal[]` types, plus `extraction` and `organizationMentions`. The planner may consume these as **public query hints only**, preserving occurrence IDs, revision and provenance. A later retrieved mention remains separate until explicit resolution. This pure port uses document-local IDs; its IDs must not be passed off as staged source-scoped IDs.

`createPublicExtractionProducer({authorize}).produce(credential, request, documents, signal?): Promise<PublicExtractionOutput>` creates the private stage input. `request` strictly contains `{scopeId,expectedGraphVersion,idempotencyKey}`. The caller must supply actual server-retrieved documents, never arbitrary browser document bodies. `authorize` is a trusted server port, receives snapshots of the request/documents, authenticates the opaque credential and supplies:

```ts
{
  context: SourceContext,
  graphVersion: string,
  source: { enabled: true, origin: 'PUBLIC_SOURCE', provider: 'PUBLIC_ARTICLE' | 'PUBLIC_PROFILE' },
  documents: [{ documentId, documentRevision, privatePayloadRef, kind, independenceGroup }]
}
```

The source must be enabled and authorized for the actual actor, with `sourcePolicyVersion: 'public-citation-review-v1'` and `sharingDecisionId: null`. Owner, scope, source, batch, policy and private references are supplied by this server callback, never by browser fields. Public articles/Wikimedia pages require a `PUBLIC_ARTICLE` source; profiles/Wikidata entities require `PUBLIC_PROFILE`. Mixed providers must be partitioned into separately authorized envelopes. Independence groups are authoritative grouping metadata, never inferred corroboration.

The callback runs twice, before extraction and before return, within a 10-second cancellation budget. Provisioning must be idempotent and return the same source/ref allocation for an operation. Changed authority/version fails closed. Stage must still reauthorize transactionally; a returned TypeScript object is not a durable permission token.

The result contains `status`, `persistence: 'NOT_PERSISTED'`, `stageRequest`, `extractions`, and `organizationMentions`. With unsupported-only input, status is `NO_SUPPORTED_ASSERTIONS` and `stageRequest` is null. Otherwise status is `READY_TO_STAGE`, and `stageRequest` is structurally the facts module's server-only `StagePublicFactsRequest`:

```ts
{ expectedGraphVersion, idempotencyKey, envelope: PublicSourceEnvelope,
  texts: [{ documentId, documentRevision, normalizedText }] }
```

The producer does not call `stage`. Only successful `PublicFactsService.stage` persists texts and the envelope atomically. Its returned batch ID/version are authoritative; do not report storage from the producer's status.

## Identity, provenance and graph invariants

Every person occurrence has a stable source-local `PUBLIC_DOCUMENT_MENTION` identity and exact name citation with role `IDENTITY`. This documents the source mention only. Its `SOURCE_PERSON_MENTION` proposal is `CONTEXT_ONLY`; the endpoint remains `UNRESOLVED`, `personId:null`, with no resolution decision. Two identical name strings, including across separate statements/documents, are distinct occurrences. Identical subject/object names within one interpersonal assertion cause abstention. No name or profile slug is converted into verified identity.

Interpersonal/affiliation statements have **separate** role-specific citations/evidence IDs. Endpoints reference the corresponding identity evidence IDs. All proposals remain `PENDING`, `includeInSearch:false`, with confidence `{value:null,meaning:'HEURISTIC_EVIDENCE_SUPPORT',policyVersion:null}`. Legacy normalized `Evidence.confidence` requires a number: `0` is an explicitly documented unassessed, nontraversable placeholder, not a calibrated assessment. Candidate people/relationships/observedLinks/affiliations and normalized facts stay empty. No reciprocal relationship or willingness is generated.

IDs are deterministic for exact document/version/locator/content and server scope. Changed content or document revisions produce new citation/evidence IDs; proposal revisions include the extractor version and payload. Source occurrence assignments must be reviewed again when their evidence changes. Source document metadata and exact source/fetched URLs are preserved. `originalSourceUrls` stays empty rather than inventing upstream provenance.

At most 5 documents, 1 MiB each, 50 proposals and 100 citations are returned. The producer reserves up to three proposals per assertion and reports `ASSERTION_LIMIT` when capacity is exhausted. It never truncates a supporting quote into a different assertion. `organizationMentions` maps the proposal's opaque organization reference to the exact quoted label and citation, but this extra output is **not durably stored by the current facts stage**. Organization resolution/materialization needs its own approved storage boundary before target use.

## Checks and integration gates

Run `npm run build:server` and `node --test tests/discovery-extraction.test.mjs tests/discovery-sources.test.mjs tests/discovery-tavily.test.mjs` (48 checks).

`node tests/discovery-extraction-planner.mjs /absolute/path/to/built/discovery/planning/index.js` checks the actual planner seam: four contracted denials and two uncontracted controls produce zero direct assertions/expansions; the positive control retains bounded exploration with exact citations and unresolved claims. Verified against planner commit `4b31e4f0796e14f0f2ad4b2dd0a998ac35aa8cd0`.

`node tests/discovery-extraction-stage.mjs /absolute/path/to/built/public-facts/validation.js` checks actual producer output against the independently built facts validator and rejects six invalid excerpt/offset/digest/identity-role/review/search mutations. It uses anonymous fixtures and no database. Verified against facts commit `e8bccea3b9c02f4b588929c7412b043f064509af`.

Known integration gates at that facts checkpoint: its text validator advertises 1 MiB but inherits an 8,192-character string limit; ordinary unchanged-content refetches change `retrievedAt` without changing retrieval revision, which conflicts with full-payload immutable document/evidence storage. Preserve real timestamps and immutable checks; the owners must freeze an authoritative cached-revision or separate observation-revision convention. Replaying the exact existing stage payload is distinct from a new fetch. These issues were reported to the facts owner and observer.

The existing source service is untouched and still declares extraction unimplemented; integration must wire these exports and the planner/facts services. Source provisioning, durable replay, explicit NEW_PERSON/LINK_EXISTING review, public-claim acceptance policy, graph projection, real provider coverage, live arbitrary-profile acceptance and supported multi-hop paths remain separate gates. No real-world coverage or end-to-end demo is established by these anonymous offline checks.
