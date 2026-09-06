# Orbit — persistent connection library

Private hosted app: https://orbit-network-mapper.doublejav.chatgpt.site

## Permanent library

Orbit merges people, connections, and source observations from multiple collections into a private Sites D1 database. Profile URLs deduplicate people, and unordered endpoint pairs deduplicate connections. Repeated imports are idempotent. Records are scoped to the authenticated Sites user; server-side queries and writes enforce that scope.

Open the hosted app to automatically sync the existing companion collection and future discoveries. The app sends bounded batches, reports unsaved errors, and retries. Keep the hosted page open for continuous sync. If it is closed, the companion keeps its collection checkpoint locally and the next hosted session can save it. Closing or clearing the local collection does not delete already-saved library records. Wait for “Saved to library” before clearing a collection. Imported Orbit JSON networks are also saved.

Find a saved person by the beginning of their name or their full LinkedIn profile URL. The library loads a bounded two-hop neighborhood without accessing LinkedIn. The current interface displays up to 1,000 people; the API supports up to 3,000, caps traversal work, and explicitly marks truncated samples. The database has no application-imposed 10,000-person lifetime limit. Unknown people remain unknown until data containing them is collected or imported; this is not a prepopulated global LinkedIn directory.

Production schema uses generated, versioned Drizzle migrations. Cloudflare D1 platform storage and execution limits still apply; one database is not an unlimited global graph. A substantially larger corpus may require partitioned storage or a separate graph backend. No million-node performance claim has been validated.

## Slower collection

Install companion **2.0.0** by replacing the files in the existing unpacked companion folder and clicking Reload on Orbit at `chrome://extensions`. Refresh the hosted page afterward. The stable extension ID preserves the collection checkpoint.

Collection uses **one tab** and a **two-minute minimum between LinkedIn navigations, pagination, and load-more requests**, with five- and ten-minute settings available. Existing parallel queues are folded into the single lane on migration. Timings are persisted across worker restarts. Profile openings are paced too; previous releases delayed only pagination in slower modes.

LinkedIn sign-in, verification, and restriction notices stop collection. No rate is represented as approved by LinkedIn or guaranteed to avoid restrictions. LinkedIn prohibits third-party automated scraping; resolve any account restriction before deciding whether to resume. Nothing starts a new crawl automatically on deployment. Library lookup requires no LinkedIn traffic.

Transient page errors retry at most twice. Wrong/missing connection owners are never ingested. Equivalent URL filter encodings are normalized, and changes to viewer-degree filters are recorded as adjusted coverage. Repeated page cycles and missing pagination are marked incomplete. Hidden and mutual-only lists remain distinct.

The graph animates arrivals independently of collection. Progress distinguishes new people, new links, and already-mapped people. Exploration depth remains fixed per collection. Export JSON and people/connection CSV remain available. Local collection checkpoints hold up to 10,000 people per run; the permanent library merges multiple runs.

## Development and validation

Requires Node.js 22+ and Python 3. Runtime Worker and browser code have no external application dependencies.

- `npm ci`
- `npm run check`
- `npm test` (includes SQLite-backed persistence, ownership, deduplication, evidence, and bounded-neighborhood tests)
- `npx drizzle-kit generate` after schema changes
- `npm run build`
- `npm run preview` serves the static UI; production API requires the hosted Sites Worker and D1 database.

Build packages the Chrome companion, assembles static assets, bundles a Cloudflare Worker with Vite and the Sites plugin, and stages generated migrations. No personal data or test fixtures are included in deployments. D1 is the authoritative library; browser storage is a resumable acquisition checkpoint.

Live collection reliability depends on LinkedIn’s current layout and available data. Tests simulate acquisition, migration, pacing, and graph rendering. Synthetic measurements are not real-world LinkedIn collection benchmarks.

## References

- https://www.linkedin.com/help/linkedin/answer/a1341387
- https://developers.cloudflare.com/d1/platform/limits/
- https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/connections-api
