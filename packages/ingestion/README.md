# Ingestion adapters

`googleContactsNormalizer.ts` normalizes an already-authorized Google People
API contacts page into the shared `CandidateBatch` shape. It does not fetch,
authorize, persist, validate at the server boundary, or emit graph events.

The adapter preserves a directional `CONTACT_SAVED` observation from the
authorized owner to each unique contact resource. It never derives a
relationship, reverse edge, identity merge, or provider-verification claim.
Only supplied organization fields produce affiliations.

An otherwise usable contact without a name is retained with a deterministic,
opaque source handle. Candidate person IDs are stable for the same source
resource; evidence IDs are specific to the source observation time.

The normalizer returns redacted warning codes for malformed records. Its
self-contained test module contains anonymous structural data only and is not
application seed data. Ben should run it once the repository's TypeScript test
runner and runtime validators are selected.
