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

The public-relationship acceptance module is present in source, but its HTTP composition and production citation policy are not enabled by this checkpoint. Do not invent an acceptance URL or submit public proposals to the manual-facts endpoint. Ben will supply the exact acceptance handoff after lifecycle integration and policy review.

Frontend verification can use the existing Node runner and injected fetch-compatible responses for request/retry/stale-state behavior. Anonymous fixtures remain in tests. Production UI must receive actual server responses and must not seed people, citations or paths. A browser check is still required against the integrated server.
