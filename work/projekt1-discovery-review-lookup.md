# Discovery review lookup handoff

Implemented the authenticated discovery-to-batch mapping read for the frontend.

## Response contract

`GET /api/discovery/review?scopeId=<scopeId>&discoveryId=<discoveryId>` returns:

```json
{
  "scopeId": "scope-id",
  "discoveryId": "discovery-id",
  "graphVersion": "current-version",
  "batches": [
    {
      "batchId": "public-facts-batch-id",
      "sourceId": "public-source-id",
      "proposalRefs": [{"id": "proposal-id", "revision": "proposal-revision"}]
    }
  ]
}
```

Only a receipt owned by the authenticated actor and scope can resolve. The receipt must have a complete durable workflow; unfinished workflows return `409 VERSION_CONFLICT`, and missing/foreign receipts return `403 FORBIDDEN`. Current source policy, document heads, proposal heads, enabled status and scope snapshot are rechecked transactionally. Raw documents, excerpts, private payload references and provider data never leave the endpoint. A completed workflow with no staged proposals returns `batches: []`.

Checks: server build passes. PostgreSQL tests are present in `tests/application-discovery.postgres.test.mjs` and require the anonymous `STORAGE_TEST_DATABASE_URL` / PG55439 test harness; this checkout had that variable unset, so those tests were skipped locally.
