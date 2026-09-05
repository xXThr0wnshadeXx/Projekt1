# Projekt1

AI-assisted relationship discovery: structure real relationship information, resolve identities through review, and find evidence-backed human introduction routes.

## Team start here

Deadline: **Sunday, September 6, 2026, 2 p.m. Pacific**.

1. Read [Command center](docs/COMMAND-CENTER.md).
2. Open your brief and copy its agent kickoff prompt:
   - [Nicolas — frontend and graph animation](docs/team/NICOLAS.md)
   - [Shaw — data retrieval](docs/team/SHAW.md)
   - [Shreev — graph search and identity](docs/team/SHREEV.md)
   - [Ben — backend and integration](docs/team/BEN.md)
3. Coordinate through the [architecture](docs/ARCHITECTURE.md), [wire contracts](contracts/index.ts), [source access report](docs/SOURCE-ACCESS.md) and [task board](docs/BACKLOG.md).

This handoff contains plans and TypeScript contracts, not a runnable application. Nicolas and Shaw's ongoing local work must be inventoried and preserved. The earlier local fictional prototype is not the shared baseline.

Product and demo use **real supported data only**. No filler people, invented relationships or silent fuzzy identity merges. This repository is public: never commit contacts, exports, secrets or raw personal evidence. Follow [AGENTS.md](AGENTS.md).

## Frontend starter

`apps/web` has not been selected yet, so the initial frontend lives at the repository root until the team locks its application layout. It is a Vite/React landing and account-entry experience:

- Email account entry and Google sign-in are behind [`src/auth.ts`](src/auth.ts), an intentionally small `AuthGateway` boundary.
- The default implementation saves only a development session in browser storage. It stores no password, OAuth token, contact, job post, or graph data.
- Replace `createAuthGateway()` with a server-backed implementation once the backend owns authenticated sessions and OAuth callbacks. Keep Google OAuth server-initiated; do not put provider credentials in the browser.

Once Node.js is installed, run `npm install` and `npm run dev`. This starter deliberately has no sample people or graph paths: the graph UI must consume authorized, real server data per the project policy.

License: existing GNU GPL v3; see [LICENSE](LICENSE).
