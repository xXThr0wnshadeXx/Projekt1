# Discovery review client handoff

The discovery POST response keeps its original contract. Its proposal references are proposal IDs/revisions, not review batch IDs.

After a completed discovery response, call authenticated same-origin `GET /api/discovery/review?scopeId=<scopeId>&discoveryId=<discoveryId>`. The additive response is:

```ts
{
  scopeId: string;
  discoveryId: string;
  graphVersion: string; // current authorized version, not the discovery's original base
  batches: Array<{
    batchId: string;
    sourceId: string;
    proposalRefs: Array<{id: string; revision: string}>;
  }>;
}
```

Only completed receipts owned by the current actor and scope can be read. Incomplete/stale discoveries conflict; inaccessible or missing receipts are forbidden. A completed discovery without staged proposals returns an empty batch list. No raw document text, private payload references or provider calls are part of this lookup.

For each returned batch, call `GET /api/public-facts/review?scopeId=<scopeId>&batchId=<batchId>`. The existing `ReviewPublicFactsResponse` in `packages/server/public-facts/contracts.ts` contains current graphVersion, safe document metadata, citations, proposals, endpoints/current resolution decisions and warnings. Display exact citation text and source links alongside unresolved identity occurrences. Do not imply that a pending public assertion is a confirmed relationship or that a submitted profile URL authenticates account ownership.

Explicit identity resolution uses `POST /api/public-facts/resolve` with the existing `ResolvePublicIdentityRequest` union. Use the current graph version and exact endpoint/revision/latest-decision selector. Offer NEW_PERSON or selection of an existing person in the authorized scope; never silently join same-name people. After each write, refresh the review and graph before forming another decision. Preserve the exact payload/key only for retrying an uncertain identical request. Changed decisions use new keys and current selectors.

Cancel and discard responses on session/scope/input change. Treat 400 as input error, 401 as sign-in required, 403 as unavailable to this workspace, 409 as refresh/review required, and 502 as source/service unavailable. Do not silently retry provider discovery with a new key after a lookup failure.

Public relationship review is now mounted at authenticated, same-origin `POST /api/public-facts/confirm`. The exact exported request/response types are `PublicClaimReviewRequest` and `PublicClaimReviewResponse` in `packages/server/public-facts/acceptance-contracts.ts`. The server expects:

```ts
{
  scopeId: string;
  expectedGraphVersion: string;
  idempotencyKey: string;
  confirm: true;
  decisions: Array<{
    sourceId: string;
    proposalId: string;
    proposalRevision: string;
    decision: 'ACCEPT';
    includeInSearch: boolean;
    bindings: {
      subject: {endpointId: string; endpointRevision: string; resolutionDecisionId: string};
      object: {endpointId: string; endpointRevision: string; resolutionDecisionId: string};
    };
    relativeStrength?: number;
  } | {
    sourceId: string;
    proposalId: string;
    proposalRevision: string;
    decision: 'REJECT';
  }>;
}
```

Use 1–10 decisions with no duplicate proposal. Bind both endpoints to their current explicit resolution decisions from the latest review response. Show the exact relationship quote, source, subject → object direction, resolved identities and known/unknown dates before confirmation. Offer rejection, acceptance without search, or explicit search opt-in with a deliberate positive relative weight. Do not silently supply a weight. The policy determines its semantics; it never measures willingness or probability of a successful introduction. An accepted private opt-out creates no searchable edge.

The response provides current/base graph versions, review ID, duplicate flag, per-proposal decision IDs/state/relationshipId/searchable, graph events and warnings. Refresh graph and review after success. Preserve the exact payload/key for an uncertain retry; changed choices require current selectors and a new key. Display returned warnings with results. Do not send these proposals to `/api/facts/confirm`.

Production policy wiring is still a separate gate: without an explicit server policy, searchable acceptance returns a service-unavailable error with no writes; acceptance without search remains available. Do not interpret an HTTP endpoint or identity decision as proof that a route exists.

Frontend verification can use the existing Node runner and injected fetch-compatible responses for request/retry/stale-state behavior. Anonymous fixtures remain in tests. Production UI must receive actual server responses and must not seed people, citations or paths. A browser check is still required against the integrated server.
